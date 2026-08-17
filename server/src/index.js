/**
 * OnLIVE vezérlő szerver — belépési pont (4. szegmens).
 *
 * Itt csak összekötés van, logika nincs:
 *   MediaMTX ──poll──> IngestMonitor ──> SessionController ──> Socket.io
 *   telefon  ──HTTP──> /api/session/*  ─────────┘                 │
 *   admin UI ──HTTP──> /api/admin/*    ─────────┘                 ▼
 *                                                    /live oldal + admin UI
 */

import express from 'express';
import { createServer } from 'node:http';

import { config } from './config.js';
import { logger } from './util/logger.js';
import { LogEvent } from './log/logger.js';
import { Store } from './state/store.js';
import { SessionController } from './state/controller.js';
import { IngestMonitor } from './ingest/monitor.js';
import { IngestControl } from './ingest/control.js';
import { MediaStore } from './media/store.js';
import { OverlayStore } from './overlay/store.js';
import { DeviceCommandQueue } from './device/commands.js';
import { MetricsRecorder } from './log/metrics.js';
import { LinkStore } from './links/store.js';
import { createRoutes } from './api/routes.js';
import { createMediaRoutes } from './api/media.js';
import { createOverlayRoutes } from './api/overlay.js';
import { createStreamProxyRoutes } from './api/stream-proxy.js';
import { createDeviceRoutes } from './api/device.js';
import { createMonitorRoutes } from './api/monitor.js';
import { createStreamKeyRoutes } from './api/stream-key.js';
import { PairingStore, createPairingRoutes } from './api/pairing.js';
import { createServerSettingsRoutes } from './api/server-settings.js';
import { adminAuth, liveAuth as liveAuthFactory } from './api/auth.js';
import { createAuthRoutes } from './api/auth-routes.js';
import { SessionStore } from './security/sessions.js';
import { StreamKeyStore } from './security/stream-key.js';
import { ServerSettingsStore } from './settings/store.js';
import { checkPortDependencies, describeMismatch } from './settings/dependencies.js';
import { assessPublicUrls } from './settings/public-urls.js';
import { localEndpoints } from './settings/local-address.js';
import { RateLimiter } from './security/rate-limit.js';
import { assessSecret } from './security/passwords.js';
import { attachSocket } from './realtime/socket.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const startedAt = Date.now();

const store = new Store(config.dataDir, logger);
const mediaStore = new MediaStore({
  dataDir: config.dataDir,
  logger,
  defaultOutroSeconds: config.machine.outroDurationMs / 1000,
});
const overlayStore = new OverlayStore({ dataDir: config.dataDir, logger });
/** A web UI → telefon parancscsatorna (8. szegmens). */
const commands = new DeviceCommandQueue({ logger });
/** Metrika-napló és chat-linkek (9. szegmens). */
const metrics = new MetricsRecorder({ dataDir: config.dataDir, logger });
const links = new LinkStore({ dataDir: config.dataDir, logger });

/** Admin munkamenetek és a bejelentkezés sebességkorlátozása (10. szegmens). */
const sessions = new SessionStore({ ttlMs: config.sessionTtlMs });
/**
 * A streamkulcs hash-elt tára (1.0.010). A `.env`-ben megadott érték már csak
 * tartalék: ha a felületen létrehoznak egy kulcsot, az élvez elsőbbséget.
 */
const streamKeys = new StreamKeyStore({
  dataDir: config.dataDir,
  logger,
  fallbackKey: config.streamKey,
});
/**
 * Futásidőben állítható szerver-beállítások (1.0.011). A port a KÖVETKEZŐ
 * indításkor lép életbe — a `config.port` már az itt tárolt értéket tükrözi.
 */
const serverSettings = new ServerSettingsStore({
  dataDir: config.dataDir,
  logger,
  envPort: process.env.ONLIVE_SERVER_PORT,
});

/** A repó gyökere — a tunnel tartalék konfigurációjának kereséséhez. */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const portDependencies = () => checkPortDependencies(config.port, {
  mediamtxConfig: config.autostart.mediamtxConfig,
  repoRoot,
});

const loginLimiter = new RateLimiter();
setInterval(() => loginLimiter.prune(), 60_000).unref?.();
const monitor = new IngestMonitor({ config, logger });
const ingestControl = new IngestControl({ config, logger });

const controller = new SessionController({
  config,
  store,
  logger,
  // Az outro hossza futásidőben állítható az admin felületen (5. szegmens),
  // ezért függvényként adjuk át — nem fix értékként.
  outroDurationMs: () => mediaStore.outroDurationMs(),
  // `ended` állapotban a publisher-kapcsolat aktív bontása.
  ingestControl,
  metrics,
});

monitor.on('status', (status) => controller.updateIngest(status));

const app = express();
/*
  A Cloudflare Tunnel mögött vagyunk, de CSAK a loopbacknek hiszünk.

  `true` esetén az express a teljes `X-Forwarded-For` láncot hitelesnek venné,
  és a `req.ip` a kliens által küldött ELSŐ elem lenne — vagyis bárki
  tetszőleges IP-t hazudhatna, és minden próbálkozáshoz friss „IP-t" választva
  megkerülné a bejelentkezés sebességkorlátozását. A cloudflared localhostról
  csatlakozik és ő fűzi a lánc végére a valódi klienst, ezért a loopback
  megbízhatónak jelölése pontosan annyit enged, amennyi kell.
*/
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));

/**
 * Host-alapú útvonalválasztás.
 *
 * A cloudflared nem ír át útvonalat (docs/NETWORKING.md), ezért a
 * `live.galandras.com` gyökerét itt irányítjuk a `/live` oldalra. Így az
 * OBS Browser Source-ba elég a puszta domaint beírni.
 */
app.use((req, res, next) => {
  const host = (req.hostname ?? '').toLowerCase();
  if (host.startsWith('live.') && req.path === '/') {
    req.url = '/live';
  }
  next();
});

/**
 * A `/live` oldal és a lejátszás védelme. Token nélkül nyilvános — így az
 * OBS-be elég a puszta URL; tokennel viszont minden lejátszási kérés kéri.
 */
const liveAuth = liveAuthFactory(config, { sessions });

/**
 * EGYETLEN admin-őr minden modulnak. Így garantált, hogy mindenhol ugyanaz a
 * munkamenet-, CSRF- és sebességkorlát-ellenőrzés fut — nem fordulhat elő,
 * hogy egy útvonal véletlenül lazább szabállyal védett.
 */
const adminGuard = adminAuth(config, logger, { sessions, limiter: loginLimiter });

/**
 * Párosítások (1.0.110) — kizárólag a memóriában, rövid élettartammal.
 * A csomag nyers streamkulcsot tartalmaz, ezért lemezre nem kerülhet.
 */
const pairings = new PairingStore();

/**
 * Biztonsági fejlécek minden válaszon.
 *
 * A CSP `unsafe-inline`-t enged a szkriptekre, mert az admin oldalak
 * szándékosan build-lépés nélküliek (egy fájl = egy oldal). A külső forrásból
 * betöltött szkriptet viszont így is blokkolja, és a `frame-ancestors` miatt
 * idegen oldal nem ágyazhatja be a felületet.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!req.path.startsWith('/embed/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
        "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'self'",
    );
  }
  next();
});

app.use(createAuthRoutes({ config, sessions, limiter: loginLimiter, streamKeys, adminGuard, logger }));
app.use(createRoutes({ config, controller, monitor, store, commands, limiter: loginLimiter, streamKeys, adminGuard, logger, startedAt }));
app.use(createDeviceRoutes({ config, controller, commands, adminGuard, logger }));
app.use(createMonitorRoutes({ config, store, metrics, links, adminGuard, logger }));
app.use(createStreamKeyRoutes({ streamKeys, adminGuard, logger }));
app.use(createPairingRoutes({ config, streamKeys, pairings, limiter: loginLimiter, adminGuard, logger }));
app.use(createServerSettingsRoutes({ settings: serverSettings, config, logger, adminGuard, dependencyCheck: portDependencies }));
app.use(createMediaRoutes({ config, mediaStore, controller, logger, liveAuth, adminGuard }));
app.use(createOverlayRoutes({ config, overlayStore, controller, logger, liveAuth, adminGuard }));
app.use(createStreamProxyRoutes({ config, logger, liveAuth }));

/** A HLS tartalék lejátszó könyvtára (csak akkor tölt be, ha kell). */
app.get('/vendor/hls.min.js', (req, res) => {
  // fileURLToPath, nem .pathname: Windowson az utóbbi `/C:/…` alakot adna,
  // amit a sendFile nem tud megnyitni.
  res.type('application/javascript').sendFile(
    fileURLToPath(new URL('../node_modules/hls.js/dist/hls.min.js', import.meta.url)),
  );
});

/**
 * A `/live` kompozit oldal.
 *
 * Az 5. szegmensben megkapta az intro/outro/megszakadt médiát és az
 * előnézeti módot (`?preview=<screen>`). A tényleges videó-lejátszó (WHEP)
 * a 6. szegmensben, a widgetek a 7.-ben kerülnek bele.
 */
const page = (name) => readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8');

app.get('/live', liveAuth, (req, res) => {
  // A stream neve a szerver konfigurációjából jön, hogy az OBS URL-be ne
  // kelljen beírni — a `?path=` felülbírálja, ha valaha több stream lesz.
  res.type('html').send(
    page('live.html').replace(
      '<script src="/socket.io/socket.io.js"></script>',
      `<script>window.ONLIVE_STREAM_PATH=${JSON.stringify(config.ingest.path)};</script>\n` +
        '<script src="/socket.io/socket.io.js"></script>',
    ),
  );
});

/**
 * Admin felület (8. szegmens).
 *
 * A `/admin` a teljes vezérlőfelület; az al-oldalak (média, OBS, overlay)
 * önállóan is megnyithatók, és fülként be vannak ágyazva ide.
 */
app.get('/admin.css', (req, res) => res.type('text/css').send(page('admin.css')));
app.get('/admin-auth.js', (req, res) => res.type('application/javascript').send(page('admin-auth.js')));
app.get('/admin', (req, res) => res.type('html').send(page('admin.html')));
app.get('/admin/login', (req, res) => res.type('html').send(page('login.html')));
app.get('/admin/media', (req, res) => res.type('html').send(page('admin-media.html')));
app.get('/admin/obs', (req, res) => res.type('html').send(page('admin-obs.html')));
app.get('/admin/overlay', (req, res) => res.type('html').send(page('admin-overlay.html')));
app.get('/admin/stream-key', (req, res) => res.type('html').send(page('admin-streamkey.html')));
app.get('/admin/server', (req, res) => res.type('html').send(page('admin-server.html')));
app.get('/admin/monitor', (req, res) => res.type('html').send(
  page('admin-monitor.html').replace(
    '<script src="/socket.io/socket.io.js"></script>',
    `<script>window.ONLIVE_STREAM_PATH=${JSON.stringify(config.ingest.path)};</script>\n` +
      '<script src="/socket.io/socket.io.js"></script>',
  ),
));

/**
 * Nyilvános link-oldal (9. szegmens).
 *
 * Külön oldal, NEM a `/live` — az a kompozit render-felület, ahol nincs
 * interakció (nincs kurzor, nincs kattintható elem). A linkeket a telefonon
 * nyitod meg, ez az oldal arra készült.
 */
app.get('/links', (req, res) => res.type('html').send(page('links.html')));

app.get('/', (req, res) => {
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>OnLIVE</title>` +
      `<body style="font-family:system-ui;background:#0B0D10;color:#e5e7eb;padding:2rem">` +
      `<h1>OnLIVE</h1><p>A vezérlő szerver fut.</p>` +
      `<ul><li><a style="color:#f43f5e" href="/admin">/admin</a> — vezérlőfelület</li>` +
      `<li><a style="color:#f43f5e" href="/live">/live</a> — kompozit lejátszó (OBS Browser Source)</li>` +
      `<li><a style="color:#f43f5e" href="/links">/links</a> — chat-linkek (mobilra)</li>` +
      `<li><a style="color:#f43f5e" href="/healthz">/healthz</a> — állapot</li></ul></body>`,
  );
});

const httpServer = createServer(app);
attachSocket(httpServer, { controller, mediaStore, overlayStore, config, sessions, logger });

httpServer.listen(config.port, async () => {
  // A streamkulcs betöltése aszinkron: megvárjuk, különben a biztonsági
  // helyzetkép azt hinné, nincs is kulcs.
  await streamKeys.ready;
  banner();
  monitor.start();
});

/**
 * Indító üzenet: keretezett banner az elérhető URL-ekkel. Ezt látod a
 * `start.bat` ablakában, amikor a rendszer feláll (11. szegmens).
 */
function banner() {
  const c = logger.colors;
  const line = '─'.repeat(58);
  console.log(`\n${c.magenta}┌${line}┐${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  ${c.red}OnLIVE${c.reset} vezérlő szerver elindult`.padEnd(78) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}├${line}┤${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  Helyi:   http://localhost:${config.port}`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  Admin:   ${config.publicUrls.admin}`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  Live:    ${config.publicUrls.live}/live`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  Vezérlés:${config.publicUrls.admin}/admin`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}│${c.reset}  Ingest:  ${config.publicUrls.ingest}/${config.ingest.path}/whip`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}└${line}┘${c.reset}\n`);

  logger.info(
    `Küszöbök: live→reconnecting ${config.machine.liveThresholdMs / 1000} mp · ` +
      `outro ${config.machine.outroDurationMs / 1000} mp · ` +
      `megszakadás ${config.ingest.interruptAfterMs} ms`,
  );

  logger.info(`Port: ${config.port} (${{
    felulet: 'a webes felületen beállítva',
    env: 'ONLIVE_SERVER_PORT',
    alapertelmezes: 'alapértelmezés',
  }[config.portSource]})`);

  portReport();
  localAddressReport();
  publicUrlReport();
  securityReport();
}

/**
 * Helyi elérési címek kiírása induláskor (1.0.103).
 *
 * Ezek kellenek a telefon „Helyi elérés" mezőibe. Eddig csak az admin
 * felületen látszottak — ahhoz viszont előbb be kell jutni, ami pont akkor
 * nehéz, amikor a hálózattal van a baj. A naplóban mindig ott vannak.
 */
function localAddressReport() {
  const { candidates } = localEndpoints({ port: config.port, whipPort: config.ingest.whepPort });
  if (!candidates.length) {
    logger.warn('Nem találtam helyi hálózati címet — csak a publikus (Tunnel) út marad.');
    return;
  }
  for (const candidate of candidates) {
    logger.info(`Helyi elérés (${candidate.kind}): ${candidate.control} · ingest ${candidate.ingest}`);
  }
  logger.info('Ha a telefon nem éri el ezeket, a tűzfalon kell átengedni a bejövő portokat.');
}

/**
 * A publikus címek épsége (1.0.019).
 *
 * A telefon ezekhez fűzi hozzá a saját útvonalait, ezért egy „/admin" végű
 * alap-cím nem hibaüzenetet ad, hanem HTTP 404-et a kapcsolat-tesztnél — ami
 * mindenre gyanakodni enged, csak a címre nem. A fájlból viszont kiolvasható,
 * tehát induláskor szólunk.
 */
function publicUrlReport() {
  for (const problem of assessPublicUrls(config.publicUrls)) {
    if (problem.level === 'error') logger.error(problem.message);
    else logger.warn(problem.message);
  }
}

/**
 * Port-egyezés a szomszédos komponensekkel (1.0.011).
 *
 * A port átállítása után a cloudflared és a MediaMTX a RÉGI porton keresné a
 * szervert, és a rendszer némán romlana el: a publikus címek 502-t adnának, a
 * telefon pedig 401-et kapna a WHIP-en. Ezt nehéz kitalálni, viszont a
 * fájlokból kiolvasható — ezért induláskor szólunk.
 */
function portReport() {
  for (const check of portDependencies()) {
    if (check.ok) continue;
    logger.event({
      type: LogEvent.SYSTEM,
      level: 'error',
      message: describeMismatch(check),
      component: check.id,
      file: check.file,
      expected: check.expected,
      found: check.found,
    });
  }
}

/**
 * Biztonsági helyzetkép induláskor.
 *
 * A streamkulcs a WHIP ingest EGYETLEN védelme: aki kitalálja, idegen streamet
 * publikálhat a nevünkben. Ezért a gyenge vagy hiányzó titkokat indításkor
 * kiírjuk — ne akkor derüljön ki, amikor már baj van.
 */
function securityReport() {
  // A streamkulcs 1.0.010 óta hash-elve, a felületen jön létre; a `.env`
  // értéke már csak tartalék, ezért azt külön minősítjük.
  const keyStatus = streamKeys.status();
  const streamKeyCheck = keyStatus.source === 'felulet'
    ? { level: 'strong', message: 'Streamkulcs: a felületen létrehozva, hash-elve tárolva.' }
    : keyStatus.source === 'env'
      ? {
        level: 'fair',
        message: 'Streamkulcs: még a .env-ből jön. Hozz létre újat: /admin → Streamkulcs.',
      }
      : { level: 'missing', message: 'Nincs streamkulcs — bárki publikálhat! (/admin → Streamkulcs)' };

  const checks = [
    ['Admin jelszó', config.adminPasswordHash
      ? { level: 'strong', message: 'Admin jelszó: hash-elve tárolva.' }
      : assessSecret(config.adminPassword, { name: 'Admin jelszó', minLength: 12 })],
    ['Streamkulcs', streamKeyCheck],
    ['Hook titok', assessSecret(config.hookSecret, { name: 'Hook titok', minLength: 16 })],
  ];

  for (const [, assessment] of checks) {
    if (assessment.level === 'strong') continue;
    if (assessment.level === 'missing') logger.error(assessment.message);
    else logger.warn(assessment.message);
  }

  logger.info(
    config.liveToken
      ? 'A /live tokennel védett (csak megtekintés, vezérlésre nem jó).'
      : 'A /live nyilvános. Tokenes védelemhez: ONLIVE_LIVE_TOKEN (npm run keygen).',
  );
  if (!config.adminPassword && !config.adminPasswordHash) {
    logger.error('Nincs admin jelszó — az admin felület CSAK localhostról érhető el.');
  }
}

// -------------------------------------------------------------------------
// Rendezett leállás
// -------------------------------------------------------------------------

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`${signal} — leállás…`);
    monitor.stop();
    controller.stop();

    // A naplófájl írása pufferelt: `process.exit` a még ki nem írt sorokat
    // eldobná — pont a leállásról szólókat. Ezért előbb lezárjuk a fájlt,
    // és csak a `finish` után lépünk ki.
    const quit = () => logger.close(() => process.exit(0));
    httpServer.close(quit);
    setTimeout(quit, 3000).unref();
  });
}

process.on('unhandledRejection', (error) => {
  logger.error(`Kezeletlen elutasítás: ${error?.message ?? error}`);
});
