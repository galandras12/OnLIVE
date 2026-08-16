/**
 * Port-egyezés ellenőrzése a szomszédos komponensekkel (1.0.011).
 *
 * A vezérlő szerver portja három helyen szerepel még:
 *
 *   - a cloudflared `config.yml`-jében  (`service: http://localhost:<port>`),
 *   - a MediaMTX konfigurációjában      (`authHTTPAddress: …:<port>/api/ingest/auth`),
 *   - a watchdog paraméterében          (`-OriginPort <port>`).
 *
 * Ha a port átállítása után ezek a régin maradnak, a rendszer **némán** romlik
 * el: a publikus címek 502-t adnak, a telefon pedig 401-et kap a WHIP-en. Ezt
 * nagyon nehéz kitalálni, viszont a fájlokból pillanatok alatt kiolvasható —
 * ezért induláskor megnézzük, és a naplóban szólunk.
 *
 * Csak OLVASUNK: a más komponensekhez tartozó fájlokat nem írjuk át magunktól.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A cloudflared konfigurációja többféle helyen lehet — sorban keressük. */
function tunnelConfigCandidates(repoRoot) {
  const home = os.homedir();
  return [
    process.env.ONLIVE_TUNNEL_CONFIG,
    path.join(home, '.cloudflared', 'config.yml'),
    'C:\\Windows\\System32\\config\\systemprofile\\.cloudflared\\config.yml',
    path.join(repoRoot, 'infra', 'cloudflared', 'config.yml'),
  ].filter(Boolean);
}

const firstExisting = (candidates) => candidates.find((file) => {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
});

/** Az első olyan port, amit a megadott minta talál a fájlban. */
function portFrom(file, pattern) {
  try {
    const content = readFileSync(file, 'utf8');
    const found = [...content.matchAll(pattern)]
      .map((match) => Number.parseInt(match[1], 10))
      .filter((value) => Number.isInteger(value));
    return found.length ? [...new Set(found)] : null;
  } catch {
    return null;
  }
}

/**
 * @param {number} port a szerver aktuális portja
 * @param {object} options
 * @param {string} options.mediamtxConfig a MediaMTX konfigurációs fájlja
 * @param {string} options.repoRoot a repó gyökere (a tartalék tunnel-config miatt)
 * @returns {Array<{id, name, file, expected, found, ok}>}
 */
export function checkPortDependencies(port, { mediamtxConfig, repoRoot } = {}) {
  const results = [];

  const tunnelConfig = firstExisting(tunnelConfigCandidates(repoRoot ?? '.'));
  if (tunnelConfig) {
    const found = portFrom(tunnelConfig, /service:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/gi);
    if (found) {
      results.push({
        id: 'cloudflared',
        name: 'Cloudflare Tunnel',
        file: tunnelConfig,
        expected: port,
        found,
        ok: found.includes(port),
      });
    }
  }

  if (mediamtxConfig && existsSync(mediamtxConfig)) {
    const found = portFrom(
      mediamtxConfig,
      /authHTTPAddress:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/gi,
    );
    if (found) {
      results.push({
        id: 'mediamtx',
        name: 'MediaMTX hitelesítés',
        file: mediamtxConfig,
        expected: port,
        found,
        ok: found.includes(port),
      });
    }
  }

  return results;
}

/** Emberi mondat a naplóhoz egy eltérésről. */
export function describeMismatch(check) {
  return `${check.name}: a(z) ${check.file} még a ${check.found.join(', ')} portra mutat, `
    + `a szerver viszont a ${check.expected}-en hallgat.`;
}
