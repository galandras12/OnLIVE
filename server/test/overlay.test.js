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
  assert.equal(widget.width, 16, 'a szélesség nem lehet negatív');
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
