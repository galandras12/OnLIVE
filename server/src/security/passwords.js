/**
 * Jelszó-kezelés és kulcs-erősség (10. szegmens).
 *
 * Az admin jelszó **hash-elve** tárolható (`ONLIVE_ADMIN_PASSWORD_HASH`),
 * scrypt algoritmussal. A sima szöveges `ONLIVE_ADMIN_PASSWORD` továbbra is
 * működik — kényelmi okból, de a szerver induláskor figyelmeztet rá.
 *
 * Miért számít, ha a `.env`-ben úgyis ott a titok: a hash miatt a fájl
 * kiszivárgása nem ad azonnal használható jelszót, és a naplókba, hibaüzenetekbe
 * sem kerülhet be véletlenül a nyers érték.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32 };

/** `scrypt$<N>$<r>$<p>$<só base64>$<hash base64>` */
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 1) {
    throw new Error('A jelszó nem lehet üres.');
  }
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keyLength, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/** Időzítés-független ellenőrzés hash vagy sima szöveg ellen. */
export function verifyPassword(password, { hash, plain } = {}) {
  if (typeof password !== 'string' || !password) return false;

  if (hash) {
    try {
      const [scheme, n, r, p, saltB64, hashB64] = hash.split('$');
      if (scheme !== 'scrypt') return false;

      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      const derived = scryptSync(password, salt, expected.length, {
        N: Number(n), r: Number(r), p: Number(p),
      });
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  if (plain) return constantTimeEquals(password, plain);
  return false;
}

export function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // A hosszkülönbség önmagában is információ, de a tartalmat így sem
    // szivárogtatjuk: fix idejű összehasonlítást futtatunk önmagával.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/** Kriptográfiailag erős, URL-biztos kulcs (streamkulcs, lejátszási token). */
export function generateKey(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Titok-erősség osztályozása.
 *
 * A streamkulcs a WHIP ingest EGYETLEN védelme: aki kitalálja, idegen
 * streamet publikálhat a nevünkben. Ezért az induló ellenőrzés külön szól,
 * ha rövid, alapértelmezett vagy kitalálható értéket talál.
 */
export function assessSecret(value, { name = 'titok', minLength = 20 } = {}) {
  if (!value) {
    return { level: 'missing', message: `Nincs beállítva: ${name}.` };
  }
  if (WEAK_VALUES.has(value.toLowerCase())) {
    return { level: 'weak', message: `${name}: alapértelmezett/példa érték — cseréld le!` };
  }
  if (value.length < minLength) {
    return { level: 'weak', message: `${name}: túl rövid (${value.length} karakter, ajánlott legalább ${minLength}).` };
  }

  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
  if (variety < 2) {
    return { level: 'fair', message: `${name}: egyveretű karakterkészlet — generált kulcsot használj.` };
  }
  return { level: 'strong', message: `${name}: rendben.` };
}

const WEAK_VALUES = new Set([
  'valtoztasd-meg', 'változtasd-meg', 'changeme', 'password', 'jelszo', 'jelszó',
  'titok', 'secret', 'admin', 'onlive', 'test', 'teszt', '1234', '123456',
  'streamkulcs', 'valtoztasd_meg',
]);
