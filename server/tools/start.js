#!/usr/bin/env node
/**
 * OnLIVE — egyetlen belépési pont (11. szegmens).
 *
 *     npm start
 *
 * Sorrendben:
 *   1. ellenőrzi/elindítja a **cloudflared tunnelt** (Windows service),
 *   2. ellenőrzi/elindítja a **MediaMTX** ingest folyamatot,
 *   3. elindítja a **vezérlő szervert**.
 *
 * Miért ebben a sorrendben: a tunnel nélkül a telefon el sem éri a rendszert,
 * a MediaMTX nélkül pedig a szerver ugyan elindulna, de az első percben
 * „ingest nem elérhető" hibát írna. Így egy paranccsal (vagy egy
 * dupla kattintással a `start.bat`-on) a teljes rendszer feláll.
 *
 * A hiányzó függőség NEM végzetes: a szerver mindig elindul, csak jelzi, mi
 * nem fut — így egy fejlesztői gépen (ahol nincs cloudflared) is használható.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { config } from '../src/config.js';
import { logger } from '../src/util/logger.js';
import { LogEvent } from '../src/log/logger.js';

const isWindows = process.platform === 'win32';
const startedProcesses = [];

// ---------------------------------------------------------------------------
// 1) Cloudflare Tunnel
// ---------------------------------------------------------------------------

function tunnelServiceState(name) {
  if (!isWindows) return 'nem-windows';
  const result = spawnSync('sc', ['query', name], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return 'nincs-telepitve';
  return /RUNNING/i.test(result.stdout) ? 'fut' : 'all';
}

function ensureTunnel() {
  const name = config.autostart.tunnelService;

  if (!isWindows) {
    logger.info(`Tunnel ellenőrzés kihagyva (${process.platform}) — a service-kezelés Windows-specifikus.`);
    return { component: 'tunnel', state: 'kihagyva' };
  }

  const state = tunnelServiceState(name);

  if (state === 'fut') {
    logger.ok(`Cloudflare Tunnel: a(z) "${name}" service fut.`);
    return { component: 'tunnel', state: 'fut' };
  }
  if (state === 'nincs-telepitve') {
    logger.warn(
      `Cloudflare Tunnel: a(z) "${name}" service nincs telepítve. ` +
      'A rendszer csak helyi hálózaton lesz elérhető (docs/NETWORKING.md 4.7).',
    );
    return { component: 'tunnel', state: 'nincs-telepitve' };
  }

  if (!config.autostart.tunnel) {
    logger.warn(`Cloudflare Tunnel: a service áll, az automatikus indítás ki van kapcsolva.`);
    return { component: 'tunnel', state: 'all' };
  }

  logger.info(`Cloudflare Tunnel: a(z) "${name}" service indítása…`);
  const result = spawnSync('net', ['start', name], { encoding: 'utf8' });

  if (result.status === 0) {
    logger.ok('Cloudflare Tunnel elindult.');
    return { component: 'tunnel', state: 'elindítva' };
  }

  logger.error(
    'A tunnel service indítása nem sikerült (rendszergazdai jog kell hozzá). ' +
    `Kézzel: net start ${name}`,
  );
  return { component: 'tunnel', state: 'hiba' };
}

// ---------------------------------------------------------------------------
// 2) MediaMTX
// ---------------------------------------------------------------------------

async function mediamtxReachable() {
  try {
    const response = await fetch(`${config.ingest.apiBase}/v3/paths/list`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureMediaMtx() {
  if (await mediamtxReachable()) {
    logger.ok('MediaMTX: fut és válaszol az API-ján.');
    return { component: 'mediamtx', state: 'fut' };
  }

  const exe = config.autostart.mediamtxPath;
  if (!config.autostart.mediamtx) {
    logger.warn('MediaMTX: nem fut, az automatikus indítás ki van kapcsolva.');
    return { component: 'mediamtx', state: 'all' };
  }
  if (!existsSync(exe)) {
    logger.warn(
      `MediaMTX: nem fut, és nem található itt: ${exe}. ` +
      'Telepítés: infra/mediamtx/install-mediamtx.ps1',
    );
    return { component: 'mediamtx', state: 'nincs-telepitve' };
  }

  logger.info(`MediaMTX indítása: ${exe}`);
  const child = spawn(exe, [config.autostart.mediamtxConfig], {
    detached: false,
    stdio: 'ignore',
  });
  child.on('error', (error) => logger.error(`MediaMTX indítási hiba: ${error.message}`));
  startedProcesses.push(child);

  // Adunk neki pár másodpercet, hogy felálljon az API.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await mediamtxReachable()) {
      logger.ok('MediaMTX elindult.');
      return { component: 'mediamtx', state: 'elindítva' };
    }
  }

  logger.warn('MediaMTX elindult, de az API még nem válaszol — a szerver várni fog rá.');
  return { component: 'mediamtx', state: 'indul' };
}

// ---------------------------------------------------------------------------
// 3) Indítás
// ---------------------------------------------------------------------------

async function main() {
  logger.event({
    type: LogEvent.SYSTEM,
    level: 'info',
    message: 'OnLIVE indítás — függő komponensek ellenőrzése…',
    platform: process.platform,
    node: process.version,
  });

  const results = [ensureTunnel(), await ensureMediaMtx()];

  logger.event({
    type: LogEvent.SYSTEM,
    level: 'info',
    message: 'Előellenőrzés kész.',
    components: Object.fromEntries(results.map((item) => [item.component, item.state])),
  });

  // A szervert ugyanebben a folyamatban indítjuk: egy konzolablak, egy napló,
  // egy Ctrl+C állít le mindent.
  await import('../src/index.js');
}

/** Leállításkor a mi általunk indított folyamatokat is elengedjük. */
function shutdown(signal) {
  logger.event({
    type: LogEvent.SYSTEM,
    level: 'warn',
    message: `${signal} — leállás, a függő folyamatok elengedése.`,
  });
  for (const child of startedProcesses) {
    if (!child.killed) child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

main().catch((error) => {
  logger.error(`Az indítás nem sikerült: ${error.message}`);
  process.exit(1);
});
