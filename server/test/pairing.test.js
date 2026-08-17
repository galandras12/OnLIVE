/**
 * Párosítás — a szerver adja át a beállításokat (1.0.110).
 *
 * A kézi begépelés volt az elmúlt kiadások hibáinak forrása: `/admin`
 * végződés, bennfelejtett `/ingest`, elgépelt kulcs. Egyik sem hibaüzenetet
 * adott, hanem néma nem-működést. A párosítás ezt szünteti meg — cserébe a
 * csomag a **nyers streamkulcsot** viszi, tehát a szabályait tételesen mérjük:
 * egyszer használható, lejár, és próbálgatni sem lehet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';

import { PairingStore, buildPairingPayload, createPairingRoutes } from '../src/api/pairing.js';

const config = {
  port: 8080,
  ingest: { path: 'onlive', user: 'publisher', whepPort: 8889 },
  publicUrls: {
    admin: 'https://live.pelda.hu',
    live: 'https://live.pelda.hu',
    ingest: 'https://ingest.pelda.hu',
  },
  turn: { url: 'turn:turn.pelda.hu:3478', username: 'u', credential: 'p' },
};

const addresses = {
  suggested: { control: 'http://100.1.2.3:8080', ingest: 'http://100.1.2.3:8889', kind: 'tailscale' },
  candidates: [],
};

/* =========================================================================
 *  A tár
 * ====================================================================== */

test('a token EGYSZER használható', () => {
  const store = new PairingStore();
  const { token } = store.create({ hello: 'world' });

  assert.deepEqual(store.take(token), { hello: 'world' });
  assert.equal(store.take(token), null, 'másodszorra már nincs meg');
});

test('a párosítás lejár', () => {
  let now = 1_000;
  const store = new PairingStore({ ttlMs: 500, now: () => now });
  const { token } = store.create({ a: 1 });

  now += 499;
  assert.ok(store.take(token), 'a lejárat előtt még megvan');

  const second = store.create({ b: 2 });
  now += 501;
  assert.equal(store.take(second.token), null, 'a lejárat után nem adjuk ki');
  assert.equal(store.size, 0, 'a lejártakat ki is takarítjuk');
});

test('ismeretlen token nem ad semmit', () => {
  const store = new PairingStore();
  assert.equal(store.take('nincs-ilyen'), null);
  assert.equal(store.take(undefined), null);
});

/* =========================================================================
 *  A csomag tartalma
 * ====================================================================== */

test('a csomag a szerver ellenőrzött értékeiből áll össze', () => {
  const payload = buildPairingPayload({ config, streamKey: 'Teszt-Kulcs-1234!x', addresses });

  assert.equal(payload.onlive, 'pairing');
  assert.equal(payload.version, 1);
  assert.equal(payload.server.control, 'https://live.pelda.hu');
  assert.equal(payload.server.ingest, 'https://ingest.pelda.hu');
  assert.equal(payload.server.localControl, 'http://100.1.2.3:8080');
  assert.equal(payload.server.localIngest, 'http://100.1.2.3:8889');
  assert.equal(payload.streamPath, 'onlive');
  assert.equal(payload.ingestUser, 'publisher');
  assert.equal(payload.streamKey, 'Teszt-Kulcs-1234!x');

  // A TURN-t is a szerver adja át — eddig ezt is kézzel kellett begépelni.
  assert.equal(payload.turn.url, 'turn:turn.pelda.hu:3478');
});

test('a címekben NINCS útvonal — pont ez volt a két korábbi hiba forrása', () => {
  const payload = buildPairingPayload({ config, streamKey: 'k', addresses });

  for (const [name, url] of Object.entries(payload.server)) {
    if (!url) continue;
    const path = new URL(url).pathname.replace(/\/+$/, '');
    assert.equal(path, '', `${name}: útvonal került az alap-címbe (${url})`);
  }
});

/* =========================================================================
 *  A végpontok
 * ====================================================================== */

function harness() {
  const pairings = new PairingStore();
  const saved = [];

  const streamKeys = {
    ready: Promise.resolve(),
    set: async (key, meta) => { saved.push({ key, meta }); },
  };

  const app = express();
  app.use(express.json());
  app.use(createPairingRoutes({
    config,
    streamKeys,
    pairings,
    limiter: null,
    adminGuard: (req, res, next) => next(),
    logger: { info() {}, warn() {}, error() {}, event() {} },
  }));

  return { app, pairings, saved };
}

async function call(app, path, { method = 'GET' } = {}) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a párosítás új kulcsot generál, és el is menti hash-elve', async () => {
  const { app, saved } = harness();
  const { status, json } = await call(app, '/api/admin/pairing', { method: 'POST' });

  assert.equal(status, 200);
  assert.equal(saved.length, 1, 'a kulcsot el kell menteni, különben a telefon olyat kapna, amit a szerver nem ismer');
  assert.equal(saved[0].key, json.payload.streamKey, 'a csomagban ugyanaz a kulcs van, amit eltároltunk');
  assert.ok(json.payload.streamKey.length >= 16);

  // A mély hivatkozás a telefonnak szól — token + a szerver alap-címe.
  assert.match(json.deepLink, /^onlive:\/\/pair\?token=[a-f0-9]{32}&server=/);
  assert.ok(json.expiresAt > Date.now());
});

test('a telefon egyszer töltheti le a csomagot', async () => {
  const { app } = harness();
  const created = await call(app, '/api/admin/pairing', { method: 'POST' });
  const token = created.json.token;

  const first = await call(app, `/api/pair/${token}`);
  assert.equal(first.status, 200);
  assert.equal(first.json.streamKey, created.json.payload.streamKey);

  const second = await call(app, `/api/pair/${token}`);
  assert.equal(second.status, 404, 'a token felhasználás után érvénytelen');
  assert.match(second.json.error, /lejárt vagy már felhasználták/);
});

test('ismeretlen tokenre 404 jön, kulcs nélkül', async () => {
  const { app } = harness();
  const { status, json } = await call(app, '/api/pair/0123456789abcdef0123456789abcdef');

  assert.equal(status, 404);
  assert.equal(json.streamKey, undefined, 'hibás tokennél semmilyen titok nem szivároghat ki');
});
