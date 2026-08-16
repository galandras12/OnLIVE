/**
 * Helyi elérési címek — LAN és Tailscale (1.0.101).
 *
 * MIÉRT KELL: a Cloudflare Tunnelen a **WHIP jelzés átmegy, a WebRTC média
 * nem** — ahhoz TURN kellene. Ha viszont a telefon és a szerver ugyanazon a
 * hálózaton van (otthoni wifi), vagy ugyanabban a Tailscale hálózatban, akkor
 * az alagút megkerülhető: a telefon közvetlenül a szerver IP-jére publikál, és
 * a média is helyben marad. Ez nemcsak működik TURN nélkül, hanem kisebb
 * késleltetést is ad, mert a kép ki sem megy az internetre.
 *
 * Ez a modul csak annyit tesz, hogy **megmondja, milyen címeken érhető el a
 * szerver** — a választás a telefonon történik (Kapcsolat mód: automatikus /
 * csak helyi / csak alagút).
 *
 * A Tailscale-címek felismerése a CGNAT tartományból (100.64.0.0/10) történik,
 * amit a Tailscale kizárólagosan használ a csomópontjaihoz. Ez megbízhatóbb,
 * mint az interfész nevére hagyatkozni: az Windowson `Tailscale`, Linuxon
 * `tailscale0`, macOS-en `utun3` — az utolsóból semmi nem látszik.
 */

import os from 'node:os';

/** A 100.64.0.0/10 tartomány: a Tailscale ebből osztja a csomópont-címeket. */
function isTailscale(address) {
  const match = /^100\.(\d+)\./.exec(address);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 64 && second <= 127;
}

/** Privát (RFC 1918) IPv4 — vagyis „ugyanaz a hálózat". */
function isPrivateLan(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/**
 * A gép címei, hasznosság szerint rendezve.
 *
 * @returns {Array<{address: string, iface: string, kind: 'tailscale'|'lan'|'egyeb'}>}
 */
export function localAddresses(interfaces = os.networkInterfaces()) {
  const found = [];

  for (const [iface, entries] of Object.entries(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      // Csak IPv4: a WHIP/HTTP címekbe kézzel beírni egy IPv6-ot a telefonon
      // reménytelen, és a szögletes zárójeles alak is gyakran elgépelődik.
      const family = entry.family === 4 || entry.family === 'IPv4';
      if (!family || entry.internal) continue;

      found.push({
        address: entry.address,
        iface,
        kind: isTailscale(entry.address) ? 'tailscale' : isPrivateLan(entry.address) ? 'lan' : 'egyeb',
      });
    }
  }

  // A Tailscale megy előre: az bárhonnan működik, a LAN cím csak otthonról.
  const rank = { tailscale: 0, lan: 1, egyeb: 2 };
  return found.sort((a, b) => rank[a.kind] - rank[b.kind] || a.address.localeCompare(b.address));
}

/**
 * A telefonba beírható helyi címek.
 *
 * @param {{port: number, whipPort: number, addresses?: Array}} options
 * @returns {{suggested: {control: string, ingest: string, kind: string}|null, candidates: Array}}
 */
export function localEndpoints({ port, whipPort, addresses = localAddresses() } = {}) {
  const candidates = addresses.map((entry) => ({
    ...entry,
    control: `http://${entry.address}:${port}`,
    ingest: `http://${entry.address}:${whipPort}`,
  }));

  return { suggested: candidates[0] ?? null, candidates };
}
