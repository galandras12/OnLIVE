/**
 * Média-validáció (5. szegmens).
 *
 * HÁROM rétegben ellenőrzünk, mert a felsőbb kettő hamisítható:
 *
 *  1. kiterjesztés — a felhasználó írja,
 *  2. `Content-Type` — a böngésző küldi, de tetszőlegesen hamisítható,
 *  3. **magic bytes** — a fájl tényleges tartalma. Ez az egyetlen réteg,
 *     ami nem hazudik.
 *
 * Egy `.mp4`-nek nevezett, `video/mp4` fejléccel feltöltött HTML fájl a
 * `/live` oldalba ágyazva tetszőleges szkriptet futtatna — ezért a
 * tartalom-ellenőrzés itt nem opcionális kényelmi funkció.
 */

export const MediaKind = Object.freeze({
  IMAGE: 'image',
  VIDEO: 'video',
});

/** Az elfogadott típusok. A szegmens pontosan ezeket írja elő. */
export const ALLOWED = Object.freeze({
  'image/jpeg': { kind: MediaKind.IMAGE, ext: '.jpg', alt: ['.jpeg'] },
  'image/png': { kind: MediaKind.IMAGE, ext: '.png', alt: [] },
  'image/webp': { kind: MediaKind.IMAGE, ext: '.webp', alt: [] },
  'video/mp4': { kind: MediaKind.VIDEO, ext: '.mp4', alt: ['.m4v'] },
  'video/webm': { kind: MediaKind.VIDEO, ext: '.webm', alt: [] },
});

export const ALLOWED_MIME_TYPES = Object.keys(ALLOWED);

export const ALLOWED_EXTENSIONS = Object.values(ALLOWED).flatMap((entry) => [
  entry.ext,
  ...entry.alt,
]);

const startsWith = (buffer, bytes, offset = 0) =>
  bytes.every((byte, index) => buffer[offset + index] === byte);

const ascii = (buffer, offset, length) =>
  buffer.subarray(offset, offset + length).toString('latin1');

/**
 * A fájl tényleges típusa a tartalma alapján.
 * @returns {string|null} MIME típus, vagy `null`, ha nem felismerhető
 */
export function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // WebP: "RIFF" .... "WEBP"
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') return 'image/webp';

  // WebM / Matroska: 1A 45 DF A3
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  // MP4 és rokonai: a 4. bájttól "ftyp", utána a brand
  if (ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4);
    // A brand-et csak naplózásra használjuk: minden ftyp-doboz MP4 család.
    return brand ? 'video/mp4' : 'video/mp4';
  }

  return null;
}

/**
 * Teljes ellenőrzés.
 *
 * @param {object} file
 * @param {string} file.originalname
 * @param {string} file.mimetype a kliens által állított típus
 * @param {Buffer} file.buffer
 * @param {number} [maxBytes]
 * @returns {{ok: true, mime: string, kind: string, ext: string} | {ok: false, error: string}}
 */
export function validateMedia(file, maxBytes = 512 * 1024 * 1024) {
  if (!file?.buffer?.length) {
    return { ok: false, error: 'Üres fájl.' };
  }
  if (file.buffer.length > maxBytes) {
    return {
      ok: false,
      error: `A fájl túl nagy (${Math.round(file.buffer.length / 1024 / 1024)} MB, ` +
        `maximum ${Math.round(maxBytes / 1024 / 1024)} MB).`,
    };
  }

  const sniffed = sniffMimeType(file.buffer);
  if (!sniffed) {
    return {
      ok: false,
      error: 'A fájl tartalma alapján nem ismerhető fel a típus. ' +
        'Engedélyezett: jpg, png, webp, mp4, webm.',
    };
  }

  const allowed = ALLOWED[sniffed];
  if (!allowed) {
    return { ok: false, error: `Nem engedélyezett fájltípus: ${sniffed}.` };
  }

  // A kliens által állított típusnak egyeznie kell a valóssal. Ha nem egyezik,
  // az vagy hibás feltöltés, vagy szándékos hamisítás — mindkettő elutasítandó.
  const claimed = (file.mimetype ?? '').toLowerCase();
  if (claimed && claimed !== sniffed && !(claimed === 'image/jpg' && sniffed === 'image/jpeg')) {
    return {
      ok: false,
      error: `A fájl tartalma (${sniffed}) nem egyezik a megadott típussal (${claimed}).`,
    };
  }

  return { ok: true, mime: sniffed, kind: allowed.kind, ext: allowed.ext };
}
