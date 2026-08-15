/**
 * Egységes, strukturált naplózó (11. szegmens).
 *
 * Minden komponens ezt használja — állapotgép, ingest-figyelő, Socket.io
 * kezelők, admin API végpontok —, így az összes esemény egy helyen, azonos
 * formátumban landol.
 *
 * KÉT kimenet, két célra:
 *
 *  1. **Konzol** — emberi olvasásra, színezve. Ez látszik a `start.bat`
 *     ablakában adás közben.
 *  2. **`logs/YYYY-MM-DD.log`** — soronként egy JSON objektum. Géppel
 *     feldolgozható, dátum szerint forog, és ez adja az alapot a 9. szegmens
 *     letölthető CSV naplójához is.
 *
 * Minden bejegyzés hordozza, hogy **melyik felületről** érkezett (telefon app,
 * web UI, OBS, ingest réteg, rendszer) és **melyik kliens** volt — így több
 * eszköz esetén is megkülönböztethető, ki mit csinált.
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

/** Eseménytípusok — a napló ezekre szűrhető. */
export const LogEvent = Object.freeze({
  SYSTEM: 'system',
  AUTH: 'auth',
  /** Állapotgép-átmenet. */
  STATE: 'state.transition',
  /** Session-jelzés a telefontól vagy a web UI-ról. */
  SESSION: 'session',
  /** WHIP ingest kapcsolat létrejötte/megszakadása. */
  INGEST: 'ingest',
  /** Socket.io / OBS Browser Source fel- és lecsatlakozás. */
  CLIENT: 'client',
  /** Bármilyen beállítás-változtatás (régi → új értékkel). */
  SETTINGS: 'settings.change',
  /** Eszköz-parancs a web UI-ról a telefonnak. */
  COMMAND: 'device.command',
});

/** Honnan jött az esemény. */
export const Source = Object.freeze({
  PHONE: 'telefon',
  WEB: 'web-ui',
  OBS: 'obs',
  INGEST: 'ingest',
  SYSTEM: 'rendszer',
  TIMER: 'időzítő',
});

export class Logger {
  constructor({ logDir, console: useConsole = true } = {}) {
    this.logDir = logDir;
    this.useConsole = useConsole;
    this.stream = null;
    this.streamDate = null;

    if (logDir && !existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /** Dátumváltásnál új fájlra váltunk — a régi lezárul. */
  #streamFor(date) {
    if (!this.logDir) return null;

    const day = date.toISOString().slice(0, 10);
    if (this.streamDate !== day) {
      this.stream?.end();
      this.stream = createWriteStream(path.join(this.logDir, `${day}.log`), { flags: 'a' });
      this.stream.on('error', () => { this.stream = null; });
      this.streamDate = day;
    }
    return this.stream;
  }

  /**
   * Strukturált esemény.
   *
   * @param {object} entry
   * @param {string} entry.type a {@link LogEvent} egyike
   * @param {string} [entry.level] info | ok | warn | error
   * @param {string} [entry.source] a {@link Source} egyike
   * @param {string} [entry.client] kliens-azonosító (IP, socket id, session)
   * @param {string} entry.message emberi olvasásra
   * @param {object} [entry.data] tetszőleges kiegészítő adat
   */
  event({ type = LogEvent.SYSTEM, level = 'info', source = Source.SYSTEM, client, message, ...data }) {
    const at = new Date();

    const record = {
      ts: at.toISOString(),
      level,
      type,
      source,
      ...(client ? { client } : {}),
      message,
      ...(Object.keys(data).length ? data : {}),
    };

    const stream = this.#streamFor(at);
    if (stream) stream.write(`${JSON.stringify(record)}\n`);

    if (this.useConsole) this.#toConsole(record, at);
    return record;
  }

  #toConsole(record, at) {
    const time = at.toISOString().slice(11, 19);
    const color = {
      error: COLORS.red, warn: COLORS.yellow, ok: COLORS.green, state: COLORS.magenta,
    }[record.level] ?? COLORS.blue;

    const tag = {
      error: 'HIBA', warn: 'WARN', ok: 'OK', state: 'ÁLL.',
    }[record.level] ?? 'INFO';

    const from = record.source && record.source !== Source.SYSTEM
      ? `${COLORS.dim}[${record.source}${record.client ? ' ' + record.client : ''}]${COLORS.reset} `
      : '';

    const line = `${COLORS.dim}${time}${COLORS.reset} ${color}${tag.padEnd(5)}${COLORS.reset} ${from}${record.message}`;

    if (record.level === 'error') console.error(line);
    else if (record.level === 'warn') console.warn(line);
    else console.log(line);
  }

  // -------------------------------------------------------------------------
  // Kényelmi metódusok — a korábbi kód ezeket hívja
  // -------------------------------------------------------------------------

  info(message, data) { return this.event({ level: 'info', message, ...normalize(data) }); }
  ok(message, data) { return this.event({ level: 'ok', message, ...normalize(data) }); }
  warn(message, data) { return this.event({ level: 'warn', message, ...normalize(data) }); }
  error(message, data) { return this.event({ level: 'error', message, ...normalize(data) }); }
  state(message, data) { return this.event({ level: 'state', type: LogEvent.STATE, message, ...normalize(data) }); }

  get colors() { return COLORS; }

  /**
   * A naplófájl lezárása.
   *
   * A `createWriteStream` pufferel: leállításkor a még ki nem írt sorok
   * elvesznének, ha a folyamat egyszerűen kilépne. Ezért a hívó megvárhatja a
   * kiírást — a visszahívás a `finish` esemény után jön (vagy azonnal, ha nincs
   * megnyitott fájl).
   */
  close(done) {
    const stream = this.stream;
    this.stream = null;
    this.streamDate = null;

    if (!stream) {
      done?.();
      return;
    }
    stream.end(() => done?.());
  }
}

function normalize(data) {
  if (!data || typeof data !== 'object') return {};
  return data;
}

/**
 * Beállítás-változás naplózása régi és új értékkel.
 *
 * Miért kell a régi érték: adás után az a kérdés, hogy „mitől lett rossz a
 * kép" — ehhez tudni kell, mi volt előtte, nem csak azt, mi van most.
 *
 * @returns {object|null} a változott mezők `{ mező: { regi, uj } }` alakban,
 *   vagy `null`, ha semmi nem változott
 */
export function diffSettings(before, after, fields) {
  const changes = {};
  const keys = fields ?? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];

  for (const key of keys) {
    const oldValue = before?.[key];
    const newValue = after?.[key];
    if (oldValue === newValue) continue;
    if (newValue === undefined) continue; // nem küldött mező nem változás

    if (typeof oldValue === 'object' || typeof newValue === 'object') {
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    }
    changes[key] = { regi: oldValue ?? null, uj: newValue ?? null };
  }

  return Object.keys(changes).length ? changes : null;
}

/** Rövid, olvasható összefoglaló a diffből a konzolra. */
export function describeChanges(changes) {
  return Object.entries(changes)
    .map(([key, { regi, uj }]) => `${key}: ${format(regi)} → ${format(uj)}`)
    .join(', ');
}

const format = (value) => {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * Kliens-azonosító HTTP kérésből.
 *
 * Az admin munkamenetet a token **rövid ujjlenyomatával** azonosítjuk — a
 * teljes token sosem kerül naplóba, de több eszköz így is megkülönböztethető.
 */
export function clientId(req) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'ismeretlen';
  const session = req.adminSession?.token;
  return session ? `${ip}/${session.slice(0, 6)}` : ip;
}
