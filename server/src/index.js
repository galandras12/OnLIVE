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
import { createRoutes } from './api/routes.js';
import { attachSocket } from './realtime/socket.js';
import { livePlaceholderPage } from './placeholder.js';

const startedAt = Date.now();

const store = new Store(config.dataDir, logger);
const controller = new SessionController({ config, store, logger });
const monitor = new IngestMonitor({ config, logger });

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

app.use(createRoutes({ config, controller, monitor, store, logger, startedAt }));

/**
 * IDEIGLENES `/live` oldal.
 *
 * Csak azt mutatja meg, melyik képernyőt kellene mutatni, és valós időben
 * követi az állapotot — így a 4. szegmens végponttól végpontig tesztelhető.
 * A tényleges overlay-kompozíció (intro/outro média, logó, chat, widgetek)
 * az 5–7. szegmens feladata, ez a fájl akkor lecserélődik.
 */
app.get('/live', (req, res) => {
  res.type('html').send(livePlaceholderPage());
});

app.get('/', (req, res) => {
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>OnLIVE</title>` +
      `<body style="font-family:system-ui;background:#0B0D10;color:#e5e7eb;padding:2rem">` +
      `<h1>OnLIVE</h1><p>A vezérlő szerver fut.</p>` +
      `<ul><li><a style="color:#f43f5e" href="/live">/live</a> — kompozit lejátszó (ideiglenes)</li>` +
      `<li><a style="color:#f43f5e" href="/healthz">/healthz</a> — állapot</li></ul>` +
      `<p style="color:#6b7280">Az admin felület a 8. szegmensben készül el.</p></body>`,
  );
});

const httpServer = createServer(app);
attachSocket(httpServer, { controller, logger });

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
  console.log(`${c.magenta}│${c.reset}  Ingest:  ${config.publicUrls.ingest}/${config.ingest.path}/whip`.padEnd(70) + `${c.magenta}│${c.reset}`);
  console.log(`${c.magenta}└${line}┘${c.reset}\n`);

  logger.info(
    `Küszöbök: live→reconnecting ${config.machine.liveThresholdMs / 1000} mp · ` +
      `outro ${config.machine.outroDurationMs / 1000} mp · ` +
      `megszakadás ${config.ingest.interruptAfterMs} ms`,
  );
  if (!config.streamKey) logger.warn('Nincs ONLIVE_STREAM_KEY — a session API védtelen.');
  if (!config.adminPassword) logger.warn('Nincs ONLIVE_ADMIN_PASSWORD — az admin API csak localhostról érhető el.');
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
