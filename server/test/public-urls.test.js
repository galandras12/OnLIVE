/**
 * A publikus címek ellenőrzése (1.0.019).
 *
 * Ezek a tesztek egy valódi, éles hibából születtek: a telefon
 * „A cím elérhető, de nem OnLIVE szerver válaszol (HTTP 404)" üzenettel állt
 * meg, mert a vezérlő szerver címe `https://live.pelda.com/admin`-ra volt
 * állítva. Az app az alap-címhez fűzi a `/api/session/ping`-et, tehát egy nem
 * létező útvonalat kérdezett — miközben minden más rendben volt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessPublicUrl, assessPublicUrls } from '../src/settings/public-urls.js';

test('a tiszta alap-cím rendben van', () => {
  for (const url of ['https://admin.pelda.com', 'https://admin.pelda.com/', 'http://localhost:8080']) {
    const assessment = assessPublicUrl(url, { role: 'admin' });
    assert.ok(assessment.ok, `${url} → ${assessment.error}`);
  }
});

test('REGRESSZIÓ: az /admin végű cím hibás, és megmondjuk a helyeset', () => {
  const assessment = assessPublicUrl('https://live.pelda.com/admin', { role: 'admin' });

  assert.equal(assessment.ok, false);
  assert.match(assessment.error, /ALAP-címet/);
  assert.match(assessment.error, /https:\/\/live\.pelda\.com/);
  assert.equal(assessment.normalized, 'https://live.pelda.com');
});

test('az útvonalas ingest cím is hibás', () => {
  // A cloudflared nem vág le előtagot: a `/ingest/onlive/whip` kérés így,
  // ahogy van, a vezérlő szerverhez érkezne.
  const assessment = assessPublicUrl('https://live.pelda.com/ingest', { role: 'ingest' });
  assert.equal(assessment.ok, false);
  assert.equal(assessment.normalized, 'https://live.pelda.com');
});

test('üres, hibás és nem http cím', () => {
  assert.match(assessPublicUrl('', { role: 'live' }).error, /nincs megadva/);
  assert.match(assessPublicUrl('pelda.com', { role: 'live' }).error, /nem érvényes URL/);
  assert.match(assessPublicUrl('ftp://pelda.com', { role: 'live' }).error, /http\/https/);
});

test('paraméter és horgony sem tartozik bele', () => {
  assert.equal(assessPublicUrl('https://pelda.com?a=1', { role: 'admin' }).ok, false);
  assert.equal(assessPublicUrl('https://pelda.com#x', { role: 'admin' }).ok, false);
});

test('a jó hármas nem ad panaszt', () => {
  assert.deepEqual(assessPublicUrls({
    admin: 'https://admin.pelda.com',
    live: 'https://live.pelda.com',
    ingest: 'https://ingest.pelda.com',
  }), []);
});

test('az ingest nem mutathat ugyanarra a hostra, mint a vezérlő szerver', () => {
  const problems = assessPublicUrls({
    admin: 'https://live.pelda.com',
    live: 'https://live.pelda.com',
    ingest: 'https://live.pelda.com',
  });

  assert.equal(problems.length, 1);
  assert.equal(problems[0].role, 'ingest');
  assert.equal(problems[0].level, 'warning');
  assert.match(problems[0].message, /8889/);
});

test('a valódi hibás beállítás mindkét bajt megtalálja', () => {
  const problems = assessPublicUrls({
    admin: 'https://live.pelda.com/admin',
    live: 'https://live.pelda.com',
    ingest: 'https://live.pelda.com/ingest',
  });

  const roles = problems.map((problem) => `${problem.role}:${problem.level}`);
  assert.deepEqual(roles, ['admin:error', 'ingest:error', 'ingest:warning']);
});
