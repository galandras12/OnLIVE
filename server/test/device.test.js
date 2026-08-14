/**
 * Eszköz-parancs sor tesztek (8. szegmens).
 *
 * A parancscsatorna nélkül a két felület kicsúszna egymásból: az admin
 * „Befejezés"-e után a telefon tovább publikálna, és „ÉLŐ"-t mutatna egy már
 * lezárt adás alatt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceCommandQueue, DeviceCommands } from '../src/device/commands.js';

const queue = () => new DeviceCommandQueue({ logger: null });

test('a parancsok sorrendben, egyszer adódnak át', () => {
  const commands = queue();
  commands.push(DeviceCommands.START);
  commands.push(DeviceCommands.PHOTO);

  const pulled = commands.pull();
  assert.deepEqual(pulled.map((c) => c.type), ['start', 'photo']);
  assert.deepEqual(commands.pull(), [], 'átvétel után üres a sor');
});

test('ismeretlen parancsot nem fogad el', () => {
  assert.throws(() => queue().push('formatalj-le-mindent'), /Ismeretlen parancs/);
});

test('az azonos típusú beállító parancsokból csak a legutóbbi marad', () => {
  const commands = queue();
  commands.push(DeviceCommands.SET_QUALITY, { videoBitrateKbps: 3000 });
  commands.push(DeviceCommands.SET_QUALITY, { videoBitrateKbps: 6000 });
  commands.push(DeviceCommands.SET_QUALITY, { videoBitrateKbps: 7000 });

  const pulled = commands.pull();
  assert.equal(pulled.length, 1, 'a csúszka tekergetése nem áraszthatja el a telefont');
  assert.equal(pulled[0].payload.videoBitrateKbps, 7000, 'a legutóbbi érték számít');
});

test('a session-parancsok NEM vonódnak össze', () => {
  const commands = queue();
  commands.push(DeviceCommands.PAUSE);
  commands.push(DeviceCommands.RESUME);
  commands.push(DeviceCommands.PAUSE);

  assert.deepEqual(
    commands.pull().map((c) => c.type),
    ['pause', 'resume', 'pause'],
    'minden felhasználói művelet külön lépés',
  );
});

test('a lejárt parancsok nem érik el a telefont', () => {
  const commands = queue();
  const command = commands.push(DeviceCommands.PHOTO);
  // Egy két perce kiadott „fotózz" parancsot már értelmetlen végrehajtani.
  command.createdAt = Date.now() - 2 * 60 * 1000;

  assert.deepEqual(commands.pull(), []);
});

test('a jelenlét az utolsó életjelből számítódik', () => {
  const commands = queue();
  assert.equal(commands.status().online, false, 'indulásnál nincs telefon');

  commands.touch({ device: 'Samsung SM-S938B', capture: { resolution: '1080p' } });
  const status = commands.status();

  assert.equal(status.online, true);
  assert.equal(status.device, 'Samsung SM-S938B');
  assert.equal(status.capture.resolution, '1080p');
});

test('régi életjel után a telefon nem számít elérhetőnek', () => {
  const commands = queue();
  commands.touch({ device: 'teszt' });
  commands.presence.lastSeenAt = Date.now() - 60_000;

  const status = commands.status();
  assert.equal(status.online, false);
  assert.equal(status.device, 'teszt', 'az utolsó ismert adat megmarad');
});

test('a várakozó parancsok száma látszik az adminnak', () => {
  const commands = queue();
  commands.push(DeviceCommands.SET_LENS, { lens: 'tele' });
  commands.push(DeviceCommands.TORCH, { on: true });

  assert.equal(commands.status().pending, 2);
  commands.pull();
  assert.equal(commands.status().pending, 0);
});
