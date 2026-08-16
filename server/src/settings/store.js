/**
 * Futásidőben állítható szerver-beállítások (1.0.011).
 *
 * Egyelőre egyetlen érték él itt: a **port**, amin a vezérlő szerver hallgat.
 * A webes felületről állítható, és a **következő indításkor** lép életbe —
 * futó szervernek nem lehet menet közben portot cserélni anélkül, hogy a
 * nyitott kapcsolatok (Socket.io, WHEP proxy, éppen zajló adás) el ne
 * szakadnának.
 *
 * ELSŐBBSÉGI SORREND:
 *
 *   1. `data/server.json`            ← a felületen beállított érték
 *   2. `ONLIVE_SERVER_PORT`          ← környezeti változó
 *   3. 8080                          ← alapértelmezés
 *
 * A felületen megadott érték szándékosan ERŐSEBB a környezeti változónál: a
 * `.env` egyszer, telepítéskor íródik, a felületen viszont az üzemeltető
 * tudatosan, most állít. Ha fordítva lenne, a gomb néma maradna azoknál, akik
 * a sablon `.env`-et használják — vagyis mindenkinél.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PORT = 8080;
export const SETTINGS_FILE = 'server.json';

/**
 * A tárolt beállítások beolvasása — SZINKRON, mert a konfiguráció összeállítása
 * is az (a szerver még el sem indult, nincs mire várni).
 */
export function readServerSettingsSync(dataDir) {
  if (!dataDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8'));
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};   // még nincs fájl, vagy sérült — az alapértelmezés lép
  }
}

/**
 * A port kiválasztása a három forrásból.
 * @returns {{port: number, source: 'felulet'|'env'|'alapertelmezes'}}
 */
export function resolvePort({ stored, env }) {
  const storedPort = toPort(stored);
  if (storedPort) return { port: storedPort, source: 'felulet' };

  const envPort = toPort(env);
  if (envPort) return { port: envPort, source: 'env' };

  return { port: DEFAULT_PORT, source: 'alapertelmezes' };
}

const toPort = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
};

/**
 * Port ellenőrzése a felületről érkező értékre.
 *
 * @returns {{ok: boolean, port?: number, error?: string, warning?: string}}
 */
export function assessPort(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Adj meg egy portot.' };

  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: 'A port csak számjegyekből állhat.' };
  }

  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65_535) {
    return { ok: false, error: 'A port 1 és 65535 közötti lehet.' };
  }

  // Nem tiltjuk, csak szólunk: van, aki tudatosan tesz 80-at vagy 443-at.
  if (port < 1024) {
    return {
      ok: true,
      port,
      warning: 'Az 1024 alatti portokhoz Windowson és Linuxon is emelt jogosultság kellhet, '
        + 'és gyakran ütközik más szolgáltatással.',
    };
  }
  if (RISKY_PORTS.has(port)) {
    return {
      ok: true,
      port,
      warning: `A ${port}-es portot gyakran más program foglalja — ha az indítás „EADDRINUSE" hibával áll meg, ez az oka.`,
    };
  }
  return { ok: true, port };
};

/** Tipikusan foglalt portok: csak figyelmeztetünk rájuk. */
const RISKY_PORTS = new Set([
  3000, 3306, 5432, 5900, 6379, 8000, 8081, 8888, 8889, 9000, 9997, 27017,
]);

export class ServerSettingsStore {
  constructor({ dataDir, logger, envPort } = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.filePath = dataDir ? path.join(dataDir, SETTINGS_FILE) : null;
    this.envPort = envPort ?? null;
    this.data = readServerSettingsSync(dataDir);
  }

  /** Ami a KÖVETKEZŐ indításkor érvényes lesz. */
  get configured() {
    return resolvePort({ stored: this.data.port, env: this.envPort });
  }

  /**
   * @param {number} runningPort amin a szerver ÉPPEN hallgat — ebből derül ki,
   *   hogy egy beállítás után kell-e még újraindítani
   */
  status(runningPort) {
    const next = this.configured;
    return {
      runningPort: runningPort ?? null,
      port: next.port,
      source: next.source,
      defaultPort: DEFAULT_PORT,
      envPort: toPort(this.envPort),
      /** Az env értéket a felületen megadott felülírja — ezt jelezni kell. */
      envOverridden: Boolean(toPort(this.envPort)) && next.source === 'felulet',
      updatedAt: this.data.updatedAt ?? null,
      updatedBy: this.data.updatedBy ?? null,
      restartRequired: Boolean(runningPort) && runningPort !== next.port,
    };
  }

  async setPort(value, { by } = {}) {
    const assessment = assessPort(value);
    if (!assessment.ok) throw new Error(assessment.error);

    this.data = {
      ...this.data,
      port: assessment.port,
      updatedAt: new Date().toISOString(),
      updatedBy: by ?? null,
    };
    await this.#save();
    return { ...assessment, status: this.status() };
  }

  /** Visszatérés a környezeti változóhoz / alapértelmezéshez. */
  async clearPort() {
    const { port, ...rest } = this.data;
    this.data = { ...rest, updatedAt: new Date().toISOString(), updatedBy: null };
    await this.#save();
    return this.status();
  }

  async #save() {
    if (!this.filePath) return;
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });

    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }
}
