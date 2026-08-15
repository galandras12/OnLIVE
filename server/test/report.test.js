/**
 * Napló-összeállítás és chat-linkek tesztek (9. szegmens).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildPeriods, summarize, toChartSeries, toCsv } from '../src/log/report.js';
import { LinkStore, normalizeUrl } from '../src/links/store.js';

// --- minta adás: intro → live → reconnecting → live → outro -----------------

const T0 = Date.parse('2026-08-15T10:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

const transitions = [
  { at: at(0), sessionId: 's1', from: 'idle', to: 'intro', event: 'session/start', source: 'phone' },
  { at: at(10), sessionId: 's1', from: 'intro', to: 'live', event: 'ingest/up', source: 'ingest' },
  { at: at(190), sessionId: 's1', from: 'live', to: 'reconnecting', event: 'ingest/down', source: 'ingest' },
  { at: at(220), sessionId: 's1', from: 'reconnecting', to: 'live', event: 'ingest/up', source: 'ingest' },
  { at: at(400), sessionId: 's1', from: 'live', to: 'outro', event: 'session/end', source: 'admin' },
  { at: at(415), sessionId: 's1', from: 'outro', to: 'ended', event: 'outro/done', source: 'timer' },
];

const sample = (seconds, videoKbps, extra = {}) => ({
  at: at(seconds),
  ms: T0 + seconds * 1000,
  sessionId: 's1',
  state: extra.state ?? 'live',
  videoKbps,
  audioKbps: 96,
  fps: extra.fps ?? 30,
  rttMs: extra.rttMs ?? 40,
  jitterMs: extra.jitterMs ?? 4,
  lossPercent: extra.lossPercent ?? 0,
});

const samples = [
  sample(20, 4000),
  sample(60, 5000),
  sample(120, 6000),
  sample(180, 3000, { lossPercent: 2.5 }),
  sample(200, 0, { state: 'reconnecting', fps: 0, rttMs: 0 }),
  sample(240, 5200),
  sample(300, 5400),
];

test('az időszakok az átmenetekből épülnek, a mintákkal együtt', () => {
  const periods = buildPeriods(transitions, samples);

  assert.deepEqual(
    periods.map((p) => p.state),
    ['intro', 'live', 'reconnecting', 'live', 'outro', 'ended'],
  );

  const live = periods[1];
  assert.equal(live.durationSeconds, 180);
  assert.equal(live.samples, 4);
  assert.equal(live.minKbps, 3000);
  assert.equal(live.maxKbps, 6000);
  assert.equal(live.avgKbps, 4500, '(4000+5000+6000+3000)/4');
  assert.equal(live.maxLossPercent, 2.5);
});

test('a megszakadás és a szünet kiesésnek számít, az intro/outro nem', () => {
  const periods = buildPeriods(transitions, samples);
  const outages = periods.filter((p) => p.outage).map((p) => p.state);
  assert.deepEqual(outages, ['reconnecting']);

  const paused = buildPeriods(
    [{ at: at(0), sessionId: 's2', from: 'live', to: 'paused', event: 'session/pause', source: 'phone' }],
    [],
  );
  assert.equal(paused[0].outage, true, 'a szándékos szünet is kiesés a naplóban');
});

test('a nulla bitrátás minták nem rontják le a minimumot', () => {
  const periods = buildPeriods(transitions, samples);
  const reconnecting = periods[2];

  assert.equal(reconnecting.samples, 1);
  assert.equal(reconnecting.minKbps, 0, 'nincs érvényes mérés a szakadás alatt');

  const live = periods[3];
  assert.equal(live.minKbps, 5200, 'az élő szakasz minimuma nem 0');
});

test('az időtartomány-szűrő vágja a részben átfedő időszakokat', () => {
  const periods = buildPeriods(transitions, samples, {
    from: T0 + 100 * 1000,
    to: T0 + 200 * 1000,
  });

  assert.ok(periods.length >= 1);
  const first = periods[0];
  assert.equal(Date.parse(first.start), T0 + 100 * 1000, 'a kezdet a szűrőhöz vágódik');
  assert.ok(Date.parse(first.end) <= T0 + 200 * 1000);
});

test('a session-szűrő csak az adott adást hozza', () => {
  const mixed = [
    ...transitions,
    { at: at(500), sessionId: 's2', from: 'ended', to: 'intro', event: 'session/start', source: 'phone' },
  ];
  const periods = buildPeriods(mixed, samples, { sessionId: 's2' });

  assert.equal(periods.length, 1);
  assert.equal(periods[0].sessionId, 's2');
});

test('a session-összegzés élő időt, kiesést és csúcsot ad', () => {
  const [summary] = summarize(buildPeriods(transitions, samples));

  assert.equal(summary.sessionId, 's1');
  assert.equal(summary.liveSeconds, 360, '180 + 180 másodperc élő adás');
  assert.equal(summary.outageSeconds, 30);
  assert.equal(summary.outages, 1);
  assert.equal(summary.maxKbps, 6000);
});

// --- CSV --------------------------------------------------------------------

test('a CSV BOM-mal kezdődik és pontosvesszőt használ (magyar Excel)', () => {
  const csv = toCsv(buildPeriods(transitions, samples));

  assert.ok(csv.startsWith('﻿'), 'BOM nélkül az Excel elrontja az ékezeteket');
  assert.match(csv.split('\r\n')[0], /^﻿session;allapot;kieses;/);
  assert.match(csv, /\r\n$/, 'CRLF sorvég');
});

test('a vesszős változat Google Sheetshez', () => {
  const csv = toCsv(buildPeriods(transitions, samples), { separator: 'comma' });
  assert.match(csv.split('\r\n')[0], /^﻿session,allapot,kieses,/);
});

test('a CSV megvédi az elválasztót és az idézőjelet tartalmazó mezőket', () => {
  const csv = toCsv([
    {
      sessionId: 's;1', state: 'live', outage: false,
      start: at(0), end: at(1), durationSeconds: 1, samples: 0,
      avgKbps: 0, minKbps: 0, maxKbps: 0, avgFps: 0, avgRttMs: 0, avgJitterMs: 0,
      maxLossPercent: 0, event: 'a "b"', source: 'admin',
    },
  ]);

  assert.match(csv, /"s;1"/, 'az elválasztót tartalmazó mező idézőjelbe kerül');
  assert.match(csv, /"a ""b"""/, 'az idézőjel duplázódik');
});

test('a grafikon-sorozat pontokat és kiesés-sávokat ad', () => {
  const periods = buildPeriods(transitions, samples);
  const chart = toChartSeries(samples, periods);

  assert.equal(chart.points.length, samples.length);
  assert.equal(chart.outages.length, 1);
  assert.equal(chart.outages[0].state, 'reconnecting');
});

test('üres adaton sem borul fel', () => {
  assert.deepEqual(buildPeriods([], []), []);
  assert.deepEqual(summarize([]), []);
  assert.match(toCsv([]), /^﻿session;/);
});

// --- chat-linkek ------------------------------------------------------------

test('BIZTONSÁG: csak http és https séma engedélyezett', () => {
  assert.equal(normalizeUrl('https://youtube.com/live_chat'), 'https://youtube.com/live_chat');
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /protokoll/i);
  assert.throws(() => normalizeUrl('data:text/html,<script>'), /protokoll/i);
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /protokoll/i);
  assert.throws(() => normalizeUrl('nem-url'), /Érvénytelen URL/);
  assert.throws(() => normalizeUrl(''), /nem lehet üres/);
});

test('a linkek megmaradnak, és a publikus szűrő működik', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new LinkStore({ dataDir: dir, logger: null });
  await store.ready;

  await store.create({ name: 'YouTube chat', url: 'https://youtube.com/live_chat?v=1' });
  const privateLink = await store.create({ name: 'Belső', url: 'https://example.com', public: false });

  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list({ onlyPublic: true }).map((l) => l.name), ['YouTube chat']);

  await store.update(privateLink.id, { public: true, name: 'Discord' });
  assert.deepEqual(
    store.list({ onlyPublic: true }).map((l) => l.name).sort(),
    ['Discord', 'YouTube chat'],
  );

  const reloaded = new LinkStore({ dataDir: dir, logger: null });
  await reloaded.ready;
  assert.equal(reloaded.list().length, 2, 'a lista túléli az újraindítást');

  await reloaded.remove(privateLink.id);
  assert.equal(reloaded.list().length, 1);
});

test('érvénytelen URL-lel nem jön létre link', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'onlive-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const store = new LinkStore({ dataDir: dir, logger: null });
  await store.ready;

  await assert.rejects(() => store.create({ name: 'Rossz', url: 'javascript:alert(1)' }));
  assert.equal(store.list().length, 0);
});
