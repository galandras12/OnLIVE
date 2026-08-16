/**
 * Streamkulcs: szabályok, generálás, hash-elt tárolás (1.0.010).
 *
 * A lényeg, amit ezek a tesztek őriznek: a kulcs SOSEM kerül nyersen lemezre,
 * a követelmények kikényszerítettek, és a generált kulcs sem lehet gyengébb,
 * mint amit kézzel elfogadnánk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  KEY_POLICY, StreamKeyStore, assessStreamKey, generateStreamKey, keyRules,
} from '../src/security/stream-key.js';

const dataDir = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

// ---------------------------------------------------------------------------
// Követelmények
// ---------------------------------------------------------------------------

test('a követelmény mind a négy karakterosztályt és a hosszt kéri', () => {
  const ids = keyRules().map((rule) => rule.id);
  assert.deepEqual(ids, ['hossz', 'kisbetu', 'nagybetu', 'szam', 'specialis']);
  assert.equal(KEY_POLICY.minLength, 16);
});

test('a szabályos kulcs átmegy', () => {
  const assessment = assessStreamKey('Adas-Kulcs-2026!x');
  assert.equal(assessment.ok, true);
  assert.ok(assessment.checks.every((check) => check.ok));
});

test('minden hiányzó követelményt külön jelez', () => {
  const cases = {
    'Rovid1!a': 'hossz',
    'NAGYBETUS-KULCS-123!': 'kisbetu',
    'kisbetus-kulcs-123!x': 'nagybetu',
    'Kisbetus-Kulcsxxxxx!': 'szam',
    'KisbetusKulcs123456x': 'specialis',
  };

  for (const [key, expected] of Object.entries(cases)) {
    const assessment = assessStreamKey(key);
    assert.equal(assessment.ok, false, `"${key}" nem lehet érvényes`);

    const failed = assessment.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.deepEqual(failed, [expected], `"${key}" → csak a(z) ${expected} bukjon`);
    assert.match(assessment.error, /Hiányzik/);
  }
});

test('a 16 karakter a határ, nem a 15', () => {
  assert.equal(assessStreamKey('Adas-Kulcs2026!').ok, false, '15 karakter kevés');
  assert.equal(assessStreamKey('Adas-Kulcs2026!x').ok, true, '16 karakter elég');
});

test('szóköz és üres érték nem fogadható el', () => {
  assert.equal(assessStreamKey('Adas Kulcs 2026!x').ok, false, 'HTTP fejlécben utazik');
  assert.equal(assessStreamKey('').ok, false);
  assert.equal(assessStreamKey(null).ok, false);
  assert.equal(assessStreamKey('A1!a'.repeat(40)).ok, false, 'a túl hosszú sem jó');
});

// ---------------------------------------------------------------------------
// Generálás
// ---------------------------------------------------------------------------

test('a generált kulcs mindig megfelel a saját követelményeinknek', () => {
  for (let i = 0; i < 300; i += 1) {
    const key = generateStreamKey(KEY_POLICY.minLength);
    assert.equal(assessStreamKey(key).ok, true, `bukott kulcs: ${key}`);
  }
});

test('a generált kulcsok különböznek, és a hossz kérhető', () => {
  assert.notEqual(generateStreamKey(), generateStreamKey());
  assert.equal(generateStreamKey(48).length, 48);
  assert.equal(generateStreamKey(4).length, KEY_POLICY.minLength, 'a minimumnál rövidebbet nem adunk');
});

test('a kötelező karakterek nem mindig ugyanott állnak', () => {
  // Kevert generálás nélkül az első négy karakter osztálya fix lenne, ami
  // szűkítené a keresési teret.
  const firstChars = new Set(Array.from({ length: 50 }, () => generateStreamKey()[0]));
  assert.ok(firstChars.size > 5, 'az első karakter változatos');
});

// ---------------------------------------------------------------------------
// Tárolás
// ---------------------------------------------------------------------------

test('BIZTONSÁG: a kulcs nyersen SOSEM kerül a lemezre', async (t) => {
  const dir = await dataDir(t);
  const store = new StreamKeyStore({ dataDir: dir });
  await store.ready;

  const key = 'Titkos-Kulcs-2026!';
  await store.set(key, { by: '192.168.0.31', origin: 'kezi' });

  const raw = await readFile(path.join(dir, 'stream-key.json'), 'utf8');
  assert.ok(!raw.includes(key), 'a nyers kulcs nem lehet a fájlban');
  assert.match(JSON.parse(raw).hash, /^scrypt\$/);

  // Részlet sem: ujjlenyomat vagy „emlékeztető" nélkül tárolunk.
  assert.ok(!raw.includes(key.slice(0, 6)), 'még részlet sem kerülhet bele');
});

test('a beállított kulcs ellenőrizhető, a rossz nem', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t) });
  await store.ready;
  await store.set('Adas-Kulcs-2026!x');

  assert.equal(store.verify('Adas-Kulcs-2026!x'), true);
  assert.equal(store.verify('Adas-Kulcs-2026!X'), false, 'kis-nagybetű számít');
  assert.equal(store.verify(''), false);
  assert.equal(store.verify(null), false);
});

test('a követelménynek nem megfelelő kulcs nem állítható be', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t) });
  await store.ready;

  await assert.rejects(() => store.set('rovid'), /Hiányzik/);
  assert.equal(store.configured, false, 'a bukott kísérlet nem hagy nyomot');
});

test('az új kulcs azonnal érvényteleníti a régit', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t) });
  await store.ready;

  await store.set('Regi-Kulcs-2026!x');
  assert.equal(store.verify('Regi-Kulcs-2026!x'), true, 'a gyorsítótár is feltöltődik');

  await store.set('Uj-Kulcs-2026!xyz');
  assert.equal(store.verify('Regi-Kulcs-2026!x'), false, 'a régi kulcs nem maradhat érvényes');
  assert.equal(store.verify('Uj-Kulcs-2026!xyz'), true);
  assert.equal(store.status().rotations, 2);
});

test('a kulcs túléli az újraindítást', async (t) => {
  const dir = await dataDir(t);
  const first = new StreamKeyStore({ dataDir: dir });
  await first.ready;
  await first.set('Adas-Kulcs-2026!x', { origin: 'generalt' });

  const second = new StreamKeyStore({ dataDir: dir });
  await second.ready;

  assert.equal(second.verify('Adas-Kulcs-2026!x'), true);
  assert.equal(second.status().origin, 'generalt');
  assert.equal(second.status().source, 'felulet');
});

test('a .env-ből örökölt kulcs tartalékként működik, de jelzi magát', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t), fallbackKey: 'regi-env-kulcs' });
  await store.ready;

  assert.equal(store.verify('regi-env-kulcs'), true, 'a meglévő telepítés nem törik el');
  assert.equal(store.status().legacy, true, 'a felület javasolja a cserét');

  // A felületen létrehozott kulcs elsőbbséget élvez.
  await store.set('Adas-Kulcs-2026!x');
  assert.equal(store.verify('regi-env-kulcs'), false, 'a .env tartalék ilyenkor már nem él');
  assert.equal(store.status().legacy, false);
});

test('az állapot semmilyen formában nem adja ki a kulcsot', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t) });
  await store.ready;
  await store.set('Adas-Kulcs-2026!x', { by: '10.0.0.5' });

  const status = JSON.stringify(store.status());
  assert.ok(!status.includes('Adas-Kulcs'), 'a kulcs nem szerepelhet az állapotban');
  assert.ok(!status.includes('scrypt'), 'a hash sem megy ki a felületre');
  assert.equal(store.status().createdBy, '10.0.0.5');
});

test('a visszavont kulcs után nincs hitelesítés', async (t) => {
  const store = new StreamKeyStore({ dataDir: await dataDir(t) });
  await store.ready;
  await store.set('Adas-Kulcs-2026!x');

  await store.clear();
  assert.equal(store.verify('Adas-Kulcs-2026!x'), false);
  assert.equal(store.configured, false);
});
