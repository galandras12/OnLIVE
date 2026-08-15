#!/usr/bin/env node
/**
 * Kulcs- és jelszó-generáló (10. szegmens).
 *
 *   npm run keygen                → streamkulcs, lejátszási token, hook titok
 *   npm run hash-password -- titkos123
 *
 * Miért van rá külön eszköz: a streamkulcs a WHIP ingest EGYETLEN védelme.
 * Kézzel kitalált „valami-hosszabb-jelszo" helyett generált, 192 bites
 * véletlen kulcs kell — ez az eszköz pont azt adja, másolható formában.
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

  console.log('Másold a .env fájlba:\n');
  console.log(`ONLIVE_ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
  console.log('\nÉs töröld onnan az ONLIVE_ADMIN_PASSWORD sort.');
  process.exit(0);
}

console.log('Generált titkok — másold a .env fájlba:\n');
console.log(`ONLIVE_STREAM_KEY=${generateKey(24)}`);
console.log(`ONLIVE_LIVE_TOKEN=${generateKey(16)}`);
console.log(`ONLIVE_HOOK_SECRET=${generateKey(16)}`);
console.log('\nA streamkulcsot a MediaMTX konfigurációjába is be kell írni');
console.log('(infra/mediamtx/mediamtx.yml → authInternalUsers → publisher).');
