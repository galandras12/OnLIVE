/**
 * A capture-beállítások közös szótára (1.0.101).
 *
 * Ugyanezek a nevek szerepelnek az Android app `settings/Quality.kt`-jában.
 * Amit a web felület küld, az a telefon enum-nevét viszi (`P1080`), amit a
 * telefon visszajelent, az címke (`1080p`) — a kettő közti fordítás is itt van,
 * hogy a naplóban ne látszódjon változásnak az, ami valójában ugyanaz.
 *
 * Miért külön fájl: a felbontás-lista három helyen élt (Android enum, szerver
 * validáció, admin HTML). A 2160p felvételekor derült ki, hogy egy listát
 * bővíteni könnyű, hármat viszont könnyű elfelejteni — a szerver oldali kettőt
 * innentől ez a modul adja, és a teszt is ezt ellenőrzi.
 */

/** Videó felbontások. A rövidebb oldal a mérvadó, az arányt az irány adja. */
export const RESOLUTIONS = Object.freeze([
  { name: 'P480', label: '480p', width: 854, height: 480 },
  { name: 'P720', label: '720p', width: 1280, height: 720 },
  { name: 'P1080', label: '1080p', width: 1920, height: 1080 },
  { name: 'P1440', label: '1440p', width: 2560, height: 1440 },
  { name: 'P2160', label: '2160p', width: 3840, height: 2160 },
]);

/**
 * Kép-irány (1.0.101).
 *
 * A telefon ezt az adás INDÍTÁSA előtt választja ki, és utána a capture ehhez
 * igazodik — nem ahhoz, ahogy a felhasználó épp tartja a készüléket.
 */
export const ORIENTATIONS = Object.freeze([
  { name: 'landscape', label: '16:9 fekvő', ratio: '16:9' },
  { name: 'portrait', label: '9:16 álló', ratio: '9:16' },
]);

/** Képfrissítés és hang — a validáció eddig is ezekkel dolgozott. */
export const FRAME_RATES = Object.freeze([24, 30, 50, 60]);
export const AUDIO_SAMPLE_RATES = Object.freeze([16_000, 44_100, 48_000]);
export const AUDIO_BITRATES = Object.freeze([32, 64, 96, 128]);

/**
 * Videó bitráta határok.
 *
 * A felső határ 2160p miatt emelkedett 12 000-ről: 4K-hoz 12 Mbit/s már
 * kevés, a régi korlát pedig némán levágta volna a felküldött értéket.
 */
export const VIDEO_BITRATE = Object.freeze({ minKbps: 500, maxKbps: 25_000 });

const RESOLUTION_NAMES = new Set(RESOLUTIONS.map((item) => item.name));
const ORIENTATION_NAMES = new Set(ORIENTATIONS.map((item) => item.name));

/** `P720` → `720p` — ahogy a telefon jelenti (settings/Quality.kt). */
export function resolutionLabel(value) {
  return String(value).replace(/^P(\d+)$/i, '$1p');
}

/** @returns {{ok: true, value: string} | {ok: false, error: string}} */
export function assessResolution(value) {
  const name = String(value ?? '').toUpperCase();
  if (!RESOLUTION_NAMES.has(name)) {
    return { ok: false, error: `Ismeretlen felbontás: ${value}` };
  }
  return { ok: true, value: name };
}

/** @returns {{ok: true, value: 'landscape'|'portrait'} | {ok: false, error: string}} */
export function assessOrientation(value) {
  const name = String(value ?? '').toLowerCase();
  if (!ORIENTATION_NAMES.has(name)) {
    return {
      ok: false,
      error: `Ismeretlen kép-irány: ${value} (várt: ${[...ORIENTATION_NAMES].join(', ')})`,
    };
  }
  return { ok: true, value: name };
}
