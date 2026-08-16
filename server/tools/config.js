#!/usr/bin/env node
/**
 * OnLIVE — beállító varázsló (1.0.017).
 *
 * Ezt indítja a `config.bat`. Sorban, egyesével bekéri azt a néhány dolgot,
 * amit egy telepítésnél tényleg meg kell adni, és **maga írja be** a helyükre:
 *
 *   - a jelszót azonnal scrypt hash-re váltja, a nyers érték sehova nem kerül;
 *   - a streamkulcsot ugyanígy, a `data/stream-key.json`-ba, hash-elve;
 *   - a `.env`-et sorcserével frissíti, tehát a sablon kommentjei megmaradnak;
 *   - a MediaMTX hookjainak `hook-env.bat`-ját is megírja, hogy a hook-titok és
 *     a port ne csússzon el a szerverétől.
 *
 * MIÉRT KELL EZ: eddig a telepítés így nézett ki — másold a `.env.example`-t,
 * futtass `npm run keygen`-t, másolj két sort, futtass `npm run hash-password`-öt,
 * másolj még egyet, majd nyisd meg a `hook-env.example.bat`-ot is. Öt kézi
 * fájlszerkesztés, mindegyikben el lehet gépelni valamit — és ha elgépeled,
 * a rendszer nem hibát ír, hanem csendben nem hitelesít.
 *
 * A varázsló SEMMIT nem ír addig, amíg a végén rá nem bólintasz. A `.env`-ről
 * mentés készül (`.env.bak`), mielőtt hozzányúlunk.
 */

import { createInterface } from 'node:readline/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessSecret, generateKey, hashPassword } from '../src/security/passwords.js';
import { StreamKeyStore, assessStreamKey, generateStreamKey, keyRules } from '../src/security/stream-key.js';
import { ServerSettingsStore, assessPort } from '../src/settings/store.js';
import { checkPortDependencies, describeMismatch } from '../src/settings/dependencies.js';
import { parseEnvContent, updateEnvContent } from '../src/settings/env-file.js';

/**
 * A projekt gyökere. Rendes futásnál a fájl helyéből adódik; az
 * `ONLIVE_CONFIG_ROOT` kizárólag a tesztek kedvéért van, hogy a varázsló egy
 * eldobható könyvtárban is végigfuttatható legyen — a valódi `.env` érintése
 * nélkül.
 */
const repoRoot = process.env.ONLIVE_CONFIG_ROOT
  ? path.resolve(process.env.ONLIVE_CONFIG_ROOT)
  : path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'server');
const envPath = path.join(repoRoot, '.env');
const examplePath = path.join(repoRoot, '.env.example');
const hookExample = path.join(repoRoot, 'infra', 'mediamtx', 'hooks', 'hook-env.example.bat');
const hookTarget = path.join(repoRoot, 'infra', 'mediamtx', 'hooks', 'hook-env.bat');

const TOTAL_STEPS = 9;

/* ===========================================================================
 *  Konzol
 * ======================================================================== */

const line = (text = '') => process.stdout.write(`${text}\n`);
const rule = () => line('  ' + '-'.repeat(66));

function banner() {
  line();
  line('  ' + '='.repeat(66));
  line('     OnLIVE — beállító varázsló');
  line('  ' + '='.repeat(66));
  line();
  line('  Végigkérdezem a fontos beállításokat, és beírom őket a helyükre.');
  line('  A jelszavakat titkosítva (scrypt hash) tárolom — nem kell fájlt');
  line('  szerkesztened.');
  line();
  line('  · ENTER          = marad a jelenlegi/ajánlott érték');
  line('  · Ctrl+C         = kilépés mentés nélkül');
  line('  · A végén összefoglalót kapsz, és csak akkor írok bármit, ha rábólintasz.');
  line();
}

function step(number, title) {
  line();
  rule();
  line(`  [${number}/${TOTAL_STEPS}]  ${title}`);
  rule();
}

const note = (text) => line(`         ${text}`);
const ok = (text) => line(`  OK     ${text}`);
const warn = (text) => line(`  FIGY   ${text}`);
const fail = (text) => line(`  HIBA   ${text}`);

/* ===========================================================================
 *  Bekérés
 * ======================================================================== */

const rl = createInterface({ input: process.stdin, output: process.stdout });

/**
 * Rejtett gépelés.
 *
 * A readline minden leütést visszaír a konzolra; ezt kapcsoljuk ki jelszónál.
 * Szándékosan semmit nem írunk helyette (csillagot sem): a csillagok száma
 * elárulja a jelszó hosszát, és a törlés/beillesztés kezelése is félrecsúszik
 * tőlük. A `sudo` ugyanezt csinálja.
 */
let muted = false;
rl._writeToOutput = (text) => {
  if (!muted) rl.output.write(text);
};

let aborted = false;
/** Igaz, ha már írtunk lemezre — a hibaüzenet ne állítson valótlant. */
let writesStarted = false;
rl.on('SIGINT', () => {
  aborted = true;
  line();
  line();
  warn('Megszakítva — semmit nem írtam át.');
  rl.close();
  process.exit(130);
});

/**
 * Egyetlen sor beolvasása.
 *
 * A readline `question()`-je HELYETT az aszinkron iterátort használjuk. Az ok
 * nem elvi: csővezetéken (teszt, automatizált telepítés) a readline egyszerre
 * kapja meg az összes sort, és sorban ki is bocsátja őket — a `question()`
 * viszont csak azt a sort kapja el, amelyikre épp várt, a többi elveszik, a
 * varázsló pedig szó nélkül megáll a második kérdésnél. Az iterátor a
 * sorok között megállítja a bemenetet, tehát egy sem tűnik el.
 */
const lines = rl[Symbol.asyncIterator]();

async function prompt(text) {
  process.stdout.write(text);
  const { value, done } = await lines.next();
  if (done) throw new Error('Elfogyott a bemenet — a beállítás félbeszakadt.');
  return value;
}

async function ask(question, { fallback = '' } = {}) {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await prompt(`  ${question}${suffix}\n  > `)).trim();
  return answer || fallback;
}

async function askSecret(question) {
  muted = true;
  try {
    return await prompt(`  ${question}\n  > `);
  } finally {
    muted = false;
    line();
  }
}

async function askYesNo(question, { fallback = true } = {}) {
  const hint = fallback ? 'I/n' : 'i/N';
  for (;;) {
    const answer = (await prompt(`  ${question} (${hint})\n  > `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (['i', 'igen', 'y', 'yes'].includes(answer)) return true;
    if (['n', 'nem', 'no'].includes(answer)) return false;
    note('Válaszolj i vagy n betűvel.');
  }
}

/**
 * Számozott választás.
 * @param {Array<{label: string, value: any}>} options
 */
async function askChoice(question, options, { fallback = 1 } = {}) {
  line(`  ${question}`);
  options.forEach((option, index) => line(`     ${index + 1}) ${option.label}`));

  for (;;) {
    const answer = (await prompt('  > ')).trim() || String(fallback);
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].value;
    }
    note(`Írj be egy számot 1 és ${options.length} között.`);
  }
}

/* ===========================================================================
 *  Kiinduló állapot
 * ======================================================================== */

function loadEnv() {
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    return { content, values: parseEnvContent(content), fresh: false };
  }
  if (existsSync(examplePath)) {
    const content = readFileSync(examplePath, 'utf8');
    // A sablon példaértékei NEM alapértelmezések: a `valtoztasd-meg` sorokat
    // ürességnek vesszük, különben a varázsló felajánlaná őket megtartásra.
    const values = parseEnvContent(content);
    for (const key of ['ONLIVE_STREAM_KEY', 'ONLIVE_ADMIN_PASSWORD', 'ONLIVE_HOOK_SECRET']) {
      if (isPlaceholder(values[key])) values[key] = '';
    }
    return { content, values, fresh: true };
  }
  return { content: '', values: {}, fresh: true };
}

const isPlaceholder = (value) => !value
  || ['valtoztasd-meg', 'változtasd-meg', 'changeme'].includes(String(value).toLowerCase());

/* ===========================================================================
 *  A varázsló
 * ======================================================================== */

async function main() {
  banner();

  const { content: envContent, values: env, fresh } = loadEnv();
  if (fresh) {
    note(`Még nincs .env — a ${path.basename(examplePath)} sablonból indulok.`);
  } else {
    note(`Meglévő beállítások: ${envPath}`);
  }

  const dataDir = env.ONLIVE_DATA_DIR || path.join(serverDir, 'data');

  /** Amit a végén beírunk. Kulcs → érték, `null` = a sor törlése. */
  const updates = {};
  /** Emberi összefoglaló sorok. */
  const summary = [];
  /** A .env-en kívüli teendők. */
  const actions = [];

  /* --- 1. Port ---------------------------------------------------------- */

  step(1, 'A vezérlő szerver portja');
  note('Ezen érhető el az admin felület és a /live oldal a saját gépeden.');
  note('Ezt a portot kell megadni a Cloudflare Tunnelnek is (localhost:PORT).');
  line();

  const settingsStore = new ServerSettingsStore({
    dataDir,
    envPort: env.ONLIVE_SERVER_PORT,
  });
  const currentPort = settingsStore.configured;
  if (currentPort.source !== 'alapertelmezes') {
    note(`Jelenleg: ${currentPort.port} (forrás: ${currentPort.source})`);
  }

  let port = currentPort.port;
  for (;;) {
    const answer = await ask('Port', { fallback: String(port) });
    const assessment = assessPort(answer);
    if (!assessment.ok) {
      fail(assessment.error);
      continue;
    }
    if (assessment.warning) warn(assessment.warning);
    port = assessment.port;
    break;
  }
  updates.ONLIVE_SERVER_PORT = String(port);
  actions.push({ id: 'port', label: `port beírása a data/server.json-ba (${port})` });
  summary.push(['Szerver port', String(port)]);
  ok(`Helyi cím: http://localhost:${port}/admin`);

  /* --- 2. Admin jelszó -------------------------------------------------- */

  step(2, 'Admin jelszó');
  note('Ezzel lépsz be az /admin felületre. Csak a hash-e tárolódik, a jelszó');
  note('magát sehol nem írom le — így a .env kiszivárgása sem ad belépést.');
  line();

  const hasHash = Boolean(env.ONLIVE_ADMIN_PASSWORD_HASH);
  const hasPlain = Boolean(env.ONLIVE_ADMIN_PASSWORD) && !isPlaceholder(env.ONLIVE_ADMIN_PASSWORD);
  if (hasHash) note('Van már beállított (hash-elt) admin jelszó.');
  if (hasPlain) warn('A .env-ben NYERS jelszó áll — a varázsló ezt hash-re cseréli.');

  const changePassword = !hasHash || hasPlain
    ? true
    : await askYesNo('Lecseréled a jelszót?', { fallback: false });

  if (!changePassword) {
    ok('Marad a jelenlegi jelszó.');
    summary.push(['Admin jelszó', 'változatlan']);
  } else {
    const password = await readPassword();
    updates.ONLIVE_ADMIN_PASSWORD_HASH = hashPassword(password);
    updates.ONLIVE_ADMIN_PASSWORD = null;      // a nyers sor törlése
    summary.push(['Admin jelszó', 'új, hash-elve tárolva']);
    ok('A jelszó hash-elve kerül a .env-be.');
  }

  /* --- 3. Streamkulcs --------------------------------------------------- */

  step(3, 'Streamkulcs');
  note('A telefon ezzel hitelesít a WHIP ingest felé. Ez az EGYETLEN védelme —');
  note('aki tudja, a nevedben publikálhat. A szerver csak a hash-ét tárolja.');
  line();

  const keyStore = new StreamKeyStore({ dataDir, fallbackKey: env.ONLIVE_STREAM_KEY ?? '' });
  await keyStore.ready;
  const keyStatus = keyStore.status();

  if (keyStatus.configured && keyStatus.source === 'felulet') {
    note(`Van már kulcs (létrehozva: ${keyStatus.createdAt ?? 'ismeretlen'}).`);
  } else if (keyStatus.source === 'env') {
    warn('A kulcs még a .env-ben áll, nyers szövegként — érdemes lecserélni.');
  }

  const keyChoice = await askChoice('Mit csináljunk?', [
    { label: 'Generálj egyet (ajánlott)', value: 'generate' },
    { label: 'Magam adom meg', value: 'manual' },
    ...(keyStatus.configured ? [{ label: 'Maradjon a jelenlegi', value: 'keep' }] : []),
  ], { fallback: 1 });

  let streamKey = null;
  if (keyChoice === 'generate') {
    streamKey = generateStreamKey(32);
  } else if (keyChoice === 'manual') {
    streamKey = await readStreamKey();
  }

  if (streamKey) {
    actions.push({ id: 'streamkey', label: 'streamkulcs mentése hash-elve (data/stream-key.json)' });
    // A nyers érték nem maradhat a .env-ben: a tár ilyenkor is azt tekintené
    // tartaléknak, vagyis egy régi (vagy a sablonból ott maradt példa) kulcs
    // tovább élne a hash-elt mellett.
    updates.ONLIVE_STREAM_KEY = '';
    summary.push(['Streamkulcs', keyChoice === 'generate' ? 'új, generált' : 'új, kézi']);
  } else {
    ok('Marad a jelenlegi kulcs.');
    summary.push(['Streamkulcs', 'változatlan']);
  }

  /* --- 4. Lejátszási token ---------------------------------------------- */

  step(4, 'A /live oldal védelme');
  note('Üresen hagyva a /live NYILVÁNOS — az OBS Browser Source-ba így elég a');
  note('puszta URL. Tokennel minden lejátszás ?token=… paramétert kér.');
  line();

  const hasLiveToken = Boolean(env.ONLIVE_LIVE_TOKEN);
  if (hasLiveToken) note('Jelenleg van beállítva token.');

  const wantToken = await askYesNo('Legyen token a /live oldalon?', { fallback: hasLiveToken });
  if (wantToken && !hasLiveToken) {
    updates.ONLIVE_LIVE_TOKEN = generateKey(16);
    summary.push(['/live token', 'új, generált']);
  } else if (wantToken) {
    const regenerate = await askYesNo('Új tokent generáljak?', { fallback: false });
    if (regenerate) {
      updates.ONLIVE_LIVE_TOKEN = generateKey(16);
      summary.push(['/live token', 'új, generált']);
    } else {
      summary.push(['/live token', 'változatlan']);
    }
  } else {
    if (hasLiveToken) updates.ONLIVE_LIVE_TOKEN = '';
    summary.push(['/live token', 'nincs — az oldal nyilvános']);
  }

  /* --- 5. Publikus címek ------------------------------------------------ */

  step(5, 'Publikus címek (Cloudflare Tunnel)');
  note('Ezek a fix, kívülről elérhető címek. Ha még nincs tunneled, hagyd');
  note('ENTER-rel — később bármikor újrafuttathatod ezt a varázslót.');
  line();

  const urls = {
    ONLIVE_PUBLIC_ADMIN_URL: env.ONLIVE_PUBLIC_ADMIN_URL ?? '',
    ONLIVE_PUBLIC_LIVE_URL: env.ONLIVE_PUBLIC_LIVE_URL ?? '',
    ONLIVE_PUBLIC_INGEST_URL: env.ONLIVE_PUBLIC_INGEST_URL ?? '',
  };
  const domain = await ask('Fődomain (pl. galandras.com), vagy ENTER a jelenlegiek megtartásához');

  if (domain) {
    const clean = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    urls.ONLIVE_PUBLIC_ADMIN_URL = `https://admin.${clean}`;
    urls.ONLIVE_PUBLIC_LIVE_URL = `https://live.${clean}`;
    urls.ONLIVE_PUBLIC_INGEST_URL = `https://ingest.${clean}`;

    line();
    note(`admin  : ${urls.ONLIVE_PUBLIC_ADMIN_URL}`);
    note(`live   : ${urls.ONLIVE_PUBLIC_LIVE_URL}`);
    note(`ingest : ${urls.ONLIVE_PUBLIC_INGEST_URL}`);
    line();

    if (!await askYesNo('Jó így?', { fallback: true })) {
      urls.ONLIVE_PUBLIC_ADMIN_URL = await ask('Admin URL', { fallback: urls.ONLIVE_PUBLIC_ADMIN_URL });
      urls.ONLIVE_PUBLIC_LIVE_URL = await ask('Live URL', { fallback: urls.ONLIVE_PUBLIC_LIVE_URL });
      urls.ONLIVE_PUBLIC_INGEST_URL = await ask('Ingest URL', { fallback: urls.ONLIVE_PUBLIC_INGEST_URL });
    }
    Object.assign(updates, urls);
    summary.push(['Publikus címek', urls.ONLIVE_PUBLIC_ADMIN_URL.replace('admin.', '*.')]);
  } else {
    summary.push(['Publikus címek', urls.ONLIVE_PUBLIC_ADMIN_URL || '(nincs megadva)']);
  }

  /* --- 6. Stream útvonal ------------------------------------------------ */

  step(6, 'Stream útvonal');
  note('Ez a név szerepel a WHIP címben, amit a telefon hív:');
  note(`   ${urls.ONLIVE_PUBLIC_INGEST_URL || 'https://ingest.pelda.com'}/<útvonal>/whip`);
  line();

  const streamPath = await ask('Útvonal', { fallback: env.ONLIVE_STREAM_PATH || 'onlive' });
  updates.ONLIVE_STREAM_PATH = streamPath;
  summary.push(['Stream útvonal', streamPath]);

  /* --- 7. MediaMTX ------------------------------------------------------ */

  step(7, 'MediaMTX (a médiafogadó)');
  note('A telefon ide publikál. A szerver induláskor elindítja, ha megtalálja.');
  line();

  const mediamtxPath = await ask('mediamtx.exe útvonala', {
    fallback: env.ONLIVE_MEDIAMTX_PATH || 'C:\\OnLIVE\\mediamtx\\mediamtx.exe',
  });
  const mediamtxConfig = await ask('mediamtx.yml útvonala', {
    fallback: env.ONLIVE_MEDIAMTX_CONFIG || path.join(path.dirname(mediamtxPath), 'mediamtx.yml'),
  });

  updates.ONLIVE_MEDIAMTX_PATH = mediamtxPath;
  updates.ONLIVE_MEDIAMTX_CONFIG = mediamtxConfig;

  if (existsSync(mediamtxPath)) ok('Megvan a futtatható fájl.');
  else warn('Ezen az útvonalon most nincs fájl — telepítés: infra\\mediamtx\\install-mediamtx.ps1');
  summary.push(['MediaMTX', mediamtxPath]);

  /* --- 8. Tunnel service ------------------------------------------------ */

  step(8, 'Cloudflare Tunnel service');
  note('A Windows service neve, amit a start.bat és a watchdog keres.');
  line();

  const tunnelService = await ask('Service neve', {
    fallback: env.ONLIVE_TUNNEL_SERVICE || 'cloudflared',
  });
  updates.ONLIVE_TUNNEL_SERVICE = tunnelService;
  summary.push(['Tunnel service', tunnelService]);

  /* --- 9. Hook titok ---------------------------------------------------- */

  step(9, 'Hook titok (automatikus)');
  note('A MediaMTX ezzel jelzi a szervernek, hogy elindult vagy elfogyott az');
  note('adás. Két helyen kell egyeznie — mindkettőt én írom be.');
  line();

  const hookAssessment = assessSecret(env.ONLIVE_HOOK_SECRET, { name: 'Hook titok', minLength: 20 });
  let hookSecret = env.ONLIVE_HOOK_SECRET ?? '';

  if (hookAssessment.level !== 'strong') {
    if (hookAssessment.level === 'missing') note('Még nincs beállítva — generálok egyet.');
    else warn(hookAssessment.message);
    hookSecret = generateKey(16);
    updates.ONLIVE_HOOK_SECRET = hookSecret;
    summary.push(['Hook titok', 'új, generált']);
  } else if (await askYesNo('Új hook titkot generáljak?', { fallback: false })) {
    hookSecret = generateKey(16);
    updates.ONLIVE_HOOK_SECRET = hookSecret;
    summary.push(['Hook titok', 'új, generált']);
  } else {
    summary.push(['Hook titok', 'változatlan']);
  }

  if (existsSync(hookExample) || existsSync(hookTarget)) {
    actions.push({ id: 'hook-env', label: `hook-env.bat frissítése (port + titok)` });
  }

  /* --- Összefoglaló ----------------------------------------------------- */

  line();
  line();
  line('  ' + '='.repeat(66));
  line('     Összefoglaló');
  line('  ' + '='.repeat(66));
  line();
  for (const [label, value] of summary) {
    line(`     ${label.padEnd(20)} ${value}`);
  }
  line();
  line('  Amit írni fogok:');
  line(`     · ${envPath}`);
  for (const action of actions) line(`     · ${action.label}`);
  if (!fresh) line(`     · biztonsági mentés: ${envPath}.bak`);
  line();

  if (!await askYesNo('Mehet?', { fallback: true })) {
    warn('Nem írtam semmit.');
    return 1;
  }

  /* --- Írás ------------------------------------------------------------- */

  line();
  writesStarted = true;
  if (!fresh) {
    copyFileSync(envPath, `${envPath}.bak`);
    ok(`Mentés: ${path.basename(envPath)}.bak`);
  }

  writeFileSync(envPath, updateEnvContent(envContent, updates), 'utf8');
  ok(`Kész: ${envPath}`);

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  await settingsStore.setPort(port, { by: 'config.bat' });
  ok(`Port elmentve (${port}) — a következő indításkor lép életbe.`);

  if (streamKey) {
    await keyStore.set(streamKey, {
      by: 'config.bat',
      origin: keyChoice === 'generate' ? 'generalt' : 'kezi',
    });
    ok('Streamkulcs elmentve, hash-elve.');
  }

  const hookResult = writeHookEnv({ port, secret: hookSecret });
  if (hookResult) ok(hookResult);

  /* --- Amit még tudni kell ---------------------------------------------- */

  line();
  if (streamKey) {
    line('  ' + '='.repeat(66));
    line('     A STREAMKULCS — írd fel MOST');
    line('  ' + '='.repeat(66));
    line();
    line(`        ${streamKey}`);
    line();
    note('Ezt kell beírni a telefonon: fogaskerék → Kapcsolat → Streamkulcs.');
    note('Nem tudom újra megmutatni: a szerveren csak a hash-e van meg.');
    line();
  }

  const mismatches = checkPortDependencies(port, { mediamtxConfig, repoRoot })
    .filter((check) => !check.ok);
  if (mismatches.length) {
    line();
    warn('A port máshol még a régin áll — ezeket kézzel kell átírni:');
    for (const check of mismatches) note(describeMismatch(check));
  }

  line();
  line('  ' + '='.repeat(66));
  line('     Kész. Indítás: start.bat');
  line('  ' + '='.repeat(66));
  line();
  note(`Admin felület:  http://localhost:${port}/admin`);
  note('Belépés az imént megadott jelszóval.');
  line();

  return 0;
}

/* ===========================================================================
 *  Részletek
 * ======================================================================== */

/** Jelszó bekérése kétszer, erősség-ellenőrzéssel. */
async function readPassword() {
  for (;;) {
    const first = await askSecret('Új admin jelszó (a gépelés nem látszik)');
    if (!first) {
      fail('A jelszó nem lehet üres.');
      continue;
    }

    const again = await askSecret('Még egyszer');
    if (first !== again) {
      fail('A két jelszó nem egyezik — próbáljuk újra.');
      continue;
    }

    const assessment = assessSecret(first, { name: 'Admin jelszó', minLength: 12 });
    if (assessment.level !== 'strong') {
      warn(assessment.message);
      if (!await askYesNo('Így is megfelel?', { fallback: false })) continue;
    }
    return first;
  }
}

/** Kézi streamkulcs a szabályok ellenőrzésével. */
async function readStreamKey() {
  line();
  note('Követelmények:');
  for (const item of keyRules()) note(`   · ${item.label}`);
  line();

  for (;;) {
    // Szándékosan LÁTHATÓ: ezt a telefonon is be kell gépelni, és a felhasználó
    // ül a gép előtt. A titkosítás a tárolásnál számít, nem itt.
    const key = await ask('Streamkulcs');
    const assessment = assessStreamKey(key);
    if (assessment.ok) return key;

    fail(assessment.error ?? 'A kulcs nem felel meg a követelményeknek.');
    for (const check of assessment.checks) {
      if (!check.ok) note(`   hiányzik: ${check.label}`);
    }
  }
}

/**
 * A MediaMTX hookjainak környezete.
 *
 * A hookok külön folyamatban futnak (a MediaMTX indítja őket), ezért nem látják
 * a szerver `.env`-jét — a titoknak és a portnak itt is szerepelnie kell.
 * Ha ez a két érték elcsúszik, a szerver 401-gyel dobja el a hookokat, és a
 * `/live` oldal csak a poll-ra reagál, késve.
 */
function writeHookEnv({ port, secret }) {
  const source = existsSync(hookTarget) ? hookTarget : hookExample;
  if (!existsSync(source)) return null;

  let content = readFileSync(source, 'utf8');
  content = content.replace(
    /^(\s*set ONLIVE_CONTROL_URL=).*$/m,
    `$1http://127.0.0.1:${port}`,
  );
  if (secret) {
    content = content.replace(/^(\s*set ONLIVE_HOOK_SECRET=).*$/m, `$1${secret}`);
  }

  writeFileSync(hookTarget, content, 'utf8');
  return `Hook környezet kész: ${hookTarget}`;
}

/* ===========================================================================
 *  Indítás
 * ======================================================================== */

main()
  .then((code) => {
    // Nem `process.exit()`: ha a kimenet csövön megy (teszt, naplózás), a
    // kilépés elvághatja a még ki nem írt sorokat. A readline lezárása után
    // a folyamat magától véget ér.
    process.exitCode = code ?? 0;
    rl.close();
  })
  .catch((error) => {
    if (aborted) return;
    line();
    fail(error?.message ?? String(error));
    line();
    note(writesStarted
      ? 'Az írás közben álltam meg — nézd meg a .env-et és a .env.bak mentést.'
      : 'Semmit nem írtam át. Ha ez nem világos, küldd el ezt a sort:');
    note(String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
    process.exitCode = 1;
    rl.close();
  });
