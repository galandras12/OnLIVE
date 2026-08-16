/**
 * A `config.bat` épsége (1.0.017).
 *
 * Ugyanaz a veszély, mint a `start.bat`-nál: egyetlen escape-eletlen zárójel
 * vagy egy ékezetes betű elég ahhoz, hogy az ablak felvillanjon és eltűnjön,
 * mielőtt bármit kiírna. A `.bat`-ot itt nem tudjuk futtatni (Windows kell
 * hozzá), ezért a megfogható hibákat elemzéssel keressük.
 *
 * A varázsló futásáról a `config-wizard.test.js` szól — ez a fájl csak az
 * indítóról.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const batFile = fileURLToPath(new URL('../../config.bat', import.meta.url));
const raw = readFileSync(batFile, 'latin1');
const lines = raw.split(/\r?\n/);

const codeLines = lines
  .map((text, index) => ({ text, line: index + 1 }))
  .filter(({ text }) => text.trim() && !/^\s*rem\b/i.test(text.trim()));

const wizardFile = fileURLToPath(new URL('../tools/config.js', import.meta.url));
const wizard = readFileSync(wizardFile, 'utf8');

test('a fájl tisztán ASCII', () => {
  // A Windows konzol alapértelmezett kódlapja nem UTF-8.
  const bad = [...raw].map((ch, i) => [ch, i]).filter(([ch]) => ch.codePointAt(0) > 127);
  assert.equal(bad.length, 0, `nem ASCII karakter a ${bad[0]?.[1]}. bájtnál: ${bad[0]?.[0]}`);
});

test('a sorvégek CRLF-ek', () => {
  const lf = (raw.match(/(?<!\r)\n/g) ?? []).length;
  assert.equal(lf, 0, `${lf} magányos LF sorvég — a .bat CRLF-et vár`);
});

test('nincs escape-eletlen zárójel echo sorban', () => {
  for (const { text, line } of codeLines) {
    if (!/^\s*echo\b/i.test(text.trim())) continue;
    for (const match of text.matchAll(/[()]/g)) {
      assert.ok(
        text[match.index - 1] === '^',
        `config.bat:${line} — escape-eletlen ${match[0]} egy echo sorban:\n  ${text.trim()}`,
      );
    }
  }
});

test('nincs zárójeles if/else blokk', () => {
  for (const { text, line } of codeLines) {
    assert.ok(
      !/^\s*if\b.*\(\s*$/i.test(text),
      `config.bat:${line} — zárójeles blokk nyílik; használj goto-t helyette`,
    );
    assert.ok(
      !/^\s*\)\s*else\s*\(\s*$/i.test(text),
      `config.bat:${line} — ") else (" ág; használj goto-t helyette`,
    );
  }
});

test('minden goto célja létező címke', () => {
  const labels = new Set(
    lines
      .map((text) => /^\s*:([A-Za-z_][\w-]*)/.exec(text)?.[1]?.toLowerCase())
      .filter(Boolean),
  );

  for (const { text, line } of codeLines) {
    for (const match of text.matchAll(/\bgoto\s+:?([A-Za-z_][\w-]*)/gi)) {
      const target = match[1].toLowerCase();
      if (target === 'eof') continue;
      assert.ok(labels.has(target), `config.bat:${line} — nincs ilyen címke: :${match[1]}`);
    }
  }
});

test('minden hibaút a közös végén áll meg, nyitott ablakkal', () => {
  assert.match(raw, /^:end$/m, 'kell egy :end címke');

  const endIndex = raw.search(/^:end$/m);
  assert.ok(raw.indexOf('pause') > endIndex, 'a pause az :end szakaszban van');

  for (const label of ['no_node', 'no_wizard', 'cancelled']) {
    const start = raw.search(new RegExp(`^:${label}\\s*$`, 'm'));
    assert.ok(start > 0, `hiányzó ág: :${label}`);
    assert.match(raw.slice(start, start + 600), /goto :end/, `a :${label} ág nem vezet az :end-re`);
  }
});

test('a varázslót a helyéről indítja, és előbb ellenőrzi, hogy megvan-e', () => {
  assert.match(raw, /node tools\\config\.js/, 'a config.js indítása');
  assert.match(raw, /if not exist "%SERVER_DIR%\\tools\\config\.js" goto :no_wizard/);
});

test('a varázsló npm install nélkül is fut', () => {
  // Ezt ígéri a config.bat fejléce: a beállítás az ELSŐ lépés, még a
  // függőségek telepítése előtt. Ha ide bekerülne egy express/socket.io
  // import, a varázsló egy friss gépen „Cannot find module"-lal állna meg.
  const imports = [...wizard.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'kell import');

  for (const source of imports) {
    assert.ok(
      source.startsWith('node:') || source.startsWith('.'),
      `külső csomag importja: ${source} — ettől npm install nélkül elhasalna`,
    );
  }
  // Csak a futó sorok számítanak: a fejléc-komment épp azt magyarázza el,
  // hogy MIÉRT nincs itt npm install.
  const installs = codeLines.filter(({ text }) => /npm\s+install/i.test(text));
  assert.deepEqual(installs, [], 'a config.bat ne telepítsen függőséget');
});

test('a lépések száma egyezik a kiírt összesennel', () => {
  const total = Number(/const TOTAL_STEPS = (\d+);/.exec(wizard)?.[1]);
  const steps = [...wizard.matchAll(/^\s*step\((\d+), /gm)].map((m) => Number(m[1]));

  assert.equal(steps.length, total, `${steps.length} lépés van, de a fejléc ${total}-t ír`);
  assert.deepEqual(steps, Array.from({ length: total }, (_, index) => index + 1), 'a sorszámok folytonosak');
});
