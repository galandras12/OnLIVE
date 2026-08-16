/**
 * Capture-beállítások: felbontás és kép-irány (1.0.101).
 *
 * A felbontás-lista három helyen él: az Android enumban, a szerver
 * validációjában és az admin HTML gombjain. A 2160p felvételekor derült ki,
 * hogy egyet bővíteni könnyű, hármat viszont könnyű elfelejteni — ezért a
 * szerver oldali kettőt itt egymáshoz mérjük.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RESOLUTIONS,
  ORIENTATIONS,
  VIDEO_BITRATE,
  assessOrientation,
  assessResolution,
  resolutionLabel,
} from '../src/device/capture-options.js';

const adminHtml = readFileSync(fileURLToPath(new URL('../src/web/admin.html', import.meta.url)), 'utf8');

test('a 2160p felbontás elfogadott', () => {
  const assessment = assessResolution('P2160');
  assert.deepEqual(assessment, { ok: true, value: 'P2160' });
  assert.equal(resolutionLabel('P2160'), '2160p');
});

test('a felbontás neve kisbetűvel is jó, ismeretlenre hibát ad', () => {
  assert.equal(assessResolution('p720').value, 'P720');
  assert.equal(assessResolution('P4320').ok, false);
  assert.match(assessResolution('').error, /Ismeretlen felbontás/);
});

test('minden felbontásnak van gombja az admin felületen', () => {
  for (const resolution of RESOLUTIONS) {
    assert.ok(
      adminHtml.includes(`data-res="${resolution.name}"`),
      `${resolution.name}: nincs gomb az admin.html-ben`,
    );
    assert.ok(adminHtml.includes(`>${resolution.label}<`), `${resolution.label}: nincs felirat`);
  }
});

test('mindkét kép-iránynak van gombja', () => {
  for (const orientation of ORIENTATIONS) {
    assert.ok(
      adminHtml.includes(`data-orient="${orientation.name}"`),
      `${orientation.name}: nincs gomb az admin.html-ben`,
    );
  }
});

test('az irány csak a két ismert értéket fogadja el', () => {
  assert.equal(assessOrientation('portrait').value, 'portrait');
  assert.equal(assessOrientation('LANDSCAPE').value, 'landscape');
  assert.equal(assessOrientation('fekvo').ok, false);
  assert.match(assessOrientation(null).error, /Ismeretlen kép-irány/);
});

test('a bitráta-csúszka felső határa követi a 4K-hoz emelt korlátot', () => {
  // 2160p mellett 12 Mbit/s kevés; ha a HTML és a szerver elcsúszik, a felület
  // olyan értéket küldene, amit a szerver 400-zal utasít vissza.
  assert.equal(VIDEO_BITRATE.maxKbps, 25_000);
  assert.match(adminHtml, /id="bitrate"[^>]*max="25000"/);
});
