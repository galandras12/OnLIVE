/**
 * A `.env` fájl olvasása és **kíméletes** átírása (1.0.017).
 *
 * A `config.bat` varázslója ezen keresztül ír: nem generál új fájlt, hanem a
 * meglévő sorokat cseréli. Ez fontos, mert a `.env.example`-ből másolt fájl
 * tele van magyarázó kommentekkel — ha a varázsló újraírná, az első futással
 * elveszne minden magyarázat, és a felhasználó egy csupasz kulcs=érték listát
 * kapna vissza a dokumentált sablon helyett.
 *
 * Amit szándékosan NEM csinálunk: nem értelmezünk `${VAR}` behelyettesítést és
 * nem támogatunk többsoros értéket. A Node `--env-file` sem tud ilyet, tehát
 * ha itt kezelnénk, olyan fájlt írnánk, amit a szerver már nem olvasna ugyanígy.
 */

/** Kulcs=érték sor felismerése (a `export` előtag megengedett). */
const ASSIGNMENT = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** A varázsló által hozzáfűzött, korábban nem létező kulcsok fejléce. */
export const APPEND_HEADER = '# --- A beallito varazslo (config.bat) altal hozzaadott sorok ---';

/** CRLF vagy LF — a fájl saját szokását megtartjuk (Windowson ez CRLF). */
export function detectEol(content) {
  return /\r\n/.test(content ?? '') ? '\r\n' : '\n';
}

/**
 * Kulcs → érték. Ha egy kulcs többször szerepel, az UTOLSÓ nyer — ugyanúgy,
 * ahogy a Node `--env-file` feldolgozza.
 */
export function parseEnvContent(content) {
  const values = {};
  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const match = ASSIGNMENT.exec(line);
    if (!match) continue;
    values[match[2]] = unquote(match[3]);
  }
  return values;
}

/**
 * Idézőjelek levétele és a soron belüli komment eldobása.
 *
 * Ugyanúgy, ahogy a Node `--env-file` csinálja (kimérve, nem feltételezve):
 * a **kettős** idézőjelben a `\n` valódi sortörésre cserélődik, minden más
 * visszaper érintetlen marad; az **aposztrófban** semmi nem cserélődik.
 */
function unquote(raw) {
  const value = raw.trim();

  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  // Idézőjel nélküli értéknél a ` #` kommentet kezd.
  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Érték formázása .env sorba.
 *
 * Idézőjelbe csak akkor tesszük, ha muszáj: a scrypt hash (`scrypt$16384$…`)
 * és a base64url kulcsok idézőjel nélkül is épek maradnak, és így a fájl
 * olvashatóbb. Szóköz vagy `#` esetén viszont kötelező — enélkül egy
 * `C:\Program Files\…` útvonal fele elveszne.
 *
 * ÉS APOSZTRÓFOT HASZNÁLUNK, nem kettős idézőjelet. Ez nem szépészeti kérdés:
 * a Node a kettős idézőjelen belül a `\n`-t SORTÖRÉSRE cseréli, tehát egy
 * teljesen hétköznapi `C:\new\mediamtx.exe` útvonal két darabra esne szét.
 * Aposztrófon belül semmi ilyesmi nem történik.
 */
export function formatEnvValue(value) {
  const text = String(value ?? '');
  if (text === '') return '';
  if (!/[\s#"']/.test(text)) return text;

  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"') && !text.includes('\\')) return `"${text}"`;

  // A Node egyik idézőjelen belül sem ismer escape-elést, tehát ez az érték
  // nem írható le épen — jobb hangosan elhasalni, mint csendben csonkítani.
  throw new Error(
    'Az érték aposztrófot és idézőjelet (vagy visszapert) is tartalmaz, '
    + 'ilyet a .env formátum nem tud tárolni. Írd át az értéket.',
  );
}

/**
 * A megadott kulcsok beírása a fájl tartalmába.
 *
 * - meglévő kulcs → az ELSŐ előfordulása kapja az új értéket, a további
 *   (duplikált) sorai kikerülnek, hogy ne maradjon árnyékoló sor a fájl végén;
 * - `null` érték → a kulcs minden sora törlődik (így tűnik el a nyers
 *   `ONLIVE_ADMIN_PASSWORD`, miután hash-t állítottunk be);
 * - ismeretlen kulcs → a fájl végére kerül, egyszeri fejléc alá.
 *
 * A kommentelt sorokhoz nem nyúlunk: ha valaki kikommentelt egy kulcsot, az
 * szándék volt, nem hiba.
 *
 * @param {string} content a jelenlegi fájl
 * @param {Record<string, string|number|null>} updates
 * @returns {string}
 */
export function updateEnvContent(content, updates) {
  const eol = detectEol(content);
  const lines = String(content ?? '').split(/\r?\n/);
  const pending = new Map(Object.entries(updates ?? {}));
  const written = new Set();

  const result = [];
  for (const line of lines) {
    const match = ASSIGNMENT.exec(line);
    const key = match?.[2];

    if (!key || !pending.has(key)) {
      result.push(line);
      continue;
    }

    const value = pending.get(key);
    if (value === null || written.has(key)) continue;   // törlés, illetve duplikátum

    result.push(`${match[1]}${key}=${formatEnvValue(value)}`);
    written.add(key);
  }

  const missing = [...pending].filter(([key, value]) => value !== null && !written.has(key));
  if (missing.length) {
    while (result.length && !result[result.length - 1].trim()) result.pop();
    // A fejléc egyszer kerül be: a második futásnál már csak a sorok jönnek alá.
    if (!result.includes(APPEND_HEADER)) result.push('', APPEND_HEADER);
    for (const [key, value] of missing) result.push(`${key}=${formatEnvValue(value)}`);
  }

  while (result.length && !result[result.length - 1].trim()) result.pop();
  return result.join(eol) + eol;
}
