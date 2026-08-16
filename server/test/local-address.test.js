/**
 * Helyi elérési címek — LAN és Tailscale (1.0.101).
 *
 * A Tailscale-cím azért megy előre, mert az útközben is működik; a LAN-cím
 * csak otthonról. A hálózati interfészeket a teszt adja, tehát a viselkedés
 * gépfüggetlen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { localAddresses, localEndpoints } from '../src/settings/local-address.js';

/** Egy tipikus Windows-gép: hurok, wifi, Tailscale és egy IPv6. */
const INTERFACES = {
  'Loopback Pseudo-Interface 1': [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
  'Wi-Fi': [
    { address: '192.168.1.42', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  Tailscale: [
    { address: '100.101.102.103', family: 'IPv4', internal: false },
  ],
};

test('a belső és az IPv6 címek kimaradnak', () => {
  const found = localAddresses(INTERFACES);
  assert.deepEqual(found.map((entry) => entry.address), ['100.101.102.103', '192.168.1.42']);
});

test('a Tailscale-cím a CGNAT tartományból ismerszik meg, és előre kerül', () => {
  const [first, second] = localAddresses(INTERFACES);
  assert.equal(first.kind, 'tailscale');
  assert.equal(second.kind, 'lan');
});

test('a 100-as tartomány határai', () => {
  // 100.64.0.0/10 — a 100.63.x és a 100.128.x már NEM Tailscale.
  const kinds = localAddresses({
    a: [{ address: '100.63.0.1', family: 'IPv4', internal: false }],
    b: [{ address: '100.64.0.1', family: 'IPv4', internal: false }],
    c: [{ address: '100.127.255.254', family: 'IPv4', internal: false }],
    d: [{ address: '100.128.0.1', family: 'IPv4', internal: false }],
  }).reduce((all, entry) => ({ ...all, [entry.address]: entry.kind }), {});

  assert.equal(kinds['100.64.0.1'], 'tailscale');
  assert.equal(kinds['100.127.255.254'], 'tailscale');
  assert.equal(kinds['100.63.0.1'], 'egyeb');
  assert.equal(kinds['100.128.0.1'], 'egyeb');
});

test('a privát tartományok LAN-nak számítanak', () => {
  const kinds = localAddresses({
    a: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    b: [{ address: '172.16.0.5', family: 'IPv4', internal: false }],
    c: [{ address: '172.32.0.5', family: 'IPv4', internal: false }],
    d: [{ address: '192.168.0.5', family: 'IPv4', internal: false }],
  }).reduce((all, entry) => ({ ...all, [entry.address]: entry.kind }), {});

  assert.equal(kinds['10.0.0.5'], 'lan');
  assert.equal(kinds['172.16.0.5'], 'lan');
  assert.equal(kinds['172.32.0.5'], 'egyeb', '172.32 már kívül esik az RFC 1918-on');
  assert.equal(kinds['192.168.0.5'], 'lan');
});

test('a javasolt címek a megfelelő portra mutatnak', () => {
  const { suggested, candidates } = localEndpoints({
    port: 8080,
    whipPort: 8889,
    addresses: localAddresses(INTERFACES),
  });

  // A vezérlés a szerver portjára megy, az ingest a MediaMTX WHIP portjára —
  // ez az a két érték, amit a telefonba be kell írni.
  assert.equal(suggested.control, 'http://100.101.102.103:8080');
  assert.equal(suggested.ingest, 'http://100.101.102.103:8889');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].control, 'http://192.168.1.42:8080');
});

test('cím nélküli gépen nincs javaslat, de nem is hasal el', () => {
  const { suggested, candidates } = localEndpoints({ port: 8080, whipPort: 8889, addresses: [] });
  assert.equal(suggested, null);
  assert.deepEqual(candidates, []);
});

test('a valódi gép címei értelmes alakúak', () => {
  // Csak annyit várunk el, hogy ne dobjon és IPv4-eket adjon vissza — hogy
  // hány van, az a futtató gépen múlik.
  for (const entry of localAddresses()) {
    assert.match(entry.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(['tailscale', 'lan', 'egyeb'].includes(entry.kind));
  }
});
