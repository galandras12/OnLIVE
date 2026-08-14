/**
 * A session controller: az állapotgép köré épített futtatókörnyezet.
 *
 * Felelőssége:
 *  - az események továbbítása a tiszta állapotgépnek,
 *  - a gép által KÉRT mellékhatások végrehajtása (outro időzítő, leállítás),
 *  - az átmenetek naplózása és a pillanatkép mentése,
 *  - a teljes, kifelé adható állapot összeállítása (gép + ingest + telemetria),
 *  - értesítés minden változásról (`change` esemény → Socket.io broadcast).
 *
 * Az állapotgép maga tiszta marad (`state/machine.js`) — minden I/O itt van.
 */

import { EventEmitter } from 'node:events';
import { Effects, Events, States, StreamStateMachine } from './machine.js';

export class SessionController extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => number} [deps.outroDurationMs] az outro hossza — futásidőben
   *   az admin felületen állítható (5. szegmens), ezért függvényként kapjuk,
   *   nem fix értékként. Alapértelmezés: a konfigurációs érték.
   * @param {{closePublisher: () => Promise<object>}} [deps.ingestControl]
   *   az `ended` állapotban a publisher lekapcsolásához.
   */
  constructor({ config, store, logger, outroDurationMs, ingestControl }) {
    super();
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.outroDurationMs = outroDurationMs ?? (() => config.machine.outroDurationMs);
    this.ingestControl = ingestControl ?? null;

    this.machine = new StreamStateMachine({
      liveThresholdMs: config.machine.liveThresholdMs,
      introOnEveryStart: config.machine.introOnEveryStart,
    });

    this.outroTimer = null;

    /** Az ingest réteg utolsó ismert állapota (3. szegmens). */
    this.ingest = {
      available: false,
      flowing: false,
      stalled: false,
      bytesReceived: 0,
      tracks: [],
      readers: 0,
      lastChangeAt: null,
      lastError: null,
    };

    /** A telefon telemetriája (2. szegmens `session/stats`). */
    this.stats = null;

    /** A telefon aktuális capture-beállításai (`session/config`). */
    this.capture = null;
  }

  // -------------------------------------------------------------------------
  // Események
  // -------------------------------------------------------------------------

  /**
   * @param {string} event a machine.Events egyike
   * @param {object} [payload]
   * @param {string} [source] ki küldte: 'phone' | 'admin' | 'ingest' | 'timer'
   */
  send(event, payload = {}, source = 'system') {
    const result = this.machine.send(event, payload);

    if (result.changed) {
      this.logger.state(
        `${result.from} → ${result.to}   (${event}, forrás: ${source})`,
      );
      this.#runEffects(result.effects);
      this.#persist(result, source, payload);
    } else if (event !== Events.INGEST_UP && event !== Events.INGEST_DOWN) {
      // Az ingest-jelzések másodpercenként érkeznek, azokat nem naplózzuk,
      // ha nem történt átmenet — a felhasználói műveleteket viszont igen.
      this.logger.info(`Figyelmen kívül hagyva: ${event} (${result.reason})`);
    }

    this.emit('change', this.snapshot(), result);
    return result;
  }

  #runEffects(effects) {
    for (const effect of effects) {
      switch (effect.type) {
        case Effects.START_OUTRO_TIMER: {
          this.#clearOutroTimer();
          const ms = this.outroDurationMs();
          this.logger.info(`Outro indul, ${Math.round(ms / 1000)} másodperc.`);
          this.outroTimer = setTimeout(() => {
            this.outroTimer = null;
            this.send(Events.OUTRO_DONE, {}, 'timer');
          }, ms);
          this.outroTimer.unref?.();
          break;
        }

        case Effects.CANCEL_OUTRO_TIMER:
          this.#clearOutroTimer();
          break;

        case Effects.SHUTDOWN:
          this.#onEnded();
          break;

        default:
          this.logger.warn(`Ismeretlen mellékhatás: ${effect.type}`);
      }
    }
  }

  #clearOutroTimer() {
    if (this.outroTimer) {
      clearTimeout(this.outroTimer);
      this.outroTimer = null;
    }
  }

  /**
   * `ended`: a SESSION zárul le, nem a folyamat.
   *
   * A publisher-kapcsolatot aktívan bontjuk, különben egy ottragadt telefon
   * miatt a következő session azonnal `live`-ba ugorhatna egy régi stream
   * alapján. A MediaMTX és a vezérlő szerver fut tovább, készen a következő
   * adásra — a folyamat leállítása csak külön kérésre történik.
   */
  #onEnded() {
    this.logger.ok('Az adás lezárult (ended).');

    if (this.ingestControl) {
      this.ingestControl
        .closePublisher()
        .then((result) => {
          if (!result.closed && result.reason !== 'nincs aktív publisher') {
            this.logger.warn(`A publisher lezárása nem sikerült: ${result.reason}`);
          }
        })
        .catch((error) => this.logger.warn(`A publisher lezárása hibára futott: ${error.message}`));
    }

    if (this.config.machine.shutdownOnEnded) {
      this.logger.warn('ONLIVE_SHUTDOWN_ON_ENDED=true — a szerver folyamat is leáll.');
      setTimeout(() => process.exit(0), 500).unref?.();
    }
  }

  async #persist(result, source, payload) {
    const entry = {
      at: new Date(result.at).toISOString(),
      sessionId: result.snapshot.context.sessionId,
      from: result.from,
      to: result.to,
      event: result.event,
      source,
      liveElapsedMs: result.snapshot.liveElapsedMs,
      ...(payload?.reason ? { reason: payload.reason } : {}),
    };
    await this.store.appendTransition(entry);
    await this.store.saveSnapshot(this.snapshot());
  }

  // -------------------------------------------------------------------------
  // Az ingest rétegtől érkező állapot
  // -------------------------------------------------------------------------

  /**
   * Az IngestMonitor hívja minden mintavétel után. A már debounce-olt
   * `flowing` értékből képezünk gépi eseményt — a monitor dolga eldönteni,
   * mikor számít a szakadás valódinak.
   *
   * SZINTVEZÉRELT, nem élvezérelt: minden mintavételnél elküldjük az aktuális
   * helyzetnek megfelelő eseményt, akkor is, ha az előzőhöz képest nem
   * változott. Az állapotgép idempotens, a felesleges eseményt eldobja.
   *
   * Miért nem elég az élvezérlés: az állapot a MÁSIK oldalon is változhat.
   * Ha a felhasználó akkor nyom „Kezdés"-t, amikor a telefon már publikál
   * (pl. az app hamarabb csatlakozott vissza, vagy a szerver indult újra egy
   * élő adás alatt), akkor élvezérléssel soha nem jönne INGEST_UP él — a
   * szerver örökre `intro`-ban ragadna, miközben megy a stream. Ezt a hibát
   * a 4. szegmens végponttól végpontig tesztje fogta meg.
   */
  updateIngest(status) {
    const wasFlowing = this.ingest.flowing;
    const wasAvailable = this.ingest.available;

    this.ingest = { ...this.ingest, ...status };
    if (status.flowing !== wasFlowing) this.ingest.lastChangeAt = Date.now();

    this.send(
      status.flowing ? Events.INGEST_UP : Events.INGEST_DOWN,
      { stalled: status.stalled },
      'ingest',
    );

    if (status.available !== wasAvailable) {
      this.logger[status.available ? 'ok' : 'error'](
        status.available
          ? 'A MediaMTX API újra elérhető.'
          : `A MediaMTX API nem elérhető: ${status.lastError ?? 'ismeretlen ok'}`,
      );
    }
    // A `change` eseményt már a fenti send() kiadta — nem duplikáljuk.
  }

  updateStats(stats) {
    this.stats = { ...stats, receivedAt: Date.now() };
    this.emit('change', this.snapshot(), null);
  }

  updateCapture(capture) {
    this.capture = { ...capture, receivedAt: Date.now() };
    this.logger.info(
      `A telefon beállításai: ${capture.resolution ?? '?'}@${capture.fps ?? '?'} · ` +
        `${capture.videoBitrateKbps ?? '?'} kbps · forrás: ${capture.source ?? '?'}`,
    );
    this.emit('change', this.snapshot(), null);
  }

  // -------------------------------------------------------------------------
  // Kifelé adott állapot
  // -------------------------------------------------------------------------

  /**
   * A teljes pillanatkép. Ezt kapja a Socket.io minden kliens, a `/live`
   * oldal és az admin felület egyaránt — így garantáltan ugyanazt látják.
   */
  snapshot() {
    const machine = this.machine.snapshot();
    return {
      ...machine,
      ingest: {
        available: this.ingest.available,
        flowing: this.ingest.flowing,
        stalled: this.ingest.stalled,
        tracks: this.ingest.tracks,
        readers: this.ingest.readers,
        lastChangeAt: this.ingest.lastChangeAt,
      },
      stats: this.stats,
      capture: this.capture,
      outro: {
        durationMs: this.outroDurationMs(),
        endsAt:
          machine.state === States.OUTRO && machine.context.lastTransitionAt
            ? machine.context.lastTransitionAt + this.outroDurationMs()
            : null,
      },
    };
  }

  stop() {
    this.#clearOutroTimer();
  }
}
