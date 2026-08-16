/**
 * Kölcsönös kapcsolat-visszajelzés — a szerver nyugtája (1.0.102).
 *
 * MIÉRT VAN EZ A FÁJL: volt egy állapot, amiben a szerver „látta a
 * csatlakozást", a telefon viszont végtelen újracsatlakozást írt ki — és semmi
 * nem árulta el, melyik láb áll. A kettő ugyanis külön út:
 *
 *   · a vezérlő hívások HTTP-n mennek a szerverre,
 *   · a média WHIP-en a MediaMTX-hez.
 *
 * Az egyik lehet hibátlan, miközben a másik semmit nem szállít. Ezért minden
 * telefon-kérés válasza hozza a szerver SAJÁT nézetét (`ack`), és a telefon
 * ezt ki is írja. Itt azt mérjük, hogy a nyugta tényleg a valós ingest-állapotot
 * tükrözi — nem egy derűlátó alapértelmezést.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';

import { createRoutes } from '../src/api/routes.js';

const KEY = 'Teszt-Kulcs-1234!x';

/** Csak annyi, amennyit a session-útvonalak tényleg használnak. */
function harness({ ingest }) {
  const snapshot = {
    state: 'live',
    ingest: {
      available: true, flowing: false, stalled: false, tracks: 0, lastChangeAt: null, ...ingest,
    },
  };

  const controller = {
    snapshot: () => snapshot,
    machine: { state: snapshot.state },
    capture: {},
    updateCapture() {},
    updateStats() {},
    send: () => ({ changed: true, snapshot: { state: snapshot.state } }),
  };

  const commands = {
    presence: { capture: null },
    touch() {},
    pull: () => [],
    push: () => ({}),
  };

  const config = {
    port: 8080,
    ingest: { path: 'onlive', user: 'publisher', whepPort: 8889, apiBase: 'http://127.0.0.1:9997' },
    publicUrls: { admin: 'https://admin.pelda.hu', live: 'https://live.pelda.hu', ingest: 'https://ingest.pelda.hu' },
    hookSecret: 'titok',
  };

  const logger = { info() {}, warn() {}, error() {}, event() {} };

  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config,
    controller,
    monitor: { check: async () => {} },
    store: { recentTransitions: async () => [] },
    commands,
    limiter: null,
    streamKeys: { configured: true, verify: (value) => value === KEY, markUsed() {} },
    adminGuard: (req, res, next) => next(),
    logger,
    startedAt: Date.now(),
  }));

  return { app, snapshot };
}

/** Elindít egy igazi HTTP szervert, lefuttat egy kérést, majd bezár. */
async function call(app, path, { method = 'GET', body } = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a telemetria válasza hozza a szerver nyugtáját', async () => {
  const { app } = harness({ ingest: { flowing: true, tracks: 2 } });
  const { status, json } = await call(app, '/api/session/stats', { method: 'POST', body: { fps: 30 } });

  assert.equal(status, 200);
  assert.ok(json.ack, 'kell nyugta — enélkül a telefon nem tudja, mit lát a szerver');
  assert.equal(json.ack.ingest.flowing, true);
  assert.equal(json.ack.ingest.tracks, 2);
  assert.equal(json.ack.state, 'live');
  assert.equal(json.ack.streamPath, 'onlive');
});

test('ha nem érkezik kép, a nyugta ezt MEGMONDJA', async () => {
  // Ez a lényeg: a sikeres HTTP válasz önmagában nem jelenti azt, hogy megy az
  // adás. A telefon eddig ezt nem tudta megkülönböztetni.
  const { app } = harness({ ingest: { available: true, flowing: false } });
  const { json } = await call(app, '/api/session/stats', { method: 'POST', body: {} });

  assert.equal(json.ok, true, 'a kérés maga sikeres');
  assert.equal(json.ack.ingest.flowing, false, 'a média viszont nem érkezik');
});

test('a megállt adat külön jelzés', async () => {
  const { app } = harness({ ingest: { available: true, flowing: false, stalled: true } });
  const { json } = await call(app, '/api/session/stats', { method: 'POST', body: {} });

  assert.equal(json.ack.ingest.stalled, true);
  assert.equal(json.ack.ingest.flowing, false);
});

test('a start és a ping is nyugtázik', async () => {
  const { app } = harness({ ingest: { flowing: true } });

  const start = await call(app, '/api/session/start', { method: 'POST', body: { device: 'teszt' } });
  assert.equal(start.json.ack.ingest.flowing, true, 'induláskor is látszik, mit lát a szerver');

  const ping = await call(app, '/api/session/ping');
  assert.equal(ping.json.ack.ingest.flowing, true, 'a kapcsolat-teszt is megmondja');
  assert.match(ping.json.whipUrl, /^https:\/\/ingest\.pelda\.hu\/onlive\/whip$/);
});

test('rossz streamkulccsal nincs nyugta, csak 401', async () => {
  const { app } = harness({ ingest: { flowing: true } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session/stats`, {
      method: 'POST',
      headers: { Authorization: 'Bearer rossz-kulcs', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
    const json = await response.json();
    assert.equal(json.ack, undefined, 'hitelesítés nélkül semmilyen belső állapot nem szivárog ki');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
