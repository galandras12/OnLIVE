/**
 * Ingest-figyelő — a 3. szegmensben rögzített szerződés megvalósítása.
 *
 * Két csatorna, ahogy a docs/INGEST.md leírja:
 *
 *  - **Pull (ez az osztály):** másodpercenként lekérdezi a MediaMTX API-t.
 *    Ez az IGAZSÁG FORRÁSA.
 *  - **Push (webhook):** a `runOnReady` / `runOnNotReady` hookok nem
 *    közvetlenül állítják az állapotot, hanem [hint()]-tel azonnali
 *    mintavételt kérnek. Így a hook csak SIETTET, de sosem hazudhat:
 *    a döntés mindig a friss API-válaszon alapul.
 *
 * A `ready: true` önmagában nem elég: a publisher csatlakozva maradhat úgy is,
 * hogy közben megállt az adatfolyam. Ezért a `bytesReceived` mozgását nézzük.
 */

import { EventEmitter } from 'node:events';

export class IngestMonitor extends EventEmitter {
  constructor({ config, logger }) {
    super();
    this.apiBase = config.ingest.apiBase.replace(/\/+$/, '');
    this.path = config.ingest.path;
    this.pollMs = config.ingest.pollMs;
    this.interruptAfterMs = config.ingest.interruptAfterMs;
    this.logger = logger;

    this.timer = null;
    this.polling = false;

    this.lastBytes = -1;
    /** Mióta tart folyamatosan a „nincs adat" állapot. */
    this.downSince = null;
    /** A legutóbb KIFELÉ jelentett állapot (debounce után). */
    this.reportedFlowing = false;
  }

  start() {
    if (this.timer) return;
    this.logger.info(
      `Ingest-figyelés indul: ${this.apiBase}/v3/paths/get/${this.path} ` +
        `(${this.pollMs} ms, megszakadás-küszöb ${this.interruptAfterMs} ms)`,
    );
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
    this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A webhookok hívják. Nem állít állapotot, csak azonnali mintavételt kér —
   * így a push-csatorna gyorsít, de nem tud hamis állapotot előidézni.
   */
  hint(event) {
    this.logger.info(`Ingest hook: ${event} — azonnali ellenőrzés.`);
    this.poll();
  }

  async poll() {
    if (this.polling) return; // ne torlódjanak a lekérdezések
    this.polling = true;

    try {
      const status = await this.#fetchStatus();
      this.#report(status);
    } finally {
      this.polling = false;
    }
  }

  async #fetchStatus() {
    const url = `${this.apiBase}/v3/paths/get/${encodeURIComponent(this.path)}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(2000, this.pollMs * 2)),
      });

      if (response.status === 404) {
        // Az útvonal létezik a konfigurációban, de még sosem volt aktív.
        return { available: true, ready: false, bytesReceived: 0, tracks: [], readers: 0 };
      }
      if (!response.ok) {
        return { available: false, lastError: `HTTP ${response.status}` };
      }

      const body = await response.json();
      return {
        available: true,
        ready: body.ready === true,
        bytesReceived: Number(body.bytesReceived ?? 0),
        tracks: Array.isArray(body.tracks) ? body.tracks : [],
        readers: Array.isArray(body.readers) ? body.readers.length : 0,
        sourceType: body.source?.type ?? null,
      };
    } catch (error) {
      return { available: false, lastError: error.message };
    }
  }

  #report(status) {
    const now = Date.now();

    if (!status.available) {
      // A MediaMTX maga nem elérhető. Ez NEM ugyanaz, mint a telefon
      // megszakadása — de az adás szempontjából ugyanúgy nincs kép, ezért
      // a debounce után megszakadásként jelentjük, az `available: false`
      // jelzést viszont külön visszük tovább az admin felületnek.
      this.#emitFlowing(false, now, { ...status, stalled: false });
      this.lastBytes = -1;
      return;
    }

    const moving = status.ready && status.bytesReceived > this.lastBytes;
    const stalled = status.ready && status.bytesReceived === this.lastBytes && this.lastBytes >= 0;

    this.lastBytes = status.bytesReceived;
    this.#emitFlowing(moving, now, { ...status, stalled });
  }

  /**
   * Debounce: a visszatérés AZONNALI, a megszakadás viszont csak
   * `interruptAfterMs` folyamatos hiány után jelentődik. Így egy pillanatnyi
   * zökkenő nem villogtatja a `/live` oldalt, a helyreállás viszont
   * nem késik feleslegesen.
   */
  #emitFlowing(flowing, now, status) {
    if (flowing) {
      this.downSince = null;
      const changed = !this.reportedFlowing;
      this.reportedFlowing = true;
      this.emit('status', { ...status, flowing: true, changed });
      return;
    }

    if (this.downSince === null) this.downSince = now;
    const downFor = now - this.downSince;

    if (this.reportedFlowing && downFor < this.interruptAfterMs) {
      // Türelmi idő: még élőnek jelentjük, de a részletes állapotot visszük.
      this.emit('status', {
        ...status,
        flowing: true,
        pendingInterruption: true,
        downForMs: downFor,
        changed: false,
      });
      return;
    }

    const changed = this.reportedFlowing;
    this.reportedFlowing = false;
    this.emit('status', { ...status, flowing: false, downForMs: downFor, changed });
  }
}
