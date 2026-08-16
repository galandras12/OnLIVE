/**
 * Repó-higiénia (1.0.018).
 *
 * MIÉRT VAN EZ A FÁJL: az `android/gradle.properties` egy ideig **feloldatlan
 * merge-konfliktussal** volt commitolva — benne maradtak a
 * `<<<<<<< Updated upstream` / `>>>>>>> Stashed changes` sorok. Az ilyen fájl
 * nem hibaüzenettel jelentkezik: a Gradle a `.properties`-t soronként olvassa,
 * a jelölőkből értelmetlen kulcsok lesznek, és a build vagy hibásan viselkedik,
 * vagy ami rosszabb, észrevétlenül jól.
 *
 * Egy konfliktus-jelölő SOHA nem szándékos, ezért kereshető gépből is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'logs', 'data', 'build', '.gradle', '.idea', 'dist',
]);

/** Amit egyáltalán érdemes átnézni — a bináris fájlokat kihagyjuk. */
const TEXT_FILES = /\.(js|mjs|cjs|json|kts|kt|gradle|properties|toml|yml|yaml|md|bat|ps1|html|css|xml|txt|onlive)$/i;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT_FILES.test(entry)) yield full;
  }
}

test('nincs feloldatlan merge-konfliktus egyetlen fájlban sem', () => {
  // A mintát futásidőben rakjuk össze, hogy ez a fájl ne találjon rá önmagára.
  const markers = ['<'.repeat(7), '='.repeat(7), '>'.repeat(7)];
  const found = [];

  for (const file of walk(repoRoot)) {
    // A Markdownban a ```…``` blokkok IDÉZETEK: a changelog például pont azt
    // mutatja meg, hogyan néztek ki a jelölők. Azokat nem keressük.
    const content = file.endsWith('.md')
      ? readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '')
      : readFileSync(file, 'utf8');
    for (const marker of markers) {
      const pattern = new RegExp(`^${marker}(\\s|$)`, 'm');
      if (pattern.test(content)) {
        found.push(`${path.relative(repoRoot, file)} — ${marker}`);
        break;
      }
    }
  }

  assert.deepEqual(found, [], `konfliktus-jelölő maradt a fájlokban:\n  ${found.join('\n  ')}`);
});

test('a build-konfigurációk a helyükön vannak', () => {
  // Ha ezek bármelyike eltűnik vagy elgépelődik, a projekt nem szinkronizál.
  for (const file of [
    'android/gradle.properties',
    'android/gradle/libs.versions.toml',
    'android/gradle/wrapper/gradle-wrapper.properties',
    'android/settings.gradle.kts',
    'android/app/build.gradle.kts',
  ]) {
    assert.ok(
      statSync(path.join(repoRoot, file)).isFile(),
      `hiányzik: ${file}`,
    );
  }
});

test('az AGP és a Gradle verziója egymáshoz illik', () => {
  // Az AGP maga ellenőrzi induláskor: AGP 9.x → Gradle >= 9.5. Ha ez elcsúszik,
  // a build a legelső lépésnél áll meg, még a fordítás előtt.
  const versions = readFileSync(path.join(repoRoot, 'android/gradle/libs.versions.toml'), 'utf8');
  const wrapper = readFileSync(
    path.join(repoRoot, 'android/gradle/wrapper/gradle-wrapper.properties'), 'utf8',
  );

  const agp = /^agp\s*=\s*"(\d+)\.(\d+)/m.exec(versions);
  const gradle = /gradle-(\d+)\.(\d+)(?:\.\d+)?-bin\.zip/.exec(wrapper);
  assert.ok(agp, 'nem találom az agp verziót');
  assert.ok(gradle, 'nem találom a Gradle disztribúciót');

  const agpMajor = Number(agp[1]);
  const gradleVersion = Number(gradle[1]) + Number(gradle[2]) / 100;

  const minimum = agpMajor >= 9 ? 9.05 : 8.13;
  assert.ok(
    gradleVersion >= minimum,
    `AGP ${agp[1]}.${agp[2]} mellé legalább Gradle ${minimum} kell, `
    + `a wrapper viszont ${gradle[1]}.${gradle[2]}`,
  );
});
