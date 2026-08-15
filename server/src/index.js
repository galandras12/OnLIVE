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
import { liveAuth as liveAuthFactory } from './api/auth.js';
import { attachSocket } from './realtime/socket.js';
import { readFileSync } from 'node:fs';

const startedAt = Date.now();

const store = new Store(config.dataDir, logger);
const mediaStore = new MediaStore({ dataDir: config.dataDir, logger });
const overlayStore = new OverlayStore({ dataDir: config.dataDir, logger });
/** A web UI → telefon parancscsatorna (8. szegmens). */
const commands = new DeviceCommandQueue({ logger });
/** Metrika-napló és chat-linkek (9. szegmens). */
const metrics = new MetricsRecorder({ dataDir: config.dataDir, logger });
const links = new LinkStore({ dataDir: config.dataDir, logger });
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
app.set('trust proxy', true); // a Cloudflare Tunnel mögött vagyunk
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
const liveAuth = liveAuthFactory(config);

app.use(createRoutes({ config, controller, monitor, store, commands, logger, startedAt }));
app.use(createDeviceRoutes({ config, controller, commands, logger }));
app.use(createMonitorRoutes({ config, store, metrics, links, logger }));
app.use(createMediaRoutes({ config, mediaStore, controller, logger, liveAuth }));
app.use(createOverlayRoutes({ config, overlayStore, controller, logger, liveAuth }));
app.use(createStreamProxyRoutes({ config, logger, liveAuth }));

/** A HLS tartalék lejátszó könyvtára (csak akkor tölt be, ha kell). */
app.get('/vendor/hls.min.js', (req, res) => {
  res.type('application/javascript').sendFile(
    new URL('../node_modules/hls.js/dist/hls.min.js', import.meta.url).pathname,
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
app.get('/admin', (req, res) => res.type('html').send(page('admin.html')));
app.get('/admin/media', (req, res) => res.type('html').send(page('admin-media.html')));
app.get('/admin/obs', (req, res) => res.type('html').send(page('admin-obs.html')));
app.get('/admin/overlay', (req, res) => res.type('html').send(page('admin-overlay.html')));
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
attachSocket(httpServer, { controller, mediaStore, overlayStore, config, logger });

httpServer.listen(config.port, () => {
  banner();
  monitor.start();
});

/**
 * Indító üzenet. A 11. szegmens ezt bővíti majd (ASCII-art, teljes URL-lista
 * a `start.bat`-tal indított konzolban) — itt már most kiírjuk a lényeget.
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
  if (!config.streamKey) logger.warn('Nincs ONLIVE_STREAM_KEY — a session API védtelen.');
  if (!config.adminPassword) logger.warn('Nincs ONLIVE_ADMIN_PASSWORD — az admin API csak localhostról érhető el.');
  logger.info(
    config.liveToken
      ? 'A /live oldal tokennel védett (ONLIVE_LIVE_TOKEN).'
      : 'A /live oldal nyilvános. Tokenes védelemhez állítsd be az ONLIVE_LIVE_TOKEN-t.',
  );
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
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on('unhandledRejection', (error) => {
  logger.error(`Kezeletlen elutasítás: ${error?.message ?? error}`);
});
