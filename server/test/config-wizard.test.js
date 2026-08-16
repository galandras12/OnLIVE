/**
 * A beállító varázsló végigfuttatása (1.0.017).
 *
 * A `config.bat` ígérete az, hogy **nem kell fájlt szerkeszteni**: elég
 * végigválaszolni a kérdéseket, és utána a rendszer működik. Ezt csak úgy lehet
 * bizonyítani, ha tényleg végigfuttatjuk, majd megnézzük, mi került lemezre —
 * és hogy a megadott jelszó/kulcs valóban ellenőrizhető a tárolt hash ellen.
 *
 * A varázsló egy eldobható könyvtárban fut (`ONLIVE_CONFIG_ROOT`), tehát a
 * teszt SOHA nem nyúl a valódi `.env`-hez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPassword } from '../src/security/passwords.js';
import { parseEnvContent } from '../src/settings/env-file.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const wizard = path.join(repoRoot, 'server', 'tools', 'config.js');

const PASSWORD = 'Teszt-Jelszo-1234';

/** Egy telepítésnyi kiinduló állapot: sablon `.env` és hook-környezet. */
function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onlive-config-'));
  copyFileSync(path.join(repoRoot, '.env.example'), path.join(root, '.env'));

  const hooks = path.join(root, 'infra', 'mediamtx', 'hooks');
  mkdirSync(hooks, { recursive: true });
  copyFileSync(
    path.join(repoRoot, 'infra', 'mediamtx', 'hooks', 'hook-env.example.bat'),
    path.join(hooks, 'hook-env.example.bat'),
  );
  return root;
}

/** A varázsló lefuttatása előre megírt válaszokkal. */
function runWizard(root, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wizard], {
      env: { ...process.env, ONLIVE_CONFIG_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(`${answers.join('\n')}\n`);
  });
}

/**
 * Egy teljes, alapértelmezéseket elfogadó végigmenetel válaszai.
 * A sorrend a varázsló kérdéseinek sorrendje — ha az változik, ez a teszt
 * (helyesen) elhasal.
 */
const FULL_RUN = [
  '',                 // 1. port  → marad 8080
  PASSWORD,           // 2. admin jelszó
  PASSWORD,           //    még egyszer
  '',                 // 3. streamkulcs → generálj
  '',                 // 4. /live token → ne legyen
  'pelda.hu',         // 5. fődomain
  '',                 //    „Jó így?" → igen
  '',                 // 6. stream útvonal → onlive
  '',                 // 7. mediamtx.exe
  '',                 //    mediamtx.yml
  '',                 // 8. tunnel service
  '',                 // 9. „Mehet?" → igen
];

test('végigfuttatva megírja a .env-et, a jelszót hash-elve', async () => {
  const root = makeRoot();
  const { code, stdout } = await runWizard(root, FULL_RUN);

  assert.equal(code, 0, `a varázsló hibával állt le:\n${stdout}`);

  const env = parseEnvContent(readFileSync(path.join(root, '.env'), 'utf8'));

  assert.equal(env.ONLIVE_SERVER_PORT, '8080');
  assert.equal(env.ONLIVE_PUBLIC_ADMIN_URL, 'https://admin.pelda.hu');
  assert.equal(env.ONLIVE_PUBLIC_LIVE_URL, 'https://live.pelda.hu');
  assert.equal(env.ONLIVE_PUBLIC_INGEST_URL, 'https://ingest.pelda.hu');
  assert.equal(env.ONLIVE_STREAM_PATH, 'onlive');

  // A lényeg: a hash valóban a megadott jelszóhoz tartozik.
  assert.match(env.ONLIVE_ADMIN_PASSWORD_HASH, /^scrypt\$/);
  assert.ok(
    verifyPassword(PASSWORD, { hash: env.ONLIVE_ADMIN_PASSWORD_HASH }),
    'a tárolt hash nem ismeri fel a megadott jelszót',
  );
});

test('a nyers jelszó SEHOL nem marad ott', async () => {
  const root = makeRoot();
  await runWizard(root, FULL_RUN);

  for (const file of ['.env', '.env.bak', path.join('infra', 'mediamtx', 'hooks', 'hook-env.bat')]) {
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    assert.ok(
      !readFileSync(full, 'utf8').includes(PASSWORD),
      `${file}: benne maradt a nyers jelszó`,
    );
  }

  const keyFile = path.join(root, 'server', 'data', 'stream-key.json');
  assert.ok(!readFileSync(keyFile, 'utf8').includes(PASSWORD));

  // A .env-ből el kell tűnnie a nyers jelszó sorának is.
  const env = parseEnvContent(readFileSync(path.join(root, '.env'), 'utf8'));
  assert.equal(env.ONLIVE_ADMIN_PASSWORD, undefined);
});

test('a generált streamkulcs hash-elve kerül lemezre, és illeszkedik', async () => {
  const root = makeRoot();
  const { stdout } = await runWizard(root, FULL_RUN);

  // A kulcsot a varázsló egyszer kiírja — a felhasználó ezt gépeli a telefonba.
  const shown = /A STREAMKULCS[\s\S]*?\n\n\s{4,}(\S+)\n/.exec(stdout)?.[1];
  assert.ok(shown, `a varázsló nem írta ki a kulcsot:\n${stdout}`);
  assert.ok(shown.length >= 16, 'a kulcs legalább 16 karakter');

  const stored = JSON.parse(readFileSync(path.join(root, 'server', 'data', 'stream-key.json'), 'utf8'));
  assert.match(stored.hash, /^scrypt\$/);
  assert.equal(stored.origin, 'generalt');
  assert.ok(
    verifyPassword(shown, { hash: stored.hash }),
    'a kiírt kulcs nem ellenőrizhető a tárolt hash ellen',
  );

  // A .env-ben nem maradhat nyers kulcs — különben egy régi érték is élne.
  const env = parseEnvContent(readFileSync(path.join(root, '.env'), 'utf8'));
  assert.equal(env.ONLIVE_STREAM_KEY, '');
  assert.ok(!readFileSync(path.join(root, '.env'), 'utf8').includes(shown));
});

test('a port és a hook-titok a hookok környezetébe is bekerül', async () => {
  const root = makeRoot();
  await runWizard(root, ['9090', PASSWORD, PASSWORD, '', '', '', '', '', '', '', '', '']);

  const env = parseEnvContent(readFileSync(path.join(root, '.env'), 'utf8'));
  assert.equal(env.ONLIVE_SERVER_PORT, '9090');

  // A felületi beállítás erősebb az env-nél, ezért ide is be kell kerülnie —
  // különben a varázslóban megadott port némán hatástalan maradna.
  const stored = JSON.parse(readFileSync(path.join(root, 'server', 'data', 'server.json'), 'utf8'));
  assert.equal(stored.port, 9090);

  // A hookok külön folyamatban futnak: ott is a jó portnak és titoknak kell állnia.
  const hookEnv = readFileSync(
    path.join(root, 'infra', 'mediamtx', 'hooks', 'hook-env.bat'), 'utf8',
  );
  assert.match(hookEnv, /set ONLIVE_CONTROL_URL=http:\/\/127\.0\.0\.1:9090\s*$/m);
  assert.match(hookEnv, new RegExp(`set ONLIVE_HOOK_SECRET=${escapeRegExp(env.ONLIVE_HOOK_SECRET)}\\s*$`, 'm'));
  assert.ok(!hookEnv.includes('valtoztasd-meg'), 'a példaérték nem maradhat ott');
});

test('a sablon kommentjei túlélik a varázslót', async () => {
  const root = makeRoot();
  await runWizard(root, FULL_RUN);

  const written = readFileSync(path.join(root, '.env'), 'utf8');
  assert.match(written, /OnLIVE — környezeti változók/, 'a fejléc-komment megmaradt');
  assert.match(written, /A 2 perces küszöb/, 'a magyarázó kommentek megmaradtak');
});

test('nemleges válasznál semmit nem ír', async () => {
  const root = makeRoot();
  const before = readFileSync(path.join(root, '.env'), 'utf8');

  const answers = [...FULL_RUN];
  answers[answers.length - 1] = 'n';          // „Mehet?" → nem
  const { code } = await runWizard(root, answers);

  assert.equal(code, 1, 'a megszakított beállítás nem nulla kilépési kód');
  assert.equal(readFileSync(path.join(root, '.env'), 'utf8'), before, 'a .env nem változhatott');
  assert.ok(!existsSync(path.join(root, 'server', 'data', 'stream-key.json')));
  assert.ok(!existsSync(path.join(root, '.env.bak')));
});

test('a meglévő .env-ről mentés készül', async () => {
  const root = makeRoot();
  const before = readFileSync(path.join(root, '.env'), 'utf8');
  await runWizard(root, FULL_RUN);

  assert.equal(readFileSync(path.join(root, '.env.bak'), 'utf8'), before);
});

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
