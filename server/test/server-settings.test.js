/**
 * Szerver-beállítások: a port forrása, ellenőrzése és tárolása (1.0.011).
 *
 * A lényeg, amit ezek őriznek: a felületen beállított érték erősebb a
 * környezeti változónál, a hibás érték nem menthető, és a változás csak a
 * KÖVETKEZŐ indításkor számít — futó szervert nem rántunk ki a portja alól.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PORT, ServerSettingsStore, assessPort, readServerSettingsSync, resolvePort,
} from '../src/settings/store.js';
import { checkPortDependencies, describeMismatch } from '../src/settings/dependencies.js';

const dataDir = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-srv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// Forrás-sorrend
// ---------------------------------------------------------------------------

test('az alapértelmezett port 8080', () => {
  assert.equal(DEFAULT_PORT, 8080);
  assert.deepEqual(resolvePort({}), { port: 8080, source: 'alapertelmezes' });
});

test('a környezeti változó felülírja az alapértelmezést', () => {
  assert.deepEqual(resolvePort({ env: '9000' }), { port: 9000, source: 'env' });
});

test('a felületen beállított érték erősebb a környezeti változónál', () => {
  // Ez szándékos: a `.env` egyszer, telepítéskor íródik, a felületen viszont
  // az üzemeltető tudatosan, most állít. Fordítva a gomb néma maradna
  // mindenkinél, aki a sablon .env-et használja.
  assert.deepEqual(resolvePort({ stored: 9100, env: '9000' }), { port: 9100, source: 'felulet' });
});

test('az értelmezhetetlen érték nem üti ki a következő forrást', () => {
  assert.deepEqual(resolvePort({ stored: 'nem-szam', env: '9000' }), { port: 9000, source: 'env' });
  assert.deepEqual(resolvePort({ stored: 0, env: '70000' }), { port: 8080, source: 'alapertelmezes' });
});

// ---------------------------------------------------------------------------
// Ellenőrzés
// ---------------------------------------------------------------------------

test('érvényes port elfogadva', () => {
  const result = assessPort('8080');
  assert.equal(result.ok, true);
  assert.equal(result.port, 8080);
  assert.equal(result.warning, undefined);
});

test('érvénytelen értékek elutasítva', () => {
  assert.equal(assessPort('').ok, false);
  assert.equal(assessPort('nyolcvan').ok, false);
  assert.equal(assessPort('8080abc').ok, false);
  assert.equal(assessPort('0').ok, false);
  assert.equal(assessPort('65536').ok, false);
  assert.equal(assessPort('-1').ok, false);
  assert.match(assessPort('65536').error, /1 és 65535/);
});

test('a kockázatos portokat elfogadjuk, de figyelmeztetünk', () => {
  const privileged = assessPort('80');
  assert.equal(privileged.ok, true, 'nem tiltjuk — van, aki tudatosan tesz 80-at');
  assert.match(privileged.warning, /emelt jogosultság/);

  const busy = assessPort('9997');   // a MediaMTX API portja
  assert.equal(busy.ok, true);
  assert.match(busy.warning, /EADDRINUSE/);
});

// ---------------------------------------------------------------------------
// Tárolás
// ---------------------------------------------------------------------------

test('a beállított port túléli az újraindítást', async (t) => {
  const dir = await dataDir(t);

  const first = new ServerSettingsStore({ dataDir: dir });
  await first.setPort(9100, { by: '192.168.0.31' });

  // Új példány = új indulás.
  const second = new ServerSettingsStore({ dataDir: dir });
  assert.equal(second.configured.port, 9100);
  assert.equal(second.configured.source, 'felulet');
  assert.equal(second.status().updatedBy, '192.168.0.31');

  // Ugyanezt látja a konfiguráció szinkron olvasója is.
  assert.equal(readServerSettingsSync(dir).port, 9100);
});

test('a hibás port nem menthető', async (t) => {
  const store = new ServerSettingsStore({ dataDir: await dataDir(t) });
  await assert.rejects(() => store.setPort('70000'), /1 és 65535/);
  assert.equal(store.configured.port, DEFAULT_PORT, 'a bukott kísérlet nem hagy nyomot');
});

test('a változás csak a KÖVETKEZŐ indításkor él', async (t) => {
  const store = new ServerSettingsStore({ dataDir: await dataDir(t) });
  await store.setPort(9100);

  // A futó szerver továbbra is a 8080-on hallgat.
  const status = store.status(8080);
  assert.equal(status.runningPort, 8080);
  assert.equal(status.port, 9100);
  assert.equal(status.restartRequired, true, 'a felület újraindítást kér');

  const afterRestart = store.status(9100);
  assert.equal(afterRestart.restartRequired, false);
});

test('a visszaállítás után a környezeti változó vagy az alapértelmezés jön', async (t) => {
  const store = new ServerSettingsStore({ dataDir: await dataDir(t), envPort: '9000' });
  await store.setPort(9100);
  assert.equal(store.status().envOverridden, true, 'a felület jelzi, hogy elnyomja az env-et');

  await store.clearPort();
  assert.equal(store.configured.port, 9000);
  assert.equal(store.configured.source, 'env');
});

test('a tárolt fájl olvasható marad és nem tartalmaz mást', async (t) => {
  const dir = await dataDir(t);
  const store = new ServerSettingsStore({ dataDir: dir });
  await store.setPort(9100, { by: 'teszt' });

  const parsed = JSON.parse(await readFile(path.join(dir, 'server.json'), 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['port', 'updatedAt', 'updatedBy']);
  assert.equal(parsed.port, 9100);
});

test('a sérült beállítás-fájl nem akadályozza az indulást', async (t) => {
  const dir = await dataDir(t);
  await writeFile(path.join(dir, 'server.json'), '{ ez nem json', 'utf8');

  assert.deepEqual(readServerSettingsSync(dir), {});
  assert.equal(new ServerSettingsStore({ dataDir: dir }).configured.port, DEFAULT_PORT);
});

// ---------------------------------------------------------------------------
// Függőségek: a tunnel és a MediaMTX ugyanarra a portra mutat-e
// ---------------------------------------------------------------------------

test('a portra mutató szomszédos konfigurációk eltérése kiderül', async (t) => {
  const dir = await dataDir(t);
  const mediamtx = path.join(dir, 'mediamtx.yml');
  await writeFile(mediamtx, 'authMethod: http\nauthHTTPAddress: http://127.0.0.1:3000/api/ingest/auth\n');

  const [check] = checkPortDependencies(8080, { mediamtxConfig: mediamtx, repoRoot: dir });

  assert.equal(check.id, 'mediamtx');
  assert.equal(check.ok, false, 'a 3000 nem egyezik a 8080-nal');
  assert.deepEqual(check.found, [3000]);
  assert.match(describeMismatch(check), /még a 3000 portra mutat/);
});

test('egyező port esetén nincs panasz', async (t) => {
  const dir = await dataDir(t);
  const mediamtx = path.join(dir, 'mediamtx.yml');
  await writeFile(mediamtx, 'authHTTPAddress: http://127.0.0.1:8080/api/ingest/auth\n');

  const [check] = checkPortDependencies(8080, { mediamtxConfig: mediamtx, repoRoot: dir });
  assert.equal(check.ok, true);
});

test('a cloudflared konfigurációjából a service sorok számítanak', async (t) => {
  const dir = await dataDir(t);
  const tunnelDir = path.join(dir, 'infra', 'cloudflared');
  await rm(tunnelDir, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(tunnelDir, { recursive: true });
  await writeFile(path.join(tunnelDir, 'config.yml'),
    'ingress:\n  - hostname: admin.example.com\n    service: http://localhost:8080\n'
    + '  - hostname: ingest.example.com\n    service: http://localhost:8889\n');

  const checks = checkPortDependencies(8080, { repoRoot: dir });
  const tunnel = checks.find((check) => check.id === 'cloudflared');

  assert.ok(tunnel, 'megtalálja a repóbeli konfigurációt');
  assert.equal(tunnel.ok, true, 'a 8080 szerepel benne');
  assert.ok(tunnel.found.includes(8889), 'a többi service portot is kigyűjti');
});

test('hiányzó fájlokra nem panaszkodunk', () => {
  assert.deepEqual(
    checkPortDependencies(8080, { mediamtxConfig: '/nincs/ilyen.yml', repoRoot: '/nincs/ilyen' }),
    [],
  );
});
