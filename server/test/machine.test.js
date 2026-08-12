/**
 * Az állapotgép tesztjei.
 *
 * Külső függőség nélkül fut: `node --test server/test/`.
 * Az órát injektáljuk, így a 2 perces küszöb valós várakozás nélkül tesztelhető.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StreamStateMachine,
  States,
  Events,
  Effects,
  IntroReason,
  screenFor,
} from '../src/state/machine.js';

/** Léptethető óra. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
  };
}

function machineAt(c, options = {}) {
  return new StreamStateMachine({ now: c.now, ...options });
}

const MINUTE = 60 * 1000;

test('induláskor idle', () => {
  const m = machineAt(clock());
  assert.equal(m.state, States.IDLE);
  assert.equal(screenFor(m.state), 'blank');
});

test('Kezdés → intro, és az első indítás meg van jelölve', () => {
  const m = machineAt(clock());
  const r = m.send(Events.SESSION_START);

  assert.equal(r.changed, true);
  assert.equal(r.to, States.INTRO);
  assert.equal(m.context.isFirstStartSinceBoot, true);
  assert.equal(m.context.playIntroMedia, true);
  assert.equal(m.context.introReason, IntroReason.START);
  assert.equal(screenFor(m.state), 'intro');
});

test('intro → megérkezik a stream → live', () => {
  const m = machineAt(clock());
  m.send(Events.SESSION_START);
  const r = m.send(Events.INGEST_UP);

  assert.equal(r.to, States.LIVE);
  assert.equal(screenFor(m.state), 'live');
});

test('2 percnél RÖVIDEBB adás megszakad → vissza introba', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);

  c.advance(90 * 1000); // 1:30
  const r = m.send(Events.INGEST_DOWN);

  assert.equal(r.to, States.INTRO, '1:30 után még nem "kezdődött el érdemben"');
  assert.equal(m.context.introReason, IntroReason.INTERRUPTED);
  assert.equal(m.context.interruptions, 1);
  assert.equal(screenFor(m.state), 'intro');
});

test('2 percnél HOSSZABB adás megszakad → reconnecting', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);

  c.advance(3 * MINUTE);
  const r = m.send(Events.INGEST_DOWN);

  assert.equal(r.to, States.RECONNECTING);
  assert.equal(screenFor(m.state), 'interrupted');
});

test('pontosan 2 perc már eléri a küszöböt', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);

  c.advance(2 * MINUTE);
  assert.equal(m.send(Events.INGEST_DOWN).to, States.RECONNECTING);
});

test('a live szakaszok ÖSSZEADÓDNAK a küszöb számításánál', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);

  c.advance(115 * 1000); // 1:55 élő
  assert.equal(m.send(Events.INGEST_DOWN).to, States.INTRO);

  c.advance(2000); // zökkenő
  m.send(Events.INGEST_UP);
  c.advance(10 * 1000); // további 10 mp élő → összesen 2:05

  assert.equal(
    m.send(Events.INGEST_DOWN).to,
    States.RECONNECTING,
    'az összegzett élő idő átlépte a 2 percet',
  );
});

test('reconnecting → visszatér a stream → live', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  c.advance(3 * MINUTE);
  m.send(Events.INGEST_DOWN);

  assert.equal(m.state, States.RECONNECTING);
  assert.equal(m.send(Events.INGEST_UP).to, States.LIVE);
});

// ---------------------------------------------------------------------------
// paused — a szegmens legfontosabb elhatárolása
// ---------------------------------------------------------------------------

test('Szünet bármikor előidézhető, időtartam-küszöb NÉLKÜL', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  c.advance(3000); // 3 másodperc élő adás

  const r = m.send(Events.SESSION_PAUSE);
  assert.equal(r.to, States.PAUSED);
  assert.equal(m.context.pauses, 1);
  assert.equal(screenFor(m.state), 'interrupted', 'vizuálisan ugyanaz, mint a reconnecting');
});

test('szünet közben az ingest-jelzések NEM váltanak állapotot', () => {
  const m = machineAt(clock());
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  m.send(Events.SESSION_PAUSE);

  const down = m.send(Events.INGEST_DOWN);
  assert.equal(down.changed, false);
  assert.equal(m.state, States.PAUSED);

  const up = m.send(Events.INGEST_UP);
  assert.equal(up.changed, false, 'a stream visszatérése sem hozza vissza live-ba');
  assert.equal(m.state, States.PAUSED);
});

test('Folytatás élő ingest mellett → azonnal live', () => {
  const m = machineAt(clock());
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  m.send(Events.SESSION_PAUSE);
  m.send(Events.INGEST_UP); // a telefon már küld, de az állapot paused maradt

  assert.equal(m.send(Events.SESSION_RESUME).to, States.LIVE);
});

test('Folytatás, ha a stream még nem tért vissza — ugyanaz a 2 perces szabály dönt', () => {
  const short = clock();
  const a = machineAt(short);
  a.send(Events.SESSION_START);
  a.send(Events.INGEST_UP);
  short.advance(30 * 1000);
  a.send(Events.SESSION_PAUSE);
  a.send(Events.INGEST_DOWN);
  assert.equal(a.send(Events.SESSION_RESUME).to, States.INTRO);
  assert.equal(a.context.resumePending, true);

  const long = clock();
  const b = machineAt(long);
  b.send(Events.SESSION_START);
  b.send(Events.INGEST_UP);
  long.advance(5 * MINUTE);
  b.send(Events.SESSION_PAUSE);
  b.send(Events.INGEST_DOWN);
  assert.equal(b.send(Events.SESSION_RESUME).to, States.RECONNECTING);
});

test('szünet közben nem telik a live idő', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  c.advance(60 * 1000); // 1 perc élő

  m.send(Events.SESSION_PAUSE);
  // A telefon szünetkor lezárja a WHIP sessiont, tehát az ingest leáll.
  // Az állapotot ez NEM változtatja (marad paused), de a jelzést nyilvántartjuk.
  m.send(Events.INGEST_DOWN);
  c.advance(10 * MINUTE); // 10 perc szünet

  m.send(Events.SESSION_RESUME); // ingest nem élő → intro (1 perc < 2 perc)
  assert.equal(m.state, States.INTRO);
  assert.equal(m.liveElapsedMs(), 60 * 1000, 'a szünet ideje nem számít bele');
});

// ---------------------------------------------------------------------------
// outro / ended
// ---------------------------------------------------------------------------

test('Befejezés → outro időzítővel, majd ended leállítás-kéréssel', () => {
  const m = machineAt(clock());
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);

  const end = m.send(Events.SESSION_END);
  assert.equal(end.to, States.OUTRO);
  assert.ok(end.effects.some((e) => e.type === Effects.START_OUTRO_TIMER));

  const done = m.send(Events.OUTRO_DONE);
  assert.equal(done.to, States.ENDED);
  assert.ok(done.effects.some((e) => e.type === Effects.SHUTDOWN));
  assert.equal(screenFor(m.state), 'blank');
});

test('Befejezés szünetből és megszakadásból is működik', () => {
  const fromPaused = machineAt(clock());
  fromPaused.send(Events.SESSION_START);
  fromPaused.send(Events.INGEST_UP);
  fromPaused.send(Events.SESSION_PAUSE);
  assert.equal(fromPaused.send(Events.SESSION_END).to, States.OUTRO);

  const c = clock();
  const fromReconnecting = machineAt(c);
  fromReconnecting.send(Events.SESSION_START);
  fromReconnecting.send(Events.INGEST_UP);
  c.advance(3 * MINUTE);
  fromReconnecting.send(Events.INGEST_DOWN);
  assert.equal(fromReconnecting.send(Events.SESSION_END).to, States.OUTRO);
});

test('outro közbeni Kezdés megszakítja az outrót és új sessiont indít', () => {
  const m = machineAt(clock());
  m.send(Events.SESSION_START);
  m.send(Events.SESSION_END);

  const restart = m.send(Events.SESSION_START);
  assert.equal(restart.to, States.INTRO);
  assert.ok(restart.effects.some((e) => e.type === Effects.CANCEL_OUTRO_TIMER));
  assert.equal(m.context.sessionCount, 2);
  assert.equal(m.context.isFirstStartSinceBoot, false);
});

test('a második session live ideje nulláról indul', () => {
  const c = clock();
  const m = machineAt(c);
  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  c.advance(10 * MINUTE);
  m.send(Events.SESSION_END);
  m.send(Events.OUTRO_DONE);

  m.send(Events.SESSION_START);
  m.send(Events.INGEST_UP);
  c.advance(30 * 1000);

  assert.equal(m.liveElapsedMs(), 30 * 1000);
  assert.equal(m.send(Events.INGEST_DOWN).to, States.INTRO, 'új session, új számítás');
});

test('introOnEveryStart=false esetén a második indítás nem játssza le az intro médiát', () => {
  const m = machineAt(clock(), { introOnEveryStart: false });
  m.send(Events.SESSION_START);
  assert.equal(m.context.playIntroMedia, true);

  m.send(Events.SESSION_END);
  m.send(Events.OUTRO_DONE);
  m.send(Events.SESSION_START);

  assert.equal(m.state, States.INTRO, 'fekete kép helyett akkor is intro állapot');
  assert.equal(m.context.playIntroMedia, false);
});

// ---------------------------------------------------------------------------
// érvénytelen átmenetek
// ---------------------------------------------------------------------------

test('érvénytelen események nem törnek el semmit', () => {
  const m = machineAt(clock());

  assert.equal(m.send(Events.SESSION_PAUSE).changed, false);
  assert.equal(m.send(Events.SESSION_RESUME).changed, false);
  assert.equal(m.send(Events.SESSION_END).changed, false);
  assert.equal(m.send(Events.OUTRO_DONE).changed, false);
  assert.equal(m.send(Events.INGEST_UP).changed, false);
  assert.equal(m.state, States.IDLE);

  m.send(Events.SESSION_START);
  assert.equal(m.send(Events.SESSION_START).changed, false, 'dupla Kezdés nem indít újra');
  assert.equal(m.context.sessionCount, 1);
});

test('minden állapotnak van képernyő-leképezése', () => {
  for (const state of Object.values(States)) {
    assert.ok(screenFor(state), `hiányzó képernyő: ${state}`);
  }
  assert.equal(screenFor(States.PAUSED), screenFor(States.RECONNECTING));
});
