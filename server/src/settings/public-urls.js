/**
 * A publikus címek ellenőrzése (1.0.019).
 *
 * A három `ONLIVE_PUBLIC_*_URL` **alap-cím** (origin), nem oldalcím. A telefon
 * ezekhez fűzi hozzá a saját útvonalait:
 *
 *     vezérlő szerver + `/api/session/ping`   → kapcsolat-teszt
 *     ingest          + `/<stream>/whip`      → a publikálás
 *
 * Ha az admin cím `https://pelda.com/admin`-ra van állítva, a telefon a
 * `https://pelda.com/admin/api/session/ping` címet hívja, és **HTTP 404**-et
 * kap. A hibaüzenet ilyenkor teljesen félrevezet: a cím elérhető, a szerver fut,
 * a kulcs is jó — csak épp egy nem létező útvonalat kérdezünk. Pontosan ez
 * történt egy éles telepítésnél, ezért ellenőrizzük.
 *
 * A második, ugyanilyen néma hiba: az ingest cím a **MediaMTX** WHIP portjára
 * (8889) kell mutasson, nem a vezérlő szerverre. Egy hostname nem elég hozzá,
 * mert a cloudflared NEM vág le útvonal-előtagot — a `.../ingest/onlive/whip`
 * kérés úgy, ahogy van, megérkezik a 8080-as szerverhez, ahol nincs ilyen
 * végpont.
 */

const ROLES = {
  admin: 'Vezérlő szerver (admin)',
  live: 'Live / OBS',
  ingest: 'Ingest (WHIP)',
};

/**
 * Egyetlen cím vizsgálata.
 *
 * @returns {{ok: boolean, normalized: string|null, error?: string, warning?: string}}
 */
export function assessPublicUrl(value, { role = 'admin' } = {}) {
  const name = ROLES[role] ?? role;
  const raw = String(value ?? '').trim();

  if (!raw) return { ok: false, normalized: null, error: `${name}: nincs megadva.` };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, normalized: null, error: `${name}: ez nem érvényes URL (${raw}).` };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, normalized: null, error: `${name}: csak http/https lehet (${raw}).` };
  }

  const normalized = url.origin;
  const path = url.pathname.replace(/\/+$/, '');

  if (path) {
    return {
      ok: false,
      normalized,
      error: `${name}: az ALAP-címet kell megadni, útvonal nélkül. `
        + `A(z) „${path}" rész nem tartozik bele — helyesen: ${normalized}`,
    };
  }

  if (url.search || url.hash) {
    return {
      ok: false,
      normalized,
      error: `${name}: a cím nem tartalmazhat paramétert vagy horgonyt — helyesen: ${normalized}`,
    };
  }

  return { ok: true, normalized };
}

/**
 * A három cím együtt.
 *
 * @param {{admin: string, live: string, ingest: string}} urls
 * @returns {Array<{role: string, level: 'error'|'warning', message: string, suggestion?: string}>}
 */
export function assessPublicUrls(urls = {}) {
  const problems = [];

  for (const role of ['admin', 'live', 'ingest']) {
    const assessment = assessPublicUrl(urls[role], { role });
    if (!assessment.ok) {
      problems.push({
        role,
        level: 'error',
        message: assessment.error,
        ...(assessment.normalized ? { suggestion: assessment.normalized } : {}),
      });
    }
  }

  // Az ingest a MediaMTX-re megy (8889), az admin a vezérlő szerverre (8080).
  // Ugyanaz a hostname a kettőre azt jelenti, hogy a WHIP kérés a vezérlő
  // szerverhez érkezne — ott viszont nincs WHIP végpont.
  const adminHost = hostOf(urls.admin);
  const ingestHost = hostOf(urls.ingest);
  if (adminHost && ingestHost && adminHost === ingestHost) {
    problems.push({
      role: 'ingest',
      level: 'warning',
      message: 'Az ingest ugyanarra a hostra mutat, mint a vezérlő szerver '
        + `(${ingestHost}). A WHIP a MediaMTX 8889-es portjára megy, a vezérlő `
        + 'szerver a 8080-asra — ehhez külön hostname (tunnel ingress) kell, '
        + 'mert a cloudflared nem vág le útvonal-előtagot.',
    });
  }

  return problems;
}

function hostOf(value) {
  try {
    return new URL(String(value ?? '')).host;
  } catch {
    return null;
  }
}
