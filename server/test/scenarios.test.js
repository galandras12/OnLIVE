/**
 * A 11. szegmensben előírt négy tesztforgatókönyv (11. szegmens).
 *
 * Ezek nem egységtesztek: a teljes vezérlő láncot járják végig — állapotgép +
 * controller + ingest-jelzések + eszköz-parancsok —, pontosan úgy, ahogy egy
 * valódi adás során történne. Hálózat nélkül futnak, mert az ingest oldalt a
 * monitor helyett közvetlenül tápláljuk (ugyanazokkal a státuszokkal).
 *
 * A kézi, éles próbához tartozó lépéssor: docs/OPERATIONS.md 5. fejezet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionController } from '../src/state/controller.js';
import { DeviceCommandQueue, DeviceCommands } from '../src/device/commands.js';
import { Events, States } from '../src/state/machine.js';

const silentLogger = {
  info() {}, ok() {}, warn() {}, error() {}, state() {}, event() {}, colors: {},
};

const memoryStore = () => ({
  transitions: [],
  async appendTransition(entry) { this.transitions.push(entry); },
  async saveSnapshot() {},
  async recentTransitions() { return this.transitions; },
});

function setup({ liveThresholdMs = 2 * 60 * 1000, outroDurationMs = 60 } = {}) {
  const commands = new DeviceCommandQueue({ logger: silentLogger });
  const controller = new SessionController({
    config: {
      machine: { liveThresholdMs, outroDurationMs, introOnEveryStart: true, shutdownOnEnded: false },
      ingest: { pollMs: 1000, interruptAfterMs: 3000 },
    },
    store: memoryStore(),
    logger: silentLogger,
  });
  return { controller, commands };
}

/** Az ingest-figyelő által küldött státusz — a monitor pontosan ilyet ad. */
const flowing = { available: true, flowing: true, stalled: false, tracks: ['H264', 'Opus'], readers: 0 };
const gone = { available: true, flowing: false, stalled: false, tracks: [], readers: 0 };

const screenOf = (controller) => controller.snapshot().screen;

// ---------------------------------------------------------------------------
// 1. forgatókönyv
// ---------------------------------------------------------------------------

test('1) Első indítás óta nem volt élő → Kezdés → intro, amíg a stream be nem fut', () => {
  const { controller } = setup();

  assert.equal(controller.machine.state, States.IDLE);

  controller.send(Events.SESSION_START, {}, 'telefon');
  assert.equal(controller.machine.state, States.INTRO);
  assert.equal(screenOf(controller), 'intro', 'a /live a „Hamarosan kezdünk" képernyőt mutatja');
  assert.equal(controller.machine.context.isFirstStartSinceBoot, true);
  assert.equal(controller.machine.context.playIntroMedia, true, 'az intro média lejátszandó');

  // Amíg nincs bejövő stream, introban maradunk — akárhány ingest-mintavétel jön.
  for (let i = 0; i < 5; i += 1) controller.updateIngest(gone);
  assert.equal(controller.machine.state, States.INTRO);

  // Megérkezik a kép → live.
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE);
  assert.equal(screenOf(controller), 'live');
});

// ---------------------------------------------------------------------------
// 2. forgatókönyv
// ---------------------------------------------------------------------------

test('2) 3 perce élő, a telefon net-je megszakad → Megszakadt, majd magától folytatódik', async () => {
  // A küszöböt rövidítjük le, nem az órát csaljuk meg: így ugyanaz a kód fut,
  // mint élesben, csak gyorsítva. (Élesben 2 perc, itt 60 ms.)
  const { controller } = setup({ liveThresholdMs: 60 });

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE);

  // „3 perc élő adás" — a küszöb fölött.
  await new Promise((resolve) => setTimeout(resolve, 100));

  controller.updateIngest(gone);
  assert.equal(controller.machine.state, States.RECONNECTING, '2 percnél hosszabb adás után reconnecting');
  assert.equal(screenOf(controller), 'interrupted', 'a „Megszakadt" képernyő megy');
  assert.equal(controller.machine.context.interruptions, 1);

  // A stream visszatér — külön felhasználói művelet NÉLKÜL.
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE, 'automatikusan folytatódik');
  assert.equal(screenOf(controller), 'live');
});

test('2b) 2 percnél rövidebb adás megszakadása introba visz vissza', () => {
  const { controller } = setup({ liveThresholdMs: 2 * 60 * 1000 });

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  // Azonnali megszakadás — az élő idő messze a küszöb alatt.
  controller.updateIngest(gone);
  assert.equal(controller.machine.state, States.INTRO, 'érdemben el sem kezdődött');
  assert.equal(screenOf(controller), 'intro', 'nem „Megszakadt", hanem „Hamarosan kezdünk"');
});

// ---------------------------------------------------------------------------
// 3. forgatókönyv
// ---------------------------------------------------------------------------

test('3) Szünet a telefonon → Megszakadt-szerű képernyő reconnect nélkül → Folytatás', () => {
  const { controller } = setup();

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE);

  controller.send(Events.SESSION_PAUSE, {}, 'telefon');
  assert.equal(controller.machine.state, States.PAUSED);
  assert.equal(screenOf(controller), 'interrupted', 'vizuálisan ugyanaz, mint a megszakadás');

  // A telefon szünetkor lezárja a WHIP sessiont → az ingest leáll.
  // Az állapot ettől NEM mozdul, és a visszatérés sem hozza vissza magától.
  for (let i = 0; i < 5; i += 1) controller.updateIngest(gone);
  assert.equal(controller.machine.state, States.PAUSED);

  for (let i = 0; i < 5; i += 1) controller.updateIngest(flowing);
  assert.equal(
    controller.machine.state, States.PAUSED,
    'a stream visszatérése ÖNMAGÁBAN nem szünteti meg a szünetet',
  );

  // Csak az explicit Folytatás visz vissza.
  controller.send(Events.SESSION_RESUME, {}, 'telefon');
  assert.equal(controller.machine.state, States.LIVE);
  assert.equal(screenOf(controller), 'live');
});

// ---------------------------------------------------------------------------
// 4. forgatókönyv
// ---------------------------------------------------------------------------

test('4) Befejezés a web UI-ról élő stream közben → outro, majd időzítve minden leáll', async () => {
  const { controller, commands } = setup({ outroDurationMs: 60 });

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  assert.equal(controller.machine.state, States.LIVE);

  // A web UI „Befejezés" gombja: állapotgép + parancs a telefonnak.
  controller.send(Events.SESSION_END, { reason: 'admin' }, 'web-ui');
  commands.push(DeviceCommands.STOP);

  assert.equal(controller.machine.state, States.OUTRO);
  assert.equal(screenOf(controller), 'outro');
  assert.deepEqual(
    commands.pull().map((command) => command.type), ['stop'],
    'a telefon is megkapja a leállítást — különben tovább publikálna',
  );

  // Az outro időzítője zárja le a sessiont.
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(controller.machine.state, States.ENDED);
  assert.equal(screenOf(controller), 'blank');

  controller.stop();
});

test('4b) A telefon Befejezés gombja ugyanoda vezet', async () => {
  const { controller } = setup({ outroDurationMs: 50 });

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  controller.send(Events.SESSION_END, {}, 'telefon');

  assert.equal(controller.machine.state, States.OUTRO);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(controller.machine.state, States.ENDED);

  controller.stop();
});

// ---------------------------------------------------------------------------
// Napló-lenyomat: a forgatókönyvek végigjátszása után visszakereshető minden
// ---------------------------------------------------------------------------

test('minden forgatókönyv nyomot hagy az átmenet-naplóban, forrással együtt', async () => {
  const store = memoryStore();
  const controller = new SessionController({
    config: {
      machine: { liveThresholdMs: 1000, outroDurationMs: 40, introOnEveryStart: true, shutdownOnEnded: false },
      ingest: { pollMs: 1000, interruptAfterMs: 3000 },
    },
    store,
    logger: silentLogger,
  });

  controller.send(Events.SESSION_START, {}, 'telefon');
  controller.updateIngest(flowing);
  controller.send(Events.SESSION_PAUSE, {}, 'telefon');
  controller.send(Events.SESSION_RESUME, {}, 'web-ui');
  controller.send(Events.SESSION_END, {}, 'web-ui');

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    store.transitions.map((entry) => `${entry.to}:${entry.source}`),
    ['intro:telefon', 'live:ingest', 'paused:telefon', 'live:web-ui', 'outro:web-ui'],
    'minden átmenet rögzül azzal együtt, MELYIK felületről érkezett',
  );

  controller.stop();
});
