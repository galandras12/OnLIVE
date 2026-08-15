/**
 * Az egységes, strukturált naplózó tesztjei (11. szegmens).
 *
 * A napló utólag ez alapján rekonstruálja az adást, ezért három dolognak
 * mindig igaznak kell lennie: a sor tényleg KIÍRÓDIK, gépi feldolgozásra
 * alkalmas (egy sor = egy JSON), és nem szivárogtat hitelesítő adatot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Logger, LogEvent, Source, clientId, describeChanges, diffSettings } from '../src/log/logger.js';

/** Naplózó ideiglenes könyvtárban, konzol-zaj nélkül. */
async function makeLogger(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, logger: new Logger({ logDir: dir, console: false }) };
}

const readLines = async (dir) => {
  const day = new Date().toISOString().slice(0, 10);
  const content = await readFile(path.join(dir, `${day}.log`), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line));
};

test('minden esemény egy önálló JSON sor, forrással és klienssel', async (t) => {
  const { dir, logger } = await makeLogger(t);

  logger.event({
    type: LogEvent.STATE,
    level: 'state',
    source: Source.PHONE,
    client: '192.168.0.31',
    message: 'live → outro',
    from: 'live',
    to: 'outro',
  });
  logger.warn('Figyelmeztetés');

  await new Promise((resolve) => logger.close(resolve));
  const lines = await readLines(dir);

  assert.equal(lines.length, 2, 'soronként egy esemény');
  assert.equal(lines[0].type, LogEvent.STATE);
  assert.equal(lines[0].source, Source.PHONE);
  assert.equal(lines[0].client, '192.168.0.31');
  assert.equal(lines[0].to, 'outro', 'a saját mezők is megmaradnak');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/, 'ISO időbélyeg');
  assert.equal(lines[1].level, 'warn');
});

test('REGRESSZIÓ: a close() kiírja a pufferben maradt sorokat', async (t) => {
  const { dir, logger } = await makeLogger(t);

  // A leállási sorok pont a folyamat vége előtt keletkeznek. A fájlfolyam
  // pufferel, ezért ezeket egy azonnali process.exit eldobná — a close()
  // dolga megvárni a kiírást.
  for (let i = 0; i < 50; i += 1) logger.info(`sor ${i}`);
  logger.warn('SIGTERM — leállás…');

  await new Promise((resolve) => logger.close(resolve));

  const lines = await readLines(dir);
  assert.equal(lines.length, 51);
  assert.equal(lines.at(-1).message, 'SIGTERM — leállás…', 'az utolsó sor sem veszhet el');
});

test('a close() üres naplózóra is visszahív', async () => {
  const logger = new Logger({ console: false });
  await new Promise((resolve) => logger.close(resolve));
});

// ---------------------------------------------------------------------------
// Beállítás-változások
// ---------------------------------------------------------------------------

test('a diff csak a tényleges változást adja vissza, régi → új értékkel', () => {
  const changes = diffSettings(
    { fps: 30, bitrate: 6000, lens: 'main' },
    { fps: 60, bitrate: 6000, lens: 'main' },
  );

  assert.deepEqual(changes, { fps: { regi: 30, uj: 60 } });
  assert.equal(describeChanges(changes), 'fps: 30 → 60');
});

test('a nem küldött mező nem számít változásnak', () => {
  assert.equal(diffSettings({ fps: 30, lens: 'main' }, { fps: 30 }), null);
});

test('az objektum értékű mezőt tartalom szerint hasonlítja', () => {
  const audio = { sampleRate: 48000, bitrateKbps: 128 };
  assert.equal(diffSettings({ audio }, { audio: { ...audio } }), null, 'azonos tartalom nem változás');
  assert.ok(diffSettings({ audio }, { audio: { ...audio, bitrateKbps: 64 } }), 'eltérő tartalom igen');
});

test('a hiányzó régi érték „–"-ként olvasható', () => {
  const changes = diffSettings({}, { lencse: 'tele' });
  assert.deepEqual(changes, { lencse: { regi: null, uj: 'tele' } });
  assert.equal(describeChanges(changes), 'lencse: – → tele');
});

// ---------------------------------------------------------------------------
// Kliens-azonosítás
// ---------------------------------------------------------------------------

test('BIZTONSÁG: a kliens-azonosítóba a teljes munkamenet-token nem kerül bele', () => {
  const token = 'sup3r-titk0s-munkamenet-token-ertek';
  const id = clientId({ ip: '192.168.0.31', adminSession: { token } });

  assert.ok(!id.includes(token), 'a teljes token soha nem naplózható');
  assert.equal(id, `192.168.0.31/${token.slice(0, 6)}`);
  assert.equal(clientId({ ip: '10.0.0.2' }), '10.0.0.2', 'munkamenet nélkül csak az IP');
  assert.equal(clientId({}), 'ismeretlen');
});
