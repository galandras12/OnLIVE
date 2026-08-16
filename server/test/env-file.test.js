/**
 * A `.env` kíméletes átírása (1.0.017).
 *
 * A beállító varázsló ezen keresztül ír. Amit itt elrontunk, az nem hibaüzenet
 * formájában jelentkezik, hanem úgy, hogy a szerver a KÖVETKEZŐ indításkor nem
 * ismeri fel a jelszót — ezért a szabályokat tételesen rögzítjük.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPEND_HEADER,
  detectEol,
  formatEnvValue,
  parseEnvContent,
  updateEnvContent,
} from '../src/settings/env-file.js';

test('olvasás: kulcs, komment, idézőjel, üres sor', () => {
  const values = parseEnvContent([
    '# komment',
    'ONLIVE_SERVER_PORT=8080',
    '',
    'ONLIVE_MEDIAMTX_PATH="C:\\OnLIVE\\Program Files\\mediamtx.exe"',
    "ONLIVE_TUNNEL_SERVICE='cloudflared'",
    'ONLIVE_LIVE_TOKEN=',
    'ONLIVE_STREAM_PATH=onlive   # soron belüli komment',
  ].join('\n'));

  assert.equal(values.ONLIVE_SERVER_PORT, '8080');
  assert.equal(values.ONLIVE_MEDIAMTX_PATH, 'C:\\OnLIVE\\Program Files\\mediamtx.exe');
  assert.equal(values.ONLIVE_TUNNEL_SERVICE, 'cloudflared');
  assert.equal(values.ONLIVE_LIVE_TOKEN, '');
  assert.equal(values.ONLIVE_STREAM_PATH, 'onlive');
});

test('olvasás: ismétlődő kulcsnál az utolsó nyer', () => {
  // Ugyanaz a szabály, mint a Node `--env-file` feldolgozásában.
  const values = parseEnvContent('A=1\nA=2\n');
  assert.equal(values.A, '2');
});

test('a scrypt hash idézőjel nélkül is épen marad', () => {
  const hash = 'scrypt$16384$8$1$DLTHAcA8J5gUQnAdVIGZtg==$kwqOkiDHIas+/x==';
  const written = updateEnvContent('ONLIVE_ADMIN_PASSWORD_HASH=\n', {
    ONLIVE_ADMIN_PASSWORD_HASH: hash,
  });
  assert.equal(parseEnvContent(written).ONLIVE_ADMIN_PASSWORD_HASH, hash);
  assert.ok(!written.includes('"'), 'nem kell idézőjel a hash köré');
});

test('szóközös érték idézőjelet kap, és visszaolvasva ugyanaz', () => {
  const value = 'C:\\Program Files\\OnLIVE\\mediamtx.exe';
  assert.match(formatEnvValue(value), /^'.*'$/);

  const written = updateEnvContent('ONLIVE_MEDIAMTX_PATH=\n', { ONLIVE_MEDIAMTX_PATH: value });
  assert.equal(parseEnvContent(written).ONLIVE_MEDIAMTX_PATH, value);
});

test('REGRESSZIÓ: a \\n-t tartalmazó Windows útvonal nem esik szét', () => {
  // A Node a KETTŐS idézőjelen belül a `\n`-t sortörésre cseréli. Egy
  // `C:\new\...` útvonalat így idézve a szerver egy csonkot kapna vissza —
  // és a MediaMTX „nem találom" hibája semmit nem árulna el az okról.
  const value = 'C:\\new folder\\mediamtx.exe';
  const written = updateEnvContent('P=\n', { P: value });

  assert.ok(!written.includes('"'), 'aposztróffal kell idézni, nem idézőjellel');
  assert.equal(parseEnvContent(written).P, value);
  assert.ok(!parseEnvContent(written).P.includes('\n'), 'nem lehet benne sortörés');
});

test('aposztrófot ÉS idézőjelet is tartalmazó érték: hangos hiba', () => {
  // A .env formátum ezt nem tudja tárolni; a csendes csonkítás rosszabb lenne.
  assert.throws(() => formatEnvValue(`a'b"c`), /nem tud tárolni/);
});

test('a kommentek és a sorrend megmaradnak', () => {
  // Ez a lényeg: a .env.example magyarázatai a varázsló után is ott vannak.
  const before = [
    '# --- Helyi portok ---',
    '# A vezérlő szerver portja.',
    'ONLIVE_SERVER_PORT=8080',
    '# A MediaMTX WHIP portja.',
    'ONLIVE_MEDIAMTX_WHIP_PORT=8889',
  ].join('\n');

  const after = updateEnvContent(before, { ONLIVE_SERVER_PORT: '9090' });

  assert.match(after, /# --- Helyi portok ---/);
  assert.match(after, /# A vezérlő szerver portja\./);
  assert.match(after, /^ONLIVE_SERVER_PORT=9090$/m);
  assert.match(after, /^ONLIVE_MEDIAMTX_WHIP_PORT=8889$/m);

  // A sorrend sem cserélődhet fel.
  assert.ok(after.indexOf('ONLIVE_SERVER_PORT') < after.indexOf('ONLIVE_MEDIAMTX_WHIP_PORT'));
});

test('null érték törli a sort', () => {
  // Így tűnik el a nyers ONLIVE_ADMIN_PASSWORD, miután hash-t állítottunk be.
  const after = updateEnvContent('ONLIVE_ADMIN_PASSWORD=titok\nONLIVE_SESSION_TTL_MS=1\n', {
    ONLIVE_ADMIN_PASSWORD: null,
  });
  assert.ok(!/ONLIVE_ADMIN_PASSWORD=/.test(after), 'a nyers jelszó sora nem maradhat ott');
  assert.match(after, /ONLIVE_SESSION_TTL_MS=1/);
});

test('duplikált kulcsból egy marad, az új értékkel', () => {
  // Árnyékoló sor a fájl végén: a felhasználó azt hinné, átállította, a Node
  // viszont az utolsót olvasná.
  const after = updateEnvContent('PORT_A=1\nX=2\nPORT_A=3\n', { PORT_A: '9' });
  assert.deepEqual(after.match(/^PORT_A=/gm), ['PORT_A=']);
  assert.match(after, /^PORT_A=9$/m);
});

test('ismeretlen kulcs a fájl végére kerül, egyszeri fejléc alá', () => {
  const once = updateEnvContent('MEGLEVO=1\n', { UJ_KULCS: 'ertek' });
  assert.match(once, /^UJ_KULCS=ertek$/m);
  assert.equal(once.split(APPEND_HEADER).length - 1, 1);

  const twice = updateEnvContent(once, { MASIK: 'ertek' });
  assert.equal(twice.split(APPEND_HEADER).length - 1, 1, 'a fejléc nem sokszorozódik');
  assert.match(twice, /^MASIK=ertek$/m);
});

test('a sorvég stílusa megmarad (Windowson CRLF)', () => {
  assert.equal(detectEol('A=1\r\nB=2\r\n'), '\r\n');
  assert.equal(detectEol('A=1\nB=2\n'), '\n');

  const after = updateEnvContent('A=1\r\nB=2\r\n', { A: '9' });
  assert.ok(!/(?<!\r)\n/.test(after), 'nem keveredhet LF a CRLF közé');
});

test('a kikommentelt kulcshoz nem nyúlunk', () => {
  const after = updateEnvContent('# ONLIVE_LIVE_TOKEN=regi\n', { ONLIVE_LIVE_TOKEN: 'uj' });
  assert.match(after, /^# ONLIVE_LIVE_TOKEN=regi$/m, 'a komment marad komment');
  assert.match(after, /^ONLIVE_LIVE_TOKEN=uj$/m, 'az új érték külön sorba kerül');
});
