#!/usr/bin/env node
/**
 * Kulcs- és jelszó-generáló (10. szegmens).
 *
 *   npm run keygen                → lejátszási token, hook titok
 *   npm run hash-password -- titkos123
 *
 * Miért van rá külön eszköz: kézzel kitalált „valami-hosszabb-jelszo" helyett
 * generált, 192 bites véletlen kulcs kell — ez az eszköz pont azt adja,
 * másolható formában.
 *
 * A STREAMKULCS 1.0.010 óta NEM itt készül: az admin felület Streamkulcs
 * fülén jön létre, és a szerver csak a hash-ét tárolja. Ezért itt már nem is
 * generálunk olyat — különben a .env-be másolt, nyers érték versenyezne a
 * felületen létrehozottal.
 */

import { generateKey, hashPassword, assessSecret } from '../src/security/passwords.js';

const [, , command, ...args] = process.argv;

if (command === 'hash') {
  const password = args.join(' ');
  if (!password) {
    console.error('Használat: npm run hash-password -- <jelszó>');
    process.exit(1);
  }
  const check = assessSecret(password, { name: 'Jelszó', minLength: 12 });
  if (check.level !== 'strong') console.error(`FIGYELEM — ${check.message}\n`);

  console.log('Másold ezt a sort a .env fájlba (a projekt gyökerében):\n');
  console.log(`ONLIVE_ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
  console.log('\nUtána:');
  console.log('  1. töröld a .env-ből az ONLIVE_ADMIN_PASSWORD sort,');
  console.log('  2. indítsd újra a szervert,');
  console.log('  3. lépj be: http://localhost:8080/admin — ott magát a jelszót');
  console.log('     írod be, nem ezt a hash-t.');
  process.exit(0);
}

console.log('Generált titkok — másold a .env fájlba:\n');
console.log(`ONLIVE_LIVE_TOKEN=${generateKey(16)}`);
console.log(`ONLIVE_HOOK_SECRET=${generateKey(16)}`);
console.log('\nAmi NEM itt készül:');
console.log('  · admin jelszó → npm run hash-password -- "a jelszavad"');
console.log('  · streamkulcs  → az admin felület Streamkulcs fülén');
console.log('    (a szerver csak a hash-ét tárolja, a MediaMTX pedig tőle kérdez)');
