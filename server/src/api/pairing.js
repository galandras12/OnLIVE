/**
 * Párosítás: a szerver adja át a beállításokat a telefonnak (1.0.110).
 *
 * MIÉRT: eddig minden címet, a stream útvonalat és a kulcsot **kézzel** kellett
 * begépelni a telefonon. Az elmúlt kiadások hibái sorra ebből jöttek — egy
 * `/admin` végződés, egy bennfelejtett `/ingest`, egy elgépelt kulcs. Egyik sem
 * hibaüzenetet adott, hanem néma nem-működést.
 *
 * A megoldáshoz NEM kell felhő, fiók vagy OAuth. A szerver már tudja az összes
 * helyes értéket; elég egyszer átadnia:
 *
 *   1. **Mély hivatkozás** — az admin oldalt a telefonon megnyitva egy koppintás
 *      (`onlive://pair?...`), az app pedig letölti a csomagot a tokennel.
 *   2. **Fájl** — a böngésző lement egy `onlive-pairing.json`-t, amit a telefon
 *      beolvas. Hálózat sem kell hozzá.
 *
 * BIZTONSÁG. A csomag tartalmazza a **nyers streamkulcsot** — ez az egyetlen
 * hely, ahol az valaha elhagyja a szervert (ugyanaz a szabály, mint a
 * létrehozásnál: egyszer látszik, utána már csak a hash létezik). Ezért:
 *
 *   - a párosítás **új kulcsot generál**, és a régit érvényteleníti — a régi
 *     kulcsot amúgy sem tudnánk visszaadni, hiszen csak a hash-e van meg;
 *   - a token **egyszer használható** és rövid ideig él;
 *   - a csomag **soha nem kerül lemezre** a szerveren, csak a memóriában él a
 *     lejáratáig;
 *   - a `GET /api/pair/:token` a szokásos IP-alapú korlátozás alatt fut, hogy a
 *     tokent ne lehessen próbálgatni.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';

import { generateStreamKey } from '../security/stream-key.js';
import { localEndpoints } from '../settings/local-address.js';
import { LogEvent, Source, clientId } from '../log/logger.js';

/** Meddig él egy párosítás. Elég egy telefon elővételéhez, nem több. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Egyszer használatos párosítások — kizárólag a memóriában.
 *
 * Nem `Map`-nél nagyobb szerkezet: egyszerre jellemzően egy párosítás él, és
 * a lejárt elemeket minden művelet előtt kitakarítjuk.
 */
export class PairingStore {
  constructor({ ttlMs = PAIRING_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.items = new Map();
  }

  #sweep() {
    const cutoff = this.now();
    for (const [token, item] of this.items) {
      if (item.expiresAt <= cutoff) this.items.delete(token);
    }
  }

  create(payload) {
    this.#sweep();
    const token = randomUUID().replace(/-/g, '');
    const expiresAt = this.now() + this.ttlMs;
    this.items.set(token, { payload, expiresAt });
    return { token, expiresAt };
  }

  /** Kiolvasás — EGYSZER. A második hívás már nem talál semmit. */
  take(token) {
    this.#sweep();
    const item = this.items.get(String(token ?? ''));
    if (!item) return null;
    this.items.delete(token);
    return item.payload;
  }

  get size() {
    this.#sweep();
    return this.items.size;
  }
}

/**
 * A csomag összeállítása a szerver saját, ELLENŐRZÖTT értékeiből.
 *
 * Itt nincs felhasználói gépelés, tehát nincs mit elrontani: a címek a
 * konfigurációból és a gép hálózati interfészeiből jönnek.
 */
export function buildPairingPayload({ config, streamKey, addresses }) {
  const local = addresses ?? localEndpoints({
    port: config.port,
    whipPort: config.ingest.whepPort,
  });

  return {
    onlive: 'pairing',
    version: 1,
    createdAt: new Date().toISOString(),
    server: {
      control: config.publicUrls.admin,
      live: config.publicUrls.live,
      ingest: config.publicUrls.ingest,
      localControl: local.suggested?.control ?? '',
      localIngest: local.suggested?.ingest ?? '',
    },
    streamPath: config.ingest.path,
    ingestUser: config.ingest.user,
    streamKey,
    turn: {
      url: config.turn?.url ?? '',
      username: config.turn?.username ?? '',
      credential: config.turn?.credential ?? '',
    },
  };
}

export function createPairingRoutes({ config, streamKeys, pairings, limiter, adminGuard, logger }) {
  const router = Router();
  const admin = Router();
  admin.use(adminGuard);

  /**
   * Új párosítás. A válasz TARTALMAZZA a csomagot, mert a böngésző abból
   * készíti a letölthető fájlt — így nem kell külön végpont, és nem is
   * generálódik kétszer kulcs.
   */
  admin.post('/', async (req, res) => {
    await streamKeys.ready;

    // Új kulcs: a régit nem tudnánk átadni, mert csak a hash-e létezik.
    const streamKey = generateStreamKey(32);
    await streamKeys.set(streamKey, { by: clientId(req), origin: 'generalt' });

    const payload = buildPairingPayload({ config, streamKey });
    const { token, expiresAt } = pairings.create(payload);

    logger.event({
      type: LogEvent.SETTINGS,
      level: 'ok',
      source: Source.WEB,
      client: clientId(req),
      area: 'parositas',
      // A kulcs és a token SOHA nem kerül a naplóba.
      message: 'Párosítás indítva — új streamkulcs, egyszer használatos token.',
    });

    res.json({
      ok: true,
      token,
      expiresAt,
      ttlMs: pairings.ttlMs,
      payload,
      /** Ezt nyitja meg a telefon, ha az admin oldalt ott nézed. */
      deepLink: `onlive://pair?token=${token}&server=${encodeURIComponent(config.publicUrls.admin)}`,
      /** Ugyanaz helyi úton — ha a telefon a LAN-on/Tailscale-en van. */
      localDeepLink: payload.server.localControl
        ? `onlive://pair?token=${token}&server=${encodeURIComponent(payload.server.localControl)}`
        : null,
    });
  });

  router.use('/api/admin/pairing', admin);

  /**
   * A telefon lekéri a csomagot. A token MAGA a hitelesítés — ezért egyszer
   * használható, rövid életű, és a próbálgatást az IP-korlát fogja meg.
   */
  router.get('/api/pair/:token', (req, res) => {
    const key = `pair:${req.ip}`;
    const state = limiter?.check(key);
    if (state && !state.allowed) {
      res.setHeader('Retry-After', Math.ceil(state.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Túl sok próbálkozás.' });
    }

    const payload = pairings.take(req.params.token);
    if (!payload) {
      limiter?.fail(key);
      logger.warn(`Ismeretlen vagy lejárt párosító token innen: ${req.ip}`);
      return res.status(404).json({
        error: 'A párosítás lejárt vagy már felhasználták. Indíts újat az admin felületen.',
      });
    }

    limiter?.succeed(key);
    logger.info('Párosító csomag átadva a telefonnak.');
    res.json(payload);
  });

  return router;
}
