/**
 * Média-validáció és -tár tesztek (5. szegmens).
 *
 * A hangsúly a validáción van: ez az a réteg, ami megakadályozza, hogy a
 * `/live` oldalba — és ezzel az OBS-be — nem médiafájl kerüljön.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sniffMimeType, validateMedia } from '../src/media/validate.js';
import { MediaStore } from '../src/media/store.js';

// --- minta fejlécek (magic bytes) -------------------------------------------

const pad = (header, size = 64) => Buffer.concat([Buffer.from(header), Buffer.alloc(size)]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64),
]);
const MP4 = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftyp', 'latin1'),
  Buffer.from('isom', 'latin1'),
  Buffer.alloc(64),
]);
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '), 'utf8');

// --- felismerés --------------------------------------------------------------

test('a magic bytes alapján felismeri az engedélyezett típusokat', () => {
  assert.equal(sniffMimeType(JPEG), 'image/jpeg');
  assert.equal(sniffMimeType(PNG), 'image/png');
  assert.equal(sniffMimeType(WEBP), 'image/webp');
  assert.equal(sniffMimeType(MP4), 'video/mp4');
  assert.equal(sniffMimeType(WEBM), 'video/webm');
});

test('ismeretlen tartalomra null', () => {
  assert.equal(sniffMimeType(HTML), null);
  assert.equal(sniffMimeType(Buffer.alloc(4)), null);
});

// --- validáció ---------------------------------------------------------------

test('érvényes feltöltés átmegy, és megadja a fajtát', () => {
  const image = validateMedia({ originalname: 'intro.png', mimetype: 'image/png', buffer: PNG });
  assert.equal(image.ok, true);
  assert.equal(image.kind, 'image');
  assert.equal(image.ext, '.png');

  const video = validateMedia({ originalname: 'outro.mp4', mimetype: 'video/mp4', buffer: MP4 });
  assert.equal(video.ok, true);
  assert.equal(video.kind, 'video');
});

test('BIZTONSÁG: az mp4-nek álcázott HTML elbukik', () => {
  const result = validateMedia({
    originalname: 'intro.mp4',
    mimetype: 'video/mp4',
    buffer: HTML,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /nem ismerhető fel/i);
});

test('BIZTONSÁG: a hamis Content-Type elbukik, ha nem egyezik a tartalommal', () => {
  const result = validateMedia({
    originalname: 'kep.png',
    mimetype: 'image/png',
    buffer: MP4, // valójában videó
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /nem egyezik/i);
});

test('az image/jpg és image/jpeg eltérés nem hiba', () => {
  const result = validateMedia({ originalname: 'a.jpg', mimetype: 'image/jpg', buffer: JPEG });
  assert.equal(result.ok, true);
});

test('a méretkorlát érvényesül', () => {
  const result = validateMedia({ originalname: 'a.png', mimetype: 'image/png', buffer: PNG }, 10);
  assert.equal(result.ok, false);
  assert.match(result.error, /túl nagy/i);
});

test('üres fájl elbukik', () => {
  const result = validateMedia({ originalname: 'a.png', mimetype: 'image/png', buffer: Buffer.alloc(0) });
  assert.equal(result.ok, false);
});

// --- tár ---------------------------------------------------------------------

test('a médiatár slotonként egy fájlt tart, és a régit törli', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new MediaStore({ dataDir: dir, logger: null });
  await store.ready;

  await store.setSlot('intro', {
    buffer: PNG, mime: 'image/png', kind: 'image', ext: '.png', originalName: 'elso.png',
  });
  let files = await readdir(path.join(dir, 'media'));
  assert.equal(files.length, 1);

  await store.setSlot('intro', {
    buffer: JPEG, mime: 'image/jpeg', kind: 'image', ext: '.jpg', originalName: 'masodik.jpg',
  });
  files = await readdir(path.join(dir, 'media'));
  assert.equal(files.length, 1, 'a régi fájl törlődik');
  assert.equal(store.manifest().slots.intro.originalName, 'masodik.jpg');

  await store.clearSlot('intro');
  files = await readdir(path.join(dir, 'media'));
  assert.equal(files.length, 0);
  assert.equal(store.manifest().slots.intro, null);
});

test('az outro alapból nem ismétlődik, az intro igen', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new MediaStore({ dataDir: dir, logger: null });
  await store.ready;

  await store.setSlot('outro', { buffer: MP4, mime: 'video/mp4', kind: 'video', ext: '.mp4', originalName: 'o.mp4' });
  await store.setSlot('intro', { buffer: WEBM, mime: 'video/webm', kind: 'video', ext: '.webm', originalName: 'i.webm' });

  const manifest = store.manifest();
  assert.equal(manifest.slots.outro.options.loop, false);
  assert.equal(manifest.slots.intro.options.loop, true);
});

test('az outro hossza validált, és ezredmásodpercben is elérhető', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new MediaStore({ dataDir: dir, logger: null });
  await store.ready;

  assert.equal(store.outroDurationMs(), 15_000, 'alapértelmezés 15 mp');

  await store.setOutroDuration(30);
  assert.equal(store.outroDurationMs(), 30_000);

  await assert.rejects(() => store.setOutroDuration(0));
  await assert.rejects(() => store.setOutroDuration(9999));
  await assert.rejects(() => store.setOutroDuration('sok'));
});

test('a beállítások túlélik az újratöltést', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = new MediaStore({ dataDir: dir, logger: null });
  await first.ready;
  await first.setSlot('interrupted', {
    buffer: WEBP, mime: 'image/webp', kind: 'image', ext: '.webp', originalName: 'megszakadt.webp',
  });
  await first.setSlotOptions('interrupted', { fit: 'contain' });
  await first.setOutroDuration(42);

  const second = new MediaStore({ dataDir: dir, logger: null });
  await second.ready;
  const manifest = second.manifest();

  assert.equal(manifest.slots.interrupted.originalName, 'megszakadt.webp');
  assert.equal(manifest.slots.interrupted.options.fit, 'contain');
  assert.equal(manifest.settings.outroDurationSeconds, 42);
});
