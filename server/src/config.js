/**
 * OnLIVE — konfiguráció.
 *
 * Forrás: környezeti változók (a repó gyökerében lévő `.env`-ből, amit a
 * `node --env-file=../.env` tölt be — nem kell dotenv függőség).
 * Minden értéknek van értelmes alapértelmezése, hogy a szerver `.env` nélkül
 * is elinduljon fejlesztéskor.
 */

const num = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'igen'].includes(String(value).toLowerCase());
};

export const config = {
  port: num(process.env.ONLIVE_SERVER_PORT, 3000),

  /** A telefon és az admin felület hitelesítése (teljes körűen: 10. szegmens). */
  streamKey: process.env.ONLIVE_STREAM_KEY ?? '',
  adminPassword: process.env.ONLIVE_ADMIN_PASSWORD ?? '',
  hookSecret: process.env.ONLIVE_HOOK_SECRET ?? '',

  /**
   * A `/live` oldal és a lejátszás-proxy védelme (6. szegmens).
   *
   * Üresen hagyva a `/live` NYILVÁNOS — ez a kényelmes alapértelmezés, mert
   * az OBS Browser Source-ba így elég a puszta URL. Ha megadod, minden
   * lejátszási kérésnek vinnie kell (`?token=…`), és a Socket.io kapcsolat
   * is ezt kéri.
   */
  liveToken: process.env.ONLIVE_LIVE_TOKEN ?? '',

  /** Media ingest (3. szegmens). */
  ingest: {
    apiBase: process.env.ONLIVE_MEDIAMTX_API ?? 'http://127.0.0.1:9997',
    path: process.env.ONLIVE_STREAM_PATH ?? 'onlive',
    /** WHEP (WebRTC olvasás) — a lejátszás-proxy célja. */
    whepPort: num(process.env.ONLIVE_MEDIAMTX_WHIP_PORT, 8889),
    /** HLS — tartalék lejátszási útvonal. */
    hlsPort: num(process.env.ONLIVE_MEDIAMTX_HLS_PORT, 8888),
    pollMs: num(process.env.ONLIVE_INGEST_POLL_MS, 1000),
    /**
     * Ennyi ideig tartó folyamatos „nincs adat" után jelentünk megszakadást.
     * Kiszűri a pillanatnyi hálózati zökkenőket, hogy ne villogjon a
     * `/live` oldal.
     */
    interruptAfterMs: num(process.env.ONLIVE_INGEST_INTERRUPT_AFTER_MS, 3000),
  },

  /** Állapotgép (4. szegmens). */
  machine: {
    /**
     * A 2 perces küszöb. KIZÁRÓLAG az `intro` vs. `reconnecting` döntést
     * befolyásolja — semmi mást.
     */
    liveThresholdMs: num(process.env.ONLIVE_LIVE_THRESHOLD_MS, 2 * 60 * 1000),
    /** Meddig tart az outro, mielőtt `ended` állapotba lépnénk. */
    outroDurationMs: num(process.env.ONLIVE_OUTRO_DURATION_MS, 15_000),
    /** Minden indítás játssza-e az intro médiát, vagy csak a boot utáni első. */
    introOnEveryStart: bool(process.env.ONLIVE_INTRO_ON_EVERY_START, true),
    /**
     * `ended` állapotban leálljon-e maga a szerver folyamat.
     *
     * Alapértelmezés: NEM. A specifikáció szerint az `ended` a „szerver és
     * stream teljes leállítása", de ha a Node folyamat kilép, elérhetetlenné
     * válik az admin felület is, és kézzel kellene visszakapcsolni a gépnél —
     * ráadásul az 1. szegmens tunnel-watchdogja hibának látná. Ezért az
     * `ended` alapból az ADÁST zárja le teljesen (stream elengedve, `/live`
     * üres), a vezérlő felület pedig elérhető marad.
     */
    shutdownOnEnded: bool(process.env.ONLIVE_SHUTDOWN_ON_ENDED, false),
  },

  /** Fájl-alapú tárolás (a 9. szegmens naplója is innen fog építkezni). */
  dataDir: process.env.ONLIVE_DATA_DIR ?? new URL('../data/', import.meta.url).pathname,

  publicUrls: {
    admin: process.env.ONLIVE_PUBLIC_ADMIN_URL ?? 'https://admin.galandras.com',
    live: process.env.ONLIVE_PUBLIC_LIVE_URL ?? 'https://live.galandras.com',
    ingest: process.env.ONLIVE_PUBLIC_INGEST_URL ?? 'https://ingest.galandras.com',
  },
};
