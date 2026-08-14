/**
 * Overlay-tár tesztek (6. szegmens).
 *
 * A hangsúly a normalizáláson van: a `/live` oldal — és ezzel az OBS —
 * sosem kaphat hiányos vagy értelmezhetetlen widgetet, mert egy hibás
 * elem adás közben törné el a kompozit réteget.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { OverlayStore, CANVAS } from '../src/overlay/store.js';

/** Minimális, érvényes PNG fejléc a képfeltöltés-tesztekhez. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

async function store(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-overlay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const instance = new OverlayStore({ dataDir: dir, logger: null });
  await instance.ready;
  return { instance, dir };
}

test('üres elrendezéssel indul, és a vászon fix 1920×1080', async (t) => {
  const { instance } = await store(t);
  const manifest = instance.manifest();

  assert.deepEqual(manifest.widgets, []);
  assert.equal(manifest.canvas.width, 1920);
  assert.equal(manifest.canvas.height, 1080);
});

test('ismeretlen típusú widget kiesik', async (t) => {
  const { instance } = await store(t);
  const manifest = await instance.replaceAll([
    { id: 'a', type: 'nemletezo' },
    { id: 'b', type: 'text', data: { text: 'ok' } },
  ]);
  assert.equal(manifest.widgets.length, 1);
  assert.equal(manifest.widgets[0].type, 'text');
});

test('a hiányos és hibás értékek épeszű alakra állnak', async (t) => {
  const { instance } = await store(t);
  const [widget] = (await instance.replaceAll([
    { id: 'x', type: 'text', x: 'NaN', y: undefined, width: -100, opacity: 5, data: { text: 'szia' } },
  ])).widgets;

  assert.equal(widget.x, 0, 'értelmezhetetlen koordináta → 0');
  assert.equal(widget.y, 0);
  assert.equal(widget.width, 24, 'a szélesség nem lehet negatív (24 px a minimum)');
  assert.equal(widget.opacity, 1, 'az átlátszóság 0 és 1 közé szorul');
  assert.equal(widget.visible, true, 'alapból látható');
  assert.deepEqual(widget.screens, [], 'képernyő-szűrő nélkül mindenhol látszik');
});

test('a képernyő-szűrő megmarad', async (t) => {
  const { instance } = await store(t);
  const [widget] = (await instance.replaceAll([
    { id: 'n', type: 'notification', screens: ['live', 'intro'], data: { text: 'hír' } },
  ])).widgets;
  assert.deepEqual(widget.screens, ['live', 'intro']);
});

test('egyetlen widget mozgatása nem érinti a többit', async (t) => {
  const { instance } = await store(t);
  await instance.replaceAll([
    { id: 'logo', type: 'logo', x: 10, y: 10, data: { url: '/media/intro' } },
    { id: 'chat', type: 'text', x: 500, y: 500, data: { text: 'chat' } },
  ]);

  const moved = await instance.update('logo', { x: 1700, y: 40 });
  assert.equal(moved.x, 1700);
  assert.equal(moved.y, 40);
  assert.equal(moved.type, 'logo', 'a típust a mozgatás nem írhatja át');
  assert.equal(moved.data.url, '/media/intro', 'a tartalom megmarad');

  const chat = instance.widgets.find((w) => w.id === 'chat');
  assert.equal(chat.x, 500);
});

test('a típus mozgatáskor nem hamisítható át', async (t) => {
  const { instance } = await store(t);
  await instance.replaceAll([{ id: 'logo', type: 'logo', data: { url: '/x' } }]);
  const patched = await instance.update('logo', { type: 'notification', x: 5 });
  assert.equal(patched.type, 'logo');
});

test('nem létező widget módosítása hibát ad', async (t) => {
  const { instance } = await store(t);
  await assert.rejects(() => instance.update('nincs-ilyen', { x: 1 }));
});

test('az elrendezés túléli az újratöltést', async (t) => {
  const { instance, dir } = await store(t);
  await instance.replaceAll([{ id: 'logo', type: 'logo', x: 42, y: 24, data: { url: '/media/intro' } }]);

  const reloaded = new OverlayStore({ dataDir: dir, logger: null });
  await reloaded.ready;
  const [widget] = reloaded.widgets;

  assert.equal(widget.id, 'logo');
  assert.equal(widget.x, 42);
  assert.equal(widget.y, 24);
});

test('a koordináták a vászon körül ésszerű határok közt maradnak', async (t) => {
  const { instance } = await store(t);
  const [widget] = (await instance.replaceAll([
    { id: 'x', type: 'text', x: 999_999, y: -999_999, data: { text: 'a' } },
  ])).widgets;

  assert.ok(widget.x <= CANVAS.width * 2);
  assert.ok(widget.y >= -CANVAS.height);
});

// ---------------------------------------------------------------------------
// 7. szegmens: widget-kezelés és a beágyazások biztonsága
// ---------------------------------------------------------------------------

test('a létrehozott widget azonosítóját a szerver adja, nem a kliens', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ id: 'sajat-id', type: 'text', data: { text: 'a' } });

  assert.notEqual(widget.id, 'sajat-id');
  assert.match(widget.id, /^text-[0-9a-f]+$/);
});

test('törléskor a widget és a képe is eltűnik', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ type: 'logo' });
  await instance.setImage(widget.id, {
    buffer: PNG, ext: '.png', mime: 'image/png', originalName: 'logo.png',
  });

  assert.ok(instance.assetPath(widget.id));
  await instance.remove(widget.id);
  assert.equal(instance.find(widget.id), null);
});

test('képet csak logó widgethez lehet feltölteni', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ type: 'text', data: { text: 'a' } });
  await assert.rejects(
    () => instance.setImage(widget.id, { buffer: PNG, ext: '.png', mime: 'image/png', originalName: 'x.png' }),
    /csak logó/i,
  );
});

test('BIZTONSÁG: a beágyazás HTML-je nem kerül bele a /live manifestbe', async (t) => {
  const { instance } = await store(t);
  await instance.create({ type: 'embed', data: { html: '<script>alert(1)<\/script>' } });

  const manifest = JSON.stringify(instance.manifest());
  assert.ok(!manifest.includes('alert(1)'), 'a nyers kód nem szivároghat a szülő oldalra');
  assert.match(manifest, /\/embed\//, 'csak a sandboxolt betöltő URL megy ki');
});

test('BIZTONSÁG: a beágyazás csak a saját kulcsával kérhető le', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ type: 'embed', data: { html: '<b>chat</b>' } });
  const key = instance.find(widget.id).data.embedKey;

  assert.equal(instance.embedContent(widget.id, key).html, '<b>chat</b>');
  assert.equal(instance.embedContent(widget.id, 'rossz-kulcs'), null);
  assert.equal(instance.embedContent(widget.id, ''), null);
  assert.equal(instance.embedContent('nincs-ilyen', key), null);
});

test('BIZTONSÁG: a kliens nem tudja megadni a saját embed-kulcsát', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({
    type: 'embed',
    data: { html: '<b>a</b>', embedKey: 'rovid' },
  });
  const stored = instance.find(widget.id).data.embedKey;

  assert.notEqual(stored, 'rovid');
  assert.ok(stored.length >= 32, 'a szerver generál elég hosszú kulcsot');
});

test('a beágyazás verziója követi a kód változását (cache-törés)', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ type: 'embed', data: { html: '<b>egy</b>' } });
  const first = instance.find(widget.id).data.version;

  await instance.update(widget.id, { data: { html: '<b>kettő</b>' } });
  assert.notEqual(instance.find(widget.id).data.version, first);
});

test('a feltöltött kép megmarad egy sima mozgatás után', async (t) => {
  const { instance } = await store(t);
  const widget = await instance.create({ type: 'logo' });
  await instance.setImage(widget.id, {
    buffer: PNG, ext: '.png', mime: 'image/png', originalName: 'logo.png',
  });

  await instance.update(widget.id, { x: 500, y: 300 });
  const after = instance.find(widget.id);
  assert.ok(after.data.file, 'a kép nem veszhet el a pozíció mentésekor');
  assert.equal(after.x, 500);
});

test('a láthatóság és a pozíció túléli az újraindítást', async (t) => {
  const { instance, dir } = await store(t);
  const widget = await instance.create({ type: 'notification', x: 700, y: 950, data: { text: 'hír' } });
  await instance.update(widget.id, { visible: false, screens: ['live'] });

  const reloaded = new OverlayStore({ dataDir: dir, logger: null });
  await reloaded.ready;
  const restored = reloaded.find(widget.id);

  assert.equal(restored.visible, false);
  assert.equal(restored.x, 700);
  assert.deepEqual(restored.screens, ['live']);
});
