/**
 * Streamkulcs — létrehozás, szabályok és hash-elt tárolás (1.0.010).
 *
 * Eddig a streamkulcs a `.env`-ben állt, nyers szövegként, és ugyanaz az érték
 * szerepelt a MediaMTX konfigurációjában is. Mostantól a webes felületen
 * hozható létre, és a szerver **kizárólag a scrypt hash-ét tárolja** —
 * pontosan úgy, ahogy az admin jelszót.
 *
 * MIÉRT MŰKÖDIK EZ EGYÁLTALÁN, ha a MediaMTX-nek is hitelesítenie kell:
 * a MediaMTX nem a saját felhasználólistájából dolgozik, hanem HTTP-n kérdez
 * vissza a vezérlő szerverre (`authMethod: http`), az pedig a hash ellen
 * ellenőriz. Így a nyers kulcs SEHOL nem marad a lemezen — sem a
 * `mediamtx.yml`-ben, sem nálunk. Lásd docs/SECURITY.md 3. fejezet.
 *
 * Amit szándékosan NEM tárolunk: semmilyen ujjlenyomatot vagy „emlékeztetőt" a
 * kulcsból. Egy gyors hash (sha256) a fájl mellett kioltaná a scrypt lassúságát
 * — épp azt a védelmet, amiért a scryptet választottuk.
 */

import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { constantTimeEquals, hashPassword, verifyPassword } from './passwords.js';

/** A kulcsra vonatkozó követelmények. A felület ugyanezt a listát jeleníti meg. */
export const KEY_POLICY = Object.freeze({
  minLength: 16,
  maxLength: 128,
  /** Ebből a készletből generálunk, és ezt fogadjuk el speciális karakterként. */
  specials: '!@#$%^&*()-_=+[]{}:;,.?/~',
});

const RULES = [
  {
    id: 'hossz',
    label: `legalább ${KEY_POLICY.minLength} karakter`,
    test: (value) => value.length >= KEY_POLICY.minLength,
  },
  { id: 'kisbetu', label: 'kisbetű (a–z)', test: (value) => /[a-z]/.test(value) },
  { id: 'nagybetu', label: 'nagybetű (A–Z)', test: (value) => /[A-Z]/.test(value) },
  { id: 'szam', label: 'számjegy (0–9)', test: (value) => /[0-9]/.test(value) },
  {
    id: 'specialis',
    label: `speciális karakter (${KEY_POLICY.specials.slice(0, 8)}…)`,
    test: (value) => new RegExp(`[${escapeForClass(KEY_POLICY.specials)}]`).test(value),
  },
];

/** A követelmények listája a felületnek (érték nélkül). */
export const keyRules = () => RULES.map(({ id, label }) => ({ id, label }));

function escapeForClass(text) {
  return text.replace(/[\\\]^-]/g, (character) => `\\${character}`);
}

/**
 * Egy jelölt kulcs ellenőrzése.
 *
 * @returns {{ok: boolean, checks: Array<{id, label, ok}>, error?: string}}
 */
export function assessStreamKey(value) {
  const key = String(value ?? '');
  const checks = RULES.map((rule) => ({ id: rule.id, label: rule.label, ok: rule.test(key) }));

  if (key.length > KEY_POLICY.maxLength) {
    return {
      ok: false,
      checks,
      error: `A kulcs legfeljebb ${KEY_POLICY.maxLength} karakter lehet.`,
    };
  }
  if (/\s/.test(key)) {
    return {
      ok: false,
      checks,
      error: 'A kulcs nem tartalmazhat szóközt vagy sortörést (HTTP fejlécben utazik).',
    };
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    ok: failed.length === 0,
    checks,
    ...(failed.length ? { error: `Hiányzik: ${failed.map((c) => c.label).join(', ')}.` } : {}),
  };
}

/**
 * Véletlen kulcs, ami GARANTÁLTAN megfelel a szabályoknak.
 *
 * Nem base64url: abban véletlenszerűen lehet, hogy nincs speciális karakter.
 * Ezért mind a négy karakterosztályból kötelezően teszünk bele egyet, a többit
 * a teljes készletből húzzuk, végül megkeverjük — így a szabályok teljesülése
 * nem a szerencsén múlik.
 */
export function generateStreamKey(length = 32) {
  const size = Math.min(KEY_POLICY.maxLength, Math.max(KEY_POLICY.minLength, length));

  const sets = [
    'abcdefghijkmnopqrstuvwxyz',      // kihagyva: l (1-gyel téveszthető)
    'ABCDEFGHJKLMNPQRSTUVWXYZ',       // kihagyva: I, O
    '23456789',                       // kihagyva: 0, 1
    KEY_POLICY.specials,
  ];
  const all = sets.join('');

  const characters = sets.map((set) => set[randomInt(set.length)]);
  while (characters.length < size) characters.push(all[randomInt(all.length)]);

  // Fisher–Yates, kriptográfiai véletlennel — hogy a kötelező karakterek ne
  // mindig az első négy helyen álljanak.
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j], characters[i]];
  }
  return characters.join('');
}

/**
 * A streamkulcs tára.
 *
 * A fájlban csak a hash van. A `.env`-ben megadott `ONLIVE_STREAM_KEY` továbbra
 * is működik (visszafelé kompatibilitás), de ha a felületen létrehoznak egy
 * kulcsot, az élvez elsőbbséget.
 */
export class StreamKeyStore {
  constructor({ dataDir, logger, fallbackKey = '' } = {}) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.filePath = dataDir ? path.join(dataDir, 'stream-key.json') : null;
    this.fallbackKey = String(fallbackKey ?? '');
    this.data = null;

    /**
     * A legutóbb sikeresen ellenőrzött kulcs — CSAK a memóriában.
     *
     * A scrypt szándékosan lassú (~100 ms). A telefon 3 másodpercenként küld
     * telemetriát, a MediaMTX pedig minden kapcsolatnál kérdez: enélkül a
     * hitelesítés adná a szerver terhelésének javát. A gyorsítótár nem gyengíti
     * a tárolást — lemezre továbbra is csak a hash kerül.
     */
    this.verified = null;
    /** Mikor írtunk utoljára használat-időbélyeget (nem minden kérésnél). */
    this.lastWriteAt = 0;

    this.ready = this.#load();
  }

  async #load() {
    if (!this.filePath) return;
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });

    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (typeof parsed?.hash === 'string' && parsed.hash) this.data = parsed;
    } catch {
      // Még nincs kulcs a felületről — marad a `.env` tartalék.
    }
  }

  async #save() {
    if (!this.filePath) return;
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  /** Van-e egyáltalán érvényes kulcs, és honnan jön. */
  get source() {
    if (this.data?.hash) return 'felulet';
    if (this.fallbackKey) return 'env';
    return 'nincs';
  }

  get configured() {
    return this.source !== 'nincs';
  }

  /** Állapot a felületnek — a kulcs értéke SOSEM szerepel benne. */
  status() {
    return {
      configured: this.configured,
      source: this.source,
      createdAt: this.data?.createdAt ?? null,
      createdBy: this.data?.createdBy ?? null,
      lastUsedAt: this.data?.lastUsedAt ?? null,
      rotations: this.data?.rotations ?? 0,
      /** Generált vagy kézzel megadott. */
      origin: this.data?.origin ?? null,
      policy: { minLength: KEY_POLICY.minLength, rules: keyRules() },
      /**
       * Ha a `.env`-ből jön, a szabályok nem kényszeríthetők visszamenőleg —
       * a felület ezért javasolja a cserét.
       */
      legacy: this.source === 'env',
    };
  }

  /**
   * Új kulcs beállítása. A nyers értéket a hívó adja tovább a felhasználónak;
   * mi csak a hash-t tesszük el.
   *
   * @param {string} rawKey
   * @param {{by?: string, origin?: 'generalt'|'kezi'}} [meta]
   */
  async set(rawKey, { by, origin = 'kezi' } = {}) {
    await this.ready;

    const assessment = assessStreamKey(rawKey);
    if (!assessment.ok) {
      const error = new Error(assessment.error ?? 'A kulcs nem felel meg a követelményeknek.');
      error.checks = assessment.checks;
      throw error;
    }

    const now = new Date().toISOString();
    this.data = {
      hash: hashPassword(rawKey),
      createdAt: now,
      createdBy: by ?? null,
      origin,
      rotations: (this.data?.rotations ?? 0) + 1,
      lastUsedAt: null,
    };
    this.verified = null; // a régi kulcs azonnal érvénytelen
    await this.#save();

    return this.status();
  }

  /** A kulcs visszavonása — utána csak a `.env` tartalék marad (ha van). */
  async clear() {
    await this.ready;
    this.data = null;
    this.verified = null;
    if (this.filePath && existsSync(this.filePath)) {
      await writeFile(this.filePath, JSON.stringify({ clearedAt: new Date().toISOString() }, null, 2), 'utf8');
    }
    return this.status();
  }

  /**
   * Ellenőrzés. Ez fut a telefon minden kérésénél és a MediaMTX minden
   * hitelesítési kérdésénél.
   */
  verify(candidate) {
    const value = String(candidate ?? '');
    if (!value) return false;

    if (this.verified && constantTimeEquals(value, this.verified)) return true;

    if (this.data?.hash) {
      if (!verifyPassword(value, { hash: this.data.hash })) return false;
      this.verified = value;
      return true;
    }

    if (this.fallbackKey && constantTimeEquals(value, this.fallbackKey)) {
      this.verified = value;
      return true;
    }
    return false;
  }

  /** Sikeres használat rögzítése — a felület ebből mutatja, él-e a kulcs. */
  markUsed() {
    if (!this.data) return;
    const now = Date.now();
    // Percenként legfeljebb egyszer írunk lemezre: a telefon 3 másodpercenként
    // jelentkezik, abból nem csinálunk fájlműveletet.
    if (this.lastWriteAt && now - this.lastWriteAt < 60_000) return;
    this.lastWriteAt = now;
    this.data.lastUsedAt = new Date(now).toISOString();
    this.#save().catch((error) => this.logger?.warn(`A streamkulcs mentése sikertelen: ${error.message}`));
  }
}
