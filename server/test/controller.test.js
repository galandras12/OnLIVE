/**
 * A SessionController tesztjei — az állapotgép és a külvilág illesztése.
 *
 * A store és a logger csereszabatos, ezért a controller fájlírás és konzol
 * nélkül tesztelhető. Az IngestMonitor helyett közvetlenül hívjuk az
 * `updateIngest()`-et azokkal a státuszokkal, amiket a monitor küldene.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionController } from '../src/state/controller.js';
import { Events, States } from '../src/state/machine.js';

const noopLogger = {
  info() {}, ok() {}, warn() {}, error() {}, state() {}, colors: {},
};

const memoryStore = () => ({
  transitions: [],
  async appendTransition(entry) {
    this.transitions.push(entry);
  },
  async saveSnapshot() {},
  async recentTransitions() {
    return this.transitions;
  },
});

const testConfig = (overrides = {}) => ({
  machine: {
    liveThresholdMs: 2 * 60 * 1000,
    outroDurationMs: 50,
    introOnEveryStart: true,
    shutdownOnEnded: false,
    ...overrides,
  },
  ingest: { pollMs: 1000, interruptAfterMs: 3000 },
});

const makeController = (overrides) =>
  new SessionController({
    config: testConfig(overrides),
    store: memoryStore(),
    logger: noopLogger,
  });

const flowing = { available: true, flowing: true, stalled: false, bytesReceived: 1, tracks: ['H264'], readers: 0 };
const notFlowing = { available: true, flowing: false, stalled: false, bytesReceived: 1, tracks: [], readers: 0 };
const unavailable = { available: false, flowing: false, stalled: false, lastError: 'ECONNREFUSED' };

test('REGRESSZIÓ: Kezdés MÁR FUTÓ ingest mellett is live-ba jut', () => {
  // Ez a hiba a végponttól végpontig tesztben jött elő: ha a telefon már
  // publikál, amikor a felhasználó Kezdést nyom, élvezérelt figyelésnél soha
  // nem érkezne INGEST_UP él, és a szerver `intro`-ban ragadna.
  const controller = makeController();

  controller.updateIngest(flowing); // a stream már megy, de nincs session
  assert.equal(controller.machine.state, States.IDLE);

  controller.send(Events.SESSION_START, {}, 'phone');
  assert.equal(controller.machine.state, States.INTRO);

  controller.updateIngest(flowing); // a következő mintavétel — nincs "él"
  assert.equal(
    controller.machine.state,
    States.LIVE,
    'a szintvezérelt jelzésnek live-ba kell vinnie',
  );
});

test('a szünetet a folyamatos ingest-jelzés sem töri meg', () => {
  const controller = makeController();
  controller.send(Events.SESSION_START, {}, 'phone');
  controller.updateIngest(flowing);
  controller.send(Events.SESSION_PAUSE, {}, 'phone');

  for (let i = 0; i < 10; i += 1) controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.PAUSED);

  for (let i = 0; i < 10; i += 1) controller.updateIngest(notFlowing);
  assert.equal(controller.machine.state, States.PAUSED);
});

test('az ingest elérhetetlensége megszakadásként jelenik meg, de külön jelzéssel', () => {
  const controller = makeController();
  controller.send(Events.SESSION_START, {}, 'phone');
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE);

  controller.updateIngest(unavailable);

  // Az adás szempontjából nincs kép → intro (rövid adás volt).
  assert.equal(controller.machine.state, States.INTRO);
  // Az admin felület viszont látja, hogy nem a telefonnal van a baj.
  assert.equal(controller.snapshot().ingest.available, false);
});

test('az outro időzítő automatikusan ended-be visz', async () => {
  const controller = makeController({ outroDurationMs: 30 });
  controller.send(Events.SESSION_START, {}, 'phone');
  controller.updateIngest(flowing);
  controller.send(Events.SESSION_END, {}, 'phone');

  assert.equal(controller.machine.state, States.OUTRO);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(controller.machine.state, States.ENDED);
});

test('az outro közbeni újraindítás leállítja az időzítőt', async () => {
  const controller = makeController({ outroDurationMs: 40 });
  controller.send(Events.SESSION_START, {}, 'phone');
  controller.send(Events.SESSION_END, {}, 'phone');
  controller.send(Events.SESSION_START, {}, 'admin');

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(
    controller.machine.state,
    States.INTRO,
    'a korábbi outro időzítő nem vihet ended-be egy új session közben',
  );
  controller.stop();
});

test('minden átmenet bekerül a naplóba, forrással együtt', async () => {
  const store = memoryStore();
  const controller = new SessionController({ config: testConfig(), store, logger: noopLogger });

  controller.send(Events.SESSION_START, {}, 'admin');
  controller.updateIngest(flowing);
  controller.send(Events.SESSION_PAUSE, {}, 'phone');

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    store.transitions.map((t) => `${t.from}→${t.to}:${t.source}`),
    ['idle→intro:admin', 'intro→live:ingest', 'live→paused:phone'],
  );
});

test('a pillanatkép tartalmazza a telefon telemetriáját és beállításait', () => {
  const controller = makeController();
  controller.updateCapture({ resolution: '1080p', fps: 30, videoBitrateKbps: 4500, source: 'camera' });
  controller.updateStats({ videoBitrateKbps: 4200, fps: 30, rttMs: 42 });

  const snapshot = controller.snapshot();
  assert.equal(snapshot.capture.resolution, '1080p');
  assert.equal(snapshot.stats.rttMs, 42);
  assert.ok(snapshot.stats.receivedAt);
});
