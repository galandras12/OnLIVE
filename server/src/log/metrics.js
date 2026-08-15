/**
 * Metrika-rögzítő (9. szegmens).
 *
 * A telefon 3 másodpercenként küld telemetriát; ezeket az `at` időbélyeggel és
 * az AKKORI állapottal együtt append-only fájlba írjuk. Ebből épül utólag a
 * letölthető napló: melyik időszakban mennyi volt az átlagos/min/max bitráta,
 * és mikor szakadt meg az adás.
 *
 * Miért JSONL: hozzáfűzéssel írható (egy félbeszakadt írás nem viszi el a
 * korábbi adatot), soronként olvasható, és nem kell hozzá adatbázis.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Ekkora méret felett elforgatjuk a fájlt (egy .1 példány marad). */
const MAX_BYTES = 32 * 1024 * 1024;

/** Két minta között eltelt minimum idő — véd az elárasztás ellen. */
const MIN_INTERVAL_MS = 1000;

export class MetricsRecorder {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'metrics.jsonl');
    this.lastWriteAt = 0;
    this.ready = this.#init();
  }

  async #init() {
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Egy minta rögzítése.
   *
   * @param {object} sample
   * @param {string} sample.state az adás állapota a minta pillanatában
   * @param {string|null} sample.sessionId
   * @param {object} sample.stats a telefon telemetriája
   */
  async record({ state, sessionId, stats }) {
    if (!stats) return;

    const now = Date.now();
    if (now - this.lastWriteAt < MIN_INTERVAL_MS) return;
    this.lastWriteAt = now;

    await this.ready;
    await this.#rotateIfNeeded();

    // A telemetria a telefontól jön, tehát nem garantált, hogy szám van benne.
    // Egy szöveges érték a `.toFixed()` hívásnál dobna, és a minta némán
    // elveszne — ezért mindent számmá alakítunk, hibás értékre nullával.
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const line = {
      at: new Date(now).toISOString(),
      sessionId: sessionId ?? null,
      state,
      videoKbps: Math.round(number(stats.videoBitrateKbps)),
      audioKbps: Math.round(number(stats.audioBitrateKbps)),
      fps: Math.round(number(stats.fps)),
      rttMs: Math.round(number(stats.rttMs)),
      jitterMs: Number(number(stats.jitterMs).toFixed(1)),
      lossPercent: Number(number(stats.packetLossPercent).toFixed(2)),
    };

    try {
      await appendFile(this.filePath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      this.logger?.warn(`Metrika írása sikertelen: ${error.message}`);
    }
  }

  async #rotateIfNeeded() {
    try {
      const info = await stat(this.filePath);
      if (info.size > MAX_BYTES) {
        await rename(this.filePath, `${this.filePath}.1`);
        this.logger?.info('A metrika-napló elérte a méretkorlátot, elforgatva.');
      }
    } catch {
      // Még nincs fájl — rendben.
    }
  }

  /** Minták beolvasása időrendben, opcionális szűréssel. */
  async read({ from, to, sessionId } = {}) {
    await this.ready;
    const rows = [];

    for (const file of [`${this.filePath}.1`, this.filePath]) {
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        let sample;
        try {
          sample = JSON.parse(line);
        } catch {
          continue; // félbeszakadt sor — átugorjuk
        }
        const at = Date.parse(sample.at);
        if (!Number.isFinite(at)) continue;
        if (from && at < from) continue;
        if (to && at > to) continue;
        if (sessionId && sample.sessionId !== sessionId) continue;
        rows.push({ ...sample, ms: at });
      }
    }

    return rows.sort((a, b) => a.ms - b.ms);
  }
}
