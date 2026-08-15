/**
 * Média-tár (5. szegmens).
 *
 * Három „slot" van, pontosan annyi, amennyit az állapotgép képernyői igényelnek:
 *
 *   intro        → a `intro` állapot („Hamarosan kezdünk")
 *   interrupted  → a `reconnecting` ÉS a `paused` állapot („Megszakadt")
 *   outro        → az `outro` állapot
 *
 * Tárolás helyben, külső adatbázis nélkül: a fájlok a `data/media/`
 * könyvtárban, a metaadatok egyetlen `media.json`-ban. Slotonként egy aktív
 * fájl van; feltöltéskor a régi törlődik.
 *
 * A fájlnév tartalmaz egy tartalom-hasht, így ha valaki ugyanazt a nevet tölti
 * fel más tartalommal, a böngésző és az OBS biztosan új fájlt lát.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SLOTS = Object.freeze(['intro', 'interrupted', 'outro']);

const DEFAULT_OPTIONS = Object.freeze({
  /** `cover`: kitölti a képet (levág), `contain`: teljesen belefér (letterbox). */
  fit: 'cover',
  /** Videónál: ismételje-e. Az introt és a megszakadt képernyőt igen. */
  loop: true,
  /**
   * Némítás. Alapból `true`, mert a böngészők csak némán engedik az
   * automatikus lejátszást. Az OBS Browser Source-ban hanggal is működik,
   * ezért ott ki lehet kapcsolni.
   */
  muted: true,
});

/**
 * Slot-specifikus eltérések. Az outro alapból NEM ismétlődik: egy búcsúvideó
 * egyszer megy le, utána a szerver úgyis `ended`-be lép. Az intro és a
 * „megszakadt" viszont ismétlődik, mert nem tudjuk, meddig kell kitöltenie.
 */
const SLOT_DEFAULTS = Object.freeze({
  intro: { loop: true },
  interrupted: { loop: true },
  outro: { loop: false },
});

const defaultOptionsFor = (slot) => ({ ...DEFAULT_OPTIONS, ...(SLOT_DEFAULTS[slot] ?? {}) });

const DEFAULT_SETTINGS = Object.freeze({
  /** Az outro hossza másodpercben — ennek lejártakor lép `ended`-be a gép. */
  outroDurationSeconds: 15,
});

export class MediaStore {
  /**
   * @param {number} [defaultOutroSeconds] az outro KEZDŐ hossza, ha még nem
   *   állította senki az admin felületen. Az `ONLIVE_OUTRO_DURATION_MS`
   *   környezeti változóból jön — enélkül a dokumentált beállításnak nem
   *   lenne hatása, mert az outro hosszát mindig innen kéri a controller.
   */
  constructor({ dataDir, logger, defaultOutroSeconds }) {
    this.logger = logger;
    this.mediaDir = path.join(dataDir, 'media');
    this.metaPath = path.join(dataDir, 'media.json');

    const settings = { ...DEFAULT_SETTINGS };
    if (Number.isFinite(defaultOutroSeconds) && defaultOutroSeconds >= 1) {
      settings.outroDurationSeconds = Math.round(defaultOutroSeconds);
    }
    this.data = { slots: { intro: null, interrupted: null, outro: null }, settings };
    this.ready = this.#load();
  }

  async #load() {
    if (!existsSync(this.mediaDir)) await mkdir(this.mediaDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.metaPath, 'utf8'));
      this.data = {
        slots: { intro: null, interrupted: null, outro: null, ...(parsed.slots ?? {}) },
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      };
    } catch {
      // Első indítás: marad az alapértelmezés.
    }
    await this.#pruneOrphans();
  }

  /** Feltöltés közben megszakadt vagy elárvult fájlok takarítása. */
  async #pruneOrphans() {
    try {
      const used = new Set(
        SLOTS.map((slot) => this.data.slots[slot]?.file).filter(Boolean),
      );
      for (const name of await readdir(this.mediaDir)) {
        if (!used.has(name)) {
          await rm(path.join(this.mediaDir, name), { force: true });
          this.logger?.info(`Elárvult médiafájl törölve: ${name}`);
        }
      }
    } catch (error) {
      this.logger?.warn(`Médiatár takarítás sikertelen: ${error.message}`);
    }
  }

  async #save() {
    const temp = `${this.metaPath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.metaPath);
  }

  // -------------------------------------------------------------------------
  // Lekérdezés
  // -------------------------------------------------------------------------

  get settings() {
    return { ...this.data.settings };
  }

  /** Az outro hossza ezredmásodpercben — ezt kéri le az állapotgép controllere. */
  outroDurationMs() {
    return Math.max(1, this.data.settings.outroDurationSeconds) * 1000;
  }

  slot(name) {
    return this.data.slots[name] ? { ...this.data.slots[name] } : null;
  }

  filePath(name) {
    const entry = this.data.slots[name];
    return entry ? path.join(this.mediaDir, entry.file) : null;
  }

  /**
   * A `/live` oldalnak és az adminnak szánt leírás: mit kell megjeleníteni.
   * A tényleges fájl mindig a `/media/<slot>` URL-en érhető el.
   */
  manifest() {
    const slots = {};
    for (const name of SLOTS) {
      const entry = this.data.slots[name];
      slots[name] = entry
        ? {
            kind: entry.kind,
            mime: entry.mime,
            url: `/media/${name}?v=${entry.version}`,
            originalName: entry.originalName,
            size: entry.size,
            uploadedAt: entry.uploadedAt,
            options: { ...defaultOptionsFor(name), ...(entry.options ?? {}) },
          }
        : null;
    }
    return { slots, settings: this.settings };
  }

  // -------------------------------------------------------------------------
  // Módosítás
  // -------------------------------------------------------------------------

  /**
   * Új fájl beállítása egy slotra. A hívó felelőssége a validálás
   * (`media/validate.js`) — ide már csak ellenőrzött tartalom jut el.
   */
  async setSlot(name, { buffer, mime, kind, ext, originalName }) {
    if (!SLOTS.includes(name)) throw new Error(`Ismeretlen slot: ${name}`);
    await this.ready;

    const version = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const fileName = `${name}-${version}${ext}`;
    const target = path.join(this.mediaDir, fileName);

    // Előbb az új fájl, csak utána a metaadat — ha az írás félbeszakad,
    // a régi beállítás érvényben marad.
    const temp = `${target}.tmp`;
    await writeFile(temp, buffer);
    await rename(temp, target);

    const previous = this.data.slots[name];
    this.data.slots[name] = {
      file: fileName,
      version,
      kind,
      mime,
      size: buffer.length,
      originalName: originalName ?? fileName,
      uploadedAt: new Date().toISOString(),
      options: { ...defaultOptionsFor(name), ...(previous?.options ?? {}) },
    };
    await this.#save();

    if (previous && previous.file !== fileName) {
      await rm(path.join(this.mediaDir, previous.file), { force: true });
    }

    this.logger?.ok(
      `Média feltöltve: ${name} — ${originalName} (${kind}, ${Math.round(buffer.length / 1024)} kB)`,
    );
    return this.manifest().slots[name];
  }

  async clearSlot(name) {
    if (!SLOTS.includes(name)) throw new Error(`Ismeretlen slot: ${name}`);
    await this.ready;

    const previous = this.data.slots[name];
    this.data.slots[name] = null;
    await this.#save();

    if (previous) {
      await rm(path.join(this.mediaDir, previous.file), { force: true });
      this.logger?.info(`Média törölve: ${name}`);
    }
    return null;
  }

  async setSlotOptions(name, options) {
    if (!SLOTS.includes(name)) throw new Error(`Ismeretlen slot: ${name}`);
    await this.ready;
    if (!this.data.slots[name]) throw new Error(`Nincs feltöltött média ehhez: ${name}`);

    const current = this.data.slots[name].options ?? defaultOptionsFor(name);
    const next = { ...current };

    if (options.fit === 'cover' || options.fit === 'contain') next.fit = options.fit;
    if (typeof options.loop === 'boolean') next.loop = options.loop;
    if (typeof options.muted === 'boolean') next.muted = options.muted;

    this.data.slots[name].options = next;
    await this.#save();
    return this.manifest().slots[name];
  }

  /** Az outro hossza másodpercben (1–600). */
  async setOutroDuration(seconds) {
    await this.ready;
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 1 || value > 600) {
      throw new Error('Az outro hossza 1 és 600 másodperc között lehet.');
    }
    this.data.settings.outroDurationSeconds = Math.round(value);
    await this.#save();
    this.logger?.info(`Outro hossza: ${this.data.settings.outroDurationSeconds} másodperc.`);
    return this.settings;
  }
}
