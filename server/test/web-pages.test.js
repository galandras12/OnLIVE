/**
 * A kiszolgált oldalak épsége (1.0.010).
 *
 * MIÉRT VAN EZ A FÁJL: a 10. szegmensben egy sortörés csúszott egy
 * aposztrófos szöveg közepébe (`join('` … `')`). Egyetlen karakter, de az
 * **egész admin oldal** szkriptje elszállt tőle — fülek, gombok, állapot,
 * minden néma maradt. A szerver tesztjei ebből semmit nem láttak, mert a
 * hiba csak a böngészőben, a JS elemzésekor jelentkezik.
 *
 * Ez a teszt ugyanazt csinálja, amit a böngésző: elemzi minden oldal beágyazott
 * szkriptjét. Nem futtatja őket — csak azt nézi, hogy értelmezhetők-e.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../src/web/', import.meta.url));
const pages = readdirSync(webDir).filter((name) => name.endsWith('.html'));

/** Beágyazott (nem `src`-vel hivatkozott) szkriptek kigyűjtése. */
const inlineScripts = (html) =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test('van mit ellenőrizni', () => {
  assert.ok(pages.length >= 8, `${pages.length} oldal — kevesebb, mint várt`);
});

for (const page of pages) {
  test(`${page}: a beágyazott szkriptek értelmezhetők`, () => {
    const scripts = inlineScripts(readFileSync(path.join(webDir, page), 'utf8'));

    scripts.forEach((code, index) => {
      assert.doesNotThrow(
        // `new Function` elemzi a kódot, de nem futtatja — pont ez kell.
        () => new Function(code),
        `${page} #${index}. szkriptje nem értelmezhető`,
      );
    });
  });
}

test('a külön kiszolgált admin-auth.js is ép', () => {
  const code = readFileSync(path.join(webDir, 'admin-auth.js'), 'utf8');
  assert.doesNotThrow(() => new Function(code));
});

test('REGRESSZIÓ: nincs sortörés aposztrófos szöveg közepén', () => {
  // A konkrét hiba, ami miatt ez a fájl létezik. A szintaxis-ellenőrzés már
  // megfogja, de a hibaüzenet így mondja meg, MIT keressen az ember.
  for (const page of pages) {
    const html = readFileSync(path.join(webDir, page), 'utf8');
    for (const [index, line] of html.split('\n').entries()) {
      const inScript = true; // a szintaxis-ellenőrzés a pontos szűrő; ez csak jelzés
      if (!inScript) continue;

      const quotes = (line.match(/(?<!\\)'/g) ?? []).length;
      const looksLikeCode = /\b(join|split|replace|textContent|innerHTML)\s*\(/.test(line);
      if (looksLikeCode && quotes % 2 === 1) {
        assert.fail(`${page}:${index + 1} — páratlan aposztróf, valószínűleg elveszett \\n:\n${line.trim()}`);
      }
    }
  }
});
