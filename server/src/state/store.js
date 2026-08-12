/**
 * Fájl-alapú tárolás — külső adatbázis nélkül, a meglévő stackkel konzisztensen.
 *
 * Két fájl, két különböző célra:
 *
 *  - `state.json`   — az utolsó pillanatkép. Szerver-újraindítás után ebből
 *                     látszik, mi volt az utolsó ismert állapot. Az állapotgép
 *                     NEM ebből indul (szándékosan `idle`-ből indul minden
 *                     boot), de az admin felület meg tudja mutatni az előzményt.
 *
 *  - `transitions.jsonl` — soronként egy átmenet, hozzáfűzéssel. Ez lesz a
 *                     9. szegmens letölthető naplójának nyersanyaga: append-only,
 *                     nem sérül félbeszakadt írástól, és streamelve olvasható.
 */

import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir, logger) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.statePath = path.join(dataDir, 'state.json');
    this.transitionsPath = path.join(dataDir, 'transitions.jsonl');
    this.ready = this.#init();
  }

  async #init() {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
  }

  /** Az utolsó pillanatkép mentése (atomikusan: temp fájl + átnevezés). */
  async saveSnapshot(snapshot) {
    await this.ready;
    const temp = `${this.statePath}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(temp, this.statePath);
    } catch (error) {
      this.logger?.warn(`Az állapot mentése sikertelen: ${error.message}`);
    }
  }

  async readSnapshot() {
    await this.ready;
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Egy átmenet hozzáfűzése a naplóhoz. */
  async appendTransition(entry) {
    await this.ready;
    try {
      await appendFile(this.transitionsPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.logger?.warn(`A naplóbejegyzés írása sikertelen: ${error.message}`);
    }
  }

  /** A legutóbbi N átmenet — az admin felület idővonalához. */
  async recentTransitions(limit = 100) {
    await this.ready;
    try {
      const content = await readFile(this.transitionsPath, 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
