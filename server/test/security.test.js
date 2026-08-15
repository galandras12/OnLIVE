/**
 * Biztonsági tesztek (10. szegmens).
 *
 * A hangsúly a jogosultsági szintek elhatárolásán van: a lejátszási token
 * NEM vezérelhet, a streamkulcs NEM admin, és a munkamenet nem használható
 * idegen oldalról.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessSecret, constantTimeEquals, generateKey, hashPassword, verifyPassword,
} from '../src/security/passwords.js';
import { SessionStore, parseCookies, buildCookie } from '../src/security/sessions.js';
import { RateLimiter } from '../src/security/rate-limit.js';
import { isAdminSocket, isLiveTokenValid } from '../src/api/auth.js';

// ---------------------------------------------------------------------------
// Jelszó
// ---------------------------------------------------------------------------

test('a hash-elt jelszó ellenőrizhető, de nem visszafejthető', () => {
  const hash = hashPassword('titkos-jelszo-123');

  assert.match(hash, /^scrypt\$/);
  assert.ok(!hash.includes('titkos-jelszo-123'), 'a nyers jelszó nem lehet a hashben');
  assert.equal(verifyPassword('titkos-jelszo-123', { hash }), true);
  assert.equal(verifyPassword('rossz', { hash }), false);
  assert.equal(verifyPassword('', { hash }), false);
});

test('ugyanaz a jelszó két különböző hash-t ad (só)', () => {
  assert.notEqual(hashPassword('ugyanaz'), hashPassword('ugyanaz'));
});

test('sérült hash-re nem dob, csak elutasít', () => {
  assert.equal(verifyPassword('akarmi', { hash: 'nem-hash' }), false);
  assert.equal(verifyPassword('akarmi', { hash: 'scrypt$rossz' }), false);
});

test('a sima szöveges jelszó is működik (visszafelé kompatibilitás)', () => {
  assert.equal(verifyPassword('jelszo', { plain: 'jelszo' }), true);
  assert.equal(verifyPassword('jelszo2', { plain: 'jelszo' }), false);
});

test('a konstans idejű összehasonlítás eltérő hosszra sem dob', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals(null, 'abc'), false);
});

test('a generált kulcs elég hosszú és URL-biztos', () => {
  const key = generateKey(24);
  assert.ok(key.length >= 32);
  assert.match(key, /^[A-Za-z0-9_-]+$/, 'base64url — mehet query paraméterben');
  assert.notEqual(generateKey(24), generateKey(24));
});

test('a gyenge titkokat felismeri', () => {
  assert.equal(assessSecret('').level, 'missing');
  assert.equal(assessSecret('valtoztasd-meg').level, 'weak', 'a sablon-érték nem maradhat');
  assert.equal(assessSecret('rovid').level, 'weak');
  assert.equal(assessSecret('aaaaaaaaaaaaaaaaaaaaaaaa').level, 'fair', 'egyveretű karakterkészlet');
  assert.equal(assessSecret(generateKey(24)).level, 'strong');
});

// ---------------------------------------------------------------------------
// Munkamenet
// ---------------------------------------------------------------------------

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a munkamenet token és CSRF token külön értékek', () => {
  const store = new SessionStore();
  const session = store.create({ userAgent: 'teszt' });

  assert.ok(session.token.length >= 32);
  assert.ok(session.csrf.length >= 24);
  assert.notEqual(session.token, session.csrf, 'a CSRF token nem lehet a munkamenet token');
});

test('a munkamenet lejár, de a használat előre csúsztatja', () => {
  const c = clock();
  const store = new SessionStore({ ttlMs: 1000, now: c.now });
  const session = store.create();

  c.advance(800);
  assert.ok(store.touch(session.token), 'még él');

  c.advance(800); // az utolsó használat óta 800 ms
  assert.ok(store.touch(session.token), 'a használat csúsztatta a lejáratot');

  c.advance(1500);
  assert.equal(store.touch(session.token), null, 'használat nélkül lejárt');
});

test('CSRF: csak a munkamenethez tartozó token fogadható el', () => {
  const store = new SessionStore();
  const a = store.create();
  const b = store.create();

  assert.equal(store.verifyCsrf(a, a.csrf), true);
  assert.equal(store.verifyCsrf(a, b.csrf), false, 'másik munkamenet tokenje nem jó');
  assert.equal(store.verifyCsrf(a, ''), false);
  assert.equal(store.verifyCsrf(null, a.csrf), false);
});

test('kijelentkezés után a token azonnal érvénytelen', () => {
  const store = new SessionStore();
  const session = store.create();

  assert.ok(store.touch(session.token));
  store.destroy(session.token);
  assert.equal(store.touch(session.token), null);
});

test('a munkamenetek száma korlátos — a legrégebbi esik ki', () => {
  const c = clock();
  const store = new SessionStore({ maxSessions: 3, now: c.now });

  const first = store.create();
  c.advance(10);
  store.create();
  c.advance(10);
  store.create();
  c.advance(10);
  store.create(); // negyedik

  assert.equal(store.size, 3);
  assert.equal(store.touch(first.token), null, 'a legrégebbi munkamenet esett ki');
});

test('a süti HttpOnly, SameSite=Strict, és HTTPS-en Secure', () => {
  const cookie = buildCookie('onlive_session', 'abc', { maxAgeMs: 3600_000, secure: true });

  assert.match(cookie, /HttpOnly/, 'a JavaScript ne olvashassa');
  assert.match(cookie, /SameSite=Strict/, 'idegen oldalról ne menjen el');
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=3600/);

  const cleared = buildCookie('onlive_session', '', { clear: true });
  assert.match(cleared, /Max-Age=0/);
});

test('a süti-értelmező több sütit is kezel', () => {
  const cookies = parseCookies('a=1; onlive_session=abc%3D; b=2');
  assert.equal(cookies.onlive_session, 'abc=');
  assert.equal(cookies.a, '1');
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

// ---------------------------------------------------------------------------
// Sebességkorlátozás
// ---------------------------------------------------------------------------

test('a küszöb feletti próbálkozás zárlatot kap', () => {
  const c = clock();
  const limiter = new RateLimiter({ threshold: 3, baseLockMs: 1000, now: c.now });

  for (let i = 0; i < 2; i += 1) {
    limiter.fail('1.2.3.4');
    assert.equal(limiter.check('1.2.3.4').allowed, true);
  }

  limiter.fail('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4').allowed, false, 'a harmadik hiba után zárlat');

  c.advance(1100);
  assert.equal(limiter.check('1.2.3.4').allowed, true, 'a zárlat letelt');
});

test('az ismételt zárlat egyre hosszabb', () => {
  const c = clock();
  const limiter = new RateLimiter({ threshold: 1, baseLockMs: 1000, now: c.now });

  limiter.fail('ip');
  const first = limiter.check('ip').retryAfterMs;
  c.advance(first + 10);

  limiter.fail('ip');
  const second = limiter.check('ip').retryAfterMs;

  assert.ok(second > first, `a második zárlat hosszabb (${second} > ${first})`);
});

test('a sikeres belépés törli a korábbi hibákat', () => {
  const limiter = new RateLimiter({ threshold: 3 });
  limiter.fail('ip');
  limiter.fail('ip');

  limiter.succeed('ip');
  assert.equal(limiter.check('ip').failures, 0, 'az elgépelések nem halmozódnak');
});

test('a korlátozás IP-nként külön számol', () => {
  const limiter = new RateLimiter({ threshold: 2 });
  limiter.fail('a');
  limiter.fail('a');

  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.check('b').allowed, true, 'másik kliens nem zárható ki emiatt');
});

// ---------------------------------------------------------------------------
// Jogosultsági szintek
// ---------------------------------------------------------------------------

test('token nélküli konfigurációban a /live nyilvános', () => {
  assert.equal(isLiveTokenValid({ liveToken: '' }, undefined), true);
  assert.equal(isLiveTokenValid({ liveToken: '' }, 'akarmi'), true);
});

test('beállított lejátszási tokennel csak a helyes érték jó', () => {
  const config = { liveToken: 'nezo-token' };
  assert.equal(isLiveTokenValid(config, 'nezo-token'), true);
  assert.equal(isLiveTokenValid(config, 'masik'), false);
  assert.equal(isLiveTokenValid(config, ''), false);
});

test('BIZTONSÁG: a lejátszási token NEM ad admin socket-szerepet', () => {
  const config = { liveToken: 'nezo-token', adminPassword: 'admin-jelszo' };
  const sessions = new SessionStore();

  const handshake = { headers: {}, query: { role: 'admin', token: 'nezo-token' } };
  assert.equal(
    isAdminSocket(config, handshake, sessions), false,
    'a nézői token nem láthatja a telemetriát és az ingest-részleteket',
  );
});

test('BIZTONSÁG: a streamkulcs sem ad admin socket-szerepet', () => {
  const config = { adminPassword: 'admin-jelszo', streamKey: 'stream-kulcs' };
  const sessions = new SessionStore();

  assert.equal(
    isAdminSocket(config, { headers: {}, query: { adminPassword: 'stream-kulcs' } }, sessions),
    false,
  );
});

test('érvényes admin munkamenet süti admin szerepet ad', () => {
  const config = { adminPassword: 'admin-jelszo' };
  const sessions = new SessionStore();
  const session = sessions.create();

  const handshake = { headers: { cookie: `onlive_session=${session.token}` }, query: { role: 'admin' } };
  assert.equal(isAdminSocket(config, handshake, sessions), true);
});
