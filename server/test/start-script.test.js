/**
 * A `start.bat` épsége (1.0.012).
 *
 * MIÉRT VAN EZ A FÁJL: az 1.0.011-ig a `start.bat` **felvillant és eltűnt**.
 * Az ok egyetlen karakter volt:
 *
 *     if errorlevel 1 (
 *         echo   [!] A(z) "%TUNNEL_SERVICE%" service nincs telepitve.
 *
 * Zárójeles blokkon belül az escape-eletlen `)` LEZÁRJA a blokkot, így a
 * későbbi `) else (` szintaktikai hiba lett, a cmd pedig azonnal megszakította
 * a fájlt — mielőtt bármi hasznosat csinált volna.
 *
 * A `.bat`-ot itt nem tudjuk futtatni (Windows kell hozzá), ezért a
 * megfogható hibákat elemzéssel keressük: escape-eletlen zárójel, hiányzó
 * címke, nem ASCII karakter, hiányzó sorvégek.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../start.bat', import.meta.url));
const raw = readFileSync(file, 'latin1');
const lines = raw.split(/\r?\n/);

/** A `rem` sorok és a fejléc-kommentek nem futnak — azokat kihagyjuk. */
const codeLines = lines
  .map((text, index) => ({ text, line: index + 1 }))
  .filter(({ text }) => text.trim() && !/^\s*rem\b/i.test(text.trim()));

test('a fájl tisztán ASCII', () => {
  // A Windows konzol alapértelmezett kódlapja nem UTF-8: az ékezetek
  // olvashatatlan karakterekké esnének szét.
  const bad = [...raw].map((ch, i) => [ch, i]).filter(([ch]) => ch.codePointAt(0) > 127);
  assert.equal(bad.length, 0, `nem ASCII karakter a ${bad[0]?.[1]}. bájtnál: ${bad[0]?.[0]}`);
});

test('a sorvégek CRLF-ek', () => {
  const lf = (raw.match(/(?<!\r)\n/g) ?? []).length;
  assert.equal(lf, 0, `${lf} magányos LF sorvég — a .bat CRLF-et vár`);
});

test('REGRESSZIÓ: nincs escape-eletlen zárójel echo sorban', () => {
  // Ez az a hiba, ami miatt a fájl felvillant és eltűnt. Az `echo` sorokban
  // minden zárójelnek `^(` / `^)` alakban kell állnia.
  for (const { text, line } of codeLines) {
    if (!/^\s*echo\b/i.test(text.trim())) continue;

    for (const match of text.matchAll(/[()]/g)) {
      const escaped = text[match.index - 1] === '^';
      assert.ok(
        escaped,
        `start.bat:${line} — escape-eletlen ${match[0]} egy echo sorban:\n  ${text.trim()}`,
      );
    }
  }
});

test('nincs zárójeles if/else blokk', () => {
  // A biztos megoldás nem a gondos escape-elés, hanem az, hogy blokk se
  // legyen: a fájl `goto`-val ágazik el.
  for (const { text, line } of codeLines) {
    assert.ok(
      !/^\s*(if|for)\b.*\(\s*$/i.test(text),
      `start.bat:${line} — zárójeles blokk nyílik; használj goto-t helyette:\n  ${text.trim()}`,
    );
    assert.ok(
      !/^\s*\)\s*else\s*\(\s*$/i.test(text),
      `start.bat:${line} — ") else (" ág; használj goto-t helyette`,
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
      assert.ok(labels.has(target), `start.bat:${line} — nincs ilyen címke: :${match[1]}`);
    }
  }

  for (const { text, line } of codeLines) {
    for (const match of text.matchAll(/\bcall\s+:([A-Za-z_][\w-]*)/gi)) {
      assert.ok(
        labels.has(match[1].toLowerCase()),
        `start.bat:${line} — nincs ilyen szubrutin: :${match[1]}`,
      );
    }
  }
});

test('minden hibaút a közös végén áll meg, nyitott ablakkal', () => {
  // A lényeg, amit a felhasználó kért: az ablak ne tűnjön el magától.
  assert.match(raw, /^:end$/m, 'kell egy :end címke');
  assert.match(raw, /pause\s*>nul/i, 'a végén meg kell várni egy billentyűt');

  // A `pause` az `:end` szakaszban legyen, ne valahol előbb.
  const endIndex = raw.search(/^:end$/m);
  assert.ok(raw.indexOf('pause') > endIndex, 'a pause az :end után van');

  // Minden hibaüzenet-kiírás után `goto :end` következzen (nem esik ki a fájl).
  const errorLabels = ['no_node', 'no_npm', 'install_failed'];
  for (const label of errorLabels) {
    // A címke DEFINÍCIÓJÁT keressük (sor eleji `:label`), nem a rá mutató
    // `goto :label` hivatkozást — az előbb áll a fájlban.
    const start = raw.search(new RegExp(`^:${label}\\s*$`, 'm'));
    assert.ok(start > 0, `hiányzó hibaág: :${label}`);

    const section = raw.slice(start, start + 600);
    assert.match(section, /goto :end/, `a :${label} ág nem vezet az :end-re`);
  }
});

test('a naplósor átirányítása előtt van szóköz', () => {
  // Számjegyre végződő üzenetnél a `1>>` fájlkezelő-átirányítás lenne.
  const logLine = lines.find((text) => text.includes('%STARTUP_LOG%') && text.includes('>>'));
  assert.ok(logLine, 'kell naplózó sor');
  assert.match(logLine, /%~1 >>/, 'a %~1 és a >> között szóköz kell');
});

test('a lépések sorszámozása folytonos', () => {
  const steps = [...raw.matchAll(/call :step "(\d+)\/(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(steps.length >= 4, 'legyen legalább 4 lépés-kiírás');
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, 'a lépések növekvő sorrendben');
});
