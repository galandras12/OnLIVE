/**
 * Eszköz-parancsok: a web UI → telefon irány (8. szegmens).
 *
 * Eddig a kapcsolat egyirányú volt: a telefon jelzett a szervernek. A 8.
 * szegmens viszont azt kéri, hogy a web UI-ról is lehessen indítani/zárni a
 * sessiont, kamerát váltani és minőséget állítani — ehhez a szervernek
 * **utasítania** kell tudni a telefont.
 *
 * Ez nem csak kényelmi kérdés. Ha az admin megnyomja a „Befejezés"-t, a
 * szerver ugyan lezárja a sessiont és lekapcsolja a publishert, de a telefon
 * app — mivel a felhasználó nála nem nyomott semmit — újracsatlakozna, és
 * továbbra is „ÉLŐ"-t mutatna. A parancs-csatorna nélkül a két felület
 * kicsúszna egymásból.
 *
 * Szállítás: a telefon 3 másodpercenként úgyis küld telemetriát
 * (`POST /api/session/stats`), ezért a **válaszban** kapja meg a rá váró
 * parancsokat — nulla plusz kérés, legfeljebb 3 másodperc késleltetés.
 * Emellett külön is lekérdezheti (`GET /api/session/commands`).
 */

export const DeviceCommands = Object.freeze({
  /** Session-vezérlés — ugyanaz, amit a telefon gombjai csinálnak. */
  START: 'start',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  /** Capture-vezérlés. */
  SET_LENS: 'setLens',
  SET_SOURCE: 'setSource',
  SET_QUALITY: 'setQuality',
  /** Kép-irány: 16:9 fekvő vagy 9:16 álló (1.0.101). */
  SET_ORIENTATION: 'setOrientation',
  /** Kiegészítők. */
  TORCH: 'torch',
  PHOTO: 'photo',
  RECORDING: 'recording',
});

const KNOWN = new Set(Object.values(DeviceCommands));

/** Ennyi idő után elévül egy parancs, ha a telefon nem vette át. */
const TTL_MS = 60_000;

/** Ennyi ideig tekintjük a telefont elérhetőnek az utolsó jelzése után. */
const ONLINE_WINDOW_MS = 12_000;

export class DeviceCommandQueue {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.queue = [];
    this.sequence = 0;

    /** A telefon utolsó életjele és állapota — az admin UI ezt mutatja. */
    this.presence = { lastSeenAt: null, device: null, capture: null };
  }

  /**
   * Parancs hozzáadása.
   * @returns {{id: string, type: string, payload: object, createdAt: number}}
   */
  push(type, payload = {}) {
    if (!KNOWN.has(type)) throw new Error(`Ismeretlen parancs: ${type}`);

    this.sequence += 1;
    const command = {
      id: `c${this.sequence}-${Date.now().toString(36)}`,
      type,
      payload,
      createdAt: Date.now(),
    };

    // Ugyanabból a típusból csak a legutóbbi számít: ha az admin kétszer
    // tekeri a bitrátát, a telefonnak nem kell mindkét lépést lejátszania.
    if (COALESCING.has(type)) {
      this.queue = this.queue.filter((item) => item.type !== type);
    }

    this.queue.push(command);
    this.logger?.info(`Parancs a telefonnak: ${type}`);
    return command;
  }

  /** A várakozó parancsok kivétele (a telefon hívja). */
  pull() {
    this.#expire();
    const commands = this.queue;
    this.queue = [];
    return commands;
  }

  pending() {
    this.#expire();
    return [...this.queue];
  }

  #expire() {
    const cutoff = Date.now() - TTL_MS;
    const before = this.queue.length;
    this.queue = this.queue.filter((command) => command.createdAt >= cutoff);
    if (this.queue.length !== before) {
      this.logger?.info('Elévült eszköz-parancsok eldobva (a telefon nem vette át).');
    }
  }

  /** A telefon minden jelzésekor frissül — ebből tudjuk, hogy elérhető-e. */
  touch({ device, capture } = {}) {
    this.presence.lastSeenAt = Date.now();
    if (device) this.presence.device = device;
    if (capture) this.presence.capture = capture;
  }

  status() {
    const lastSeenAt = this.presence.lastSeenAt;
    return {
      online: Boolean(lastSeenAt) && Date.now() - lastSeenAt < ONLINE_WINDOW_MS,
      lastSeenAt,
      device: this.presence.device,
      capture: this.presence.capture,
      pending: this.pending().length,
    };
  }
}

/** Ezekből mindig csak a legutóbbi parancs releváns. */
const COALESCING = new Set([
  DeviceCommands.SET_LENS,
  DeviceCommands.SET_SOURCE,
  DeviceCommands.SET_QUALITY,
  DeviceCommands.TORCH,
]);
