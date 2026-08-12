/**
 * OnLIVE — az adás állapotgépe (4. szegmens).
 *
 * Ez a rendszer szíve. Szándékosan **tiszta** (pure) modul:
 *  - nincs benne I/O, nincs timer, nincs socket, nincs fájlírás,
 *  - az órát kívülről kapja (`now`), így determinisztikusan tesztelhető,
 *  - a mellékhatásokat nem végrehajtja, hanem *kéri* (`effects` lista),
 *    a végrehajtás a controller dolga.
 *
 * Miért nem XState: az itteni logika egyetlen, lapos állapothalmaz néhány
 * őrfeltétellel. Saját implementációban az átmeneti tábla egy képernyőn
 * elfér és pontosan olvasható, nincs függőség, és a küszöb-szabályok
 * (2 perc, paused-izoláció) közvetlenül tesztelhetők.
 *
 * Diagram és részletes leírás: docs/STATE-MACHINE.md
 */

/** @enum {string} */
export const States = Object.freeze({
  IDLE: 'idle',
  INTRO: 'intro',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  PAUSED: 'paused',
  OUTRO: 'outro',
  ENDED: 'ended',
});

/** @enum {string} */
export const Events = Object.freeze({
  /** „Kezdés" — telefonról vagy admin UI-ról. */
  SESSION_START: 'session/start',
  /** „Szünet" — kizárólag felhasználói művelet. */
  SESSION_PAUSE: 'session/pause',
  /** „Folytatás" — kizárólag felhasználói művelet. */
  SESSION_RESUME: 'session/resume',
  /** „Befejezés" — telefonról vagy admin UI-ról. */
  SESSION_END: 'session/end',
  /** Az ingest rétegtől: van bejövő stream, és mozog a bájtszámláló. */
  INGEST_UP: 'ingest/up',
  /** Az ingest rétegtől: nincs stream, vagy megállt (már debounce-olva). */
  INGEST_DOWN: 'ingest/down',
  /** Az outro lejátszási ideje letelt. */
  OUTRO_DONE: 'outro/done',
});

/** Mellékhatás-kérések, amiket a controller hajt végre. */
export const Effects = Object.freeze({
  START_OUTRO_TIMER: 'startOutroTimer',
  CANCEL_OUTRO_TIMER: 'cancelOutroTimer',
  SHUTDOWN: 'shutdown',
});

/** Miért léptünk introba — az overlay réteg (5. szegmens) ebből választ médiát. */
export const IntroReason = Object.freeze({
  /** Friss indítás: „Hamarosan kezdünk". */
  START: 'start',
  /** 2 percnél rövidebb adás szakadt meg: gyakorlatilag el sem kezdődött. */
  INTERRUPTED: 'interrupted',
  /** Szünet után folytatás, de a stream még nem tért vissza. */
  RESUME: 'resume',
});

const DEFAULTS = {
  /**
   * A 2 perces küszöb. FONTOS: ez KIZÁRÓLAG az `intro` vs. `reconnecting`
   * döntést befolyásolja. Semmi máshoz nincs köze — a `paused` állapotra
   * például egyáltalán nem hat.
   */
  liveThresholdMs: 2 * 60 * 1000,
  /**
   * Ha `true`, minden indítás introval kezdődik. Ha `false`, csak a
   * szerverindítás utáni ELSŐ indítás játssza le az intro médiát; a
   * későbbiek is `intro` állapotba mennek (mert a stream még nem érkezett
   * meg, és fekete képet nem mutatunk), de `playMedia: false` jelzéssel.
   */
  introOnEveryStart: true,
};

export class StreamStateMachine {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] injektálható óra (tesztekhez)
   * @param {number} [options.liveThresholdMs]
   * @param {boolean} [options.introOnEveryStart]
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.liveThresholdMs = options.liveThresholdMs ?? DEFAULTS.liveThresholdMs;
    this.introOnEveryStart = options.introOnEveryStart ?? DEFAULTS.introOnEveryStart;

    this._state = States.IDLE;
    this._context = this._freshContext();
    this._context.sessionCount = 0;
  }

  _freshContext() {
    return {
      /** Hányadik session a szerver indulása óta. */
      sessionCount: this._context?.sessionCount ?? 0,
      /** Ez az első indítás a szerver-indítás óta? */
      isFirstStartSinceBoot: false,
      /** Le kell-e játszani az intro médiát (lásd introOnEveryStart). */
      playIntroMedia: false,
      /** Miért vagyunk introban. */
      introReason: null,
      sessionId: null,
      startedAt: null,
      endedAt: null,
      /** Az aktuális live szakasz kezdete, vagy null. */
      liveSince: null,
      /** A korábbi live szakaszok összege ebben a sessionben. */
      liveTotalMs: 0,
      /** Az ingest réteg utolsó ismert állapota (tükör, nem döntéshozó). */
      ingestFlowing: false,
      /** Szünet után folytattunk, de a stream még nem tért vissza. */
      resumePending: false,
      /** Számlálók a naplóhoz (9. szegmens). */
      interruptions: 0,
      pauses: 0,
      lastTransitionAt: null,
    };
  }

  get state() {
    return this._state;
  }

  get context() {
    return { ...this._context };
  }

  /**
   * Az aktuális session összes élő ideje ezredmásodpercben.
   * A megszakadás előtti szakaszok ÖSSZEADÓDNAK — így egy 1 perc 55
   * másodperces adás után egy pillanatnyi zökkenő, majd további 10 másodperc
   * élő adás már átlépi a küszöböt.
   */
  liveElapsedMs() {
    const running = this._context.liveSince ? this.now() - this._context.liveSince : 0;
    return this._context.liveTotalMs + running;
  }

  /** Teljes, kifelé adható pillanatkép (Socket.io és REST is ezt küldi). */
  snapshot() {
    return {
      state: this._state,
      context: this.context,
      liveElapsedMs: this.liveElapsedMs(),
      liveThresholdMs: this.liveThresholdMs,
      /**
       * A `/live` oldalnak: a `paused` és a `reconnecting` UGYANAZT a
       * „Megszakadt" képernyőt mutatja — a különbség csak a viselkedésben van.
       */
      screen: screenFor(this._state),
      at: this.now(),
    };
  }

  /**
   * Esemény feldolgozása.
   *
   * @param {string} event a {@link Events} egyike
   * @param {object} [payload]
   * @returns {{changed: boolean, from: string, to: string, event: string,
   *            at: number, reason?: string, effects: Array<{type: string}>,
   *            snapshot: object}}
   */
  send(event, payload = {}) {
    const from = this._state;
    const at = this.now();
    const effects = [];

    const decision = this._decide(event, payload, at);

    if (!decision.to || decision.to === from) {
      return {
        changed: false,
        from,
        to: from,
        event,
        at,
        reason: decision.reason ?? 'nincs átmenet ehhez az eseményhez ebben az állapotban',
        effects: decision.effects ?? [],
        snapshot: this.snapshot(),
      };
    }

    this._exit(from, at);
    this._enter(decision.to, from, event, at, decision.contextPatch ?? {});
    this._state = decision.to;
    this._context.lastTransitionAt = at;

    effects.push(...(decision.effects ?? []));

    // Az outro időzítőt minden olyan átmenet leállítja, ami elhagyja az outrót.
    if (from === States.OUTRO && decision.to !== States.OUTRO) {
      effects.unshift({ type: Effects.CANCEL_OUTRO_TIMER });
    }

    return {
      changed: true,
      from,
      to: decision.to,
      event,
      at,
      effects,
      snapshot: this.snapshot(),
    };
  }

  // -------------------------------------------------------------------------
  // Átmeneti tábla
  // -------------------------------------------------------------------------

  _decide(event, payload, at) {
    const s = this._state;
    const ctx = this._context;

    switch (event) {
      // --- Felhasználói: Kezdés -------------------------------------------
      case Events.SESSION_START: {
        if (s === States.IDLE || s === States.ENDED || s === States.OUTRO) {
          const sessionCount = ctx.sessionCount + 1;
          const isFirst = sessionCount === 1;
          return {
            to: States.INTRO,
            contextPatch: {
              newSession: true,
              sessionCount,
              isFirstStartSinceBoot: isFirst,
              playIntroMedia: this.introOnEveryStart || isFirst,
              introReason: IntroReason.START,
            },
          };
        }
        return { reason: `már fut egy session (${s})` };
      }

      // --- Felhasználói: Befejezés ----------------------------------------
      case Events.SESSION_END: {
        if (s === States.IDLE || s === States.ENDED || s === States.OUTRO) {
          return { reason: `nincs mit befejezni (${s})` };
        }
        return {
          to: States.OUTRO,
          effects: [{ type: Effects.START_OUTRO_TIMER }],
        };
      }

      // --- Felhasználói: Szünet -------------------------------------------
      //
      // Időtartam-küszöb NÉLKÜL, bármikor előidézhető, amíg fut a session.
      case Events.SESSION_PAUSE: {
        if (s === States.LIVE || s === States.INTRO || s === States.RECONNECTING) {
          return { to: States.PAUSED, contextPatch: { pauses: ctx.pauses + 1 } };
        }
        return { reason: `szünet nem értelmezhető ebben az állapotban (${s})` };
      }

      // --- Felhasználói: Folytatás ----------------------------------------
      //
      // A `paused`-ból KIZÁRÓLAG ez vezet ki (vagy a Befejezés).
      case Events.SESSION_RESUME: {
        if (s !== States.PAUSED) {
          return { reason: `nincs mit folytatni (${s})` };
        }
        if (ctx.ingestFlowing) {
          return { to: States.LIVE, contextPatch: { resumePending: false } };
        }
        // A stream még nem tért vissza: ugyanaz a 2 perces szabály dönt
        // arról, melyik várakozó képernyő legyen.
        const longEnough = this.liveElapsedMs() >= this.liveThresholdMs;
        return {
          to: longEnough ? States.RECONNECTING : States.INTRO,
          contextPatch: {
            resumePending: true,
            introReason: longEnough ? null : IntroReason.RESUME,
            playIntroMedia: false,
          },
        };
      }

      // --- Ingest: van bejövő stream --------------------------------------
      case Events.INGEST_UP: {
        this._context.ingestFlowing = true;

        // KRITIKUS: szünet közben az ingest NEM vált állapotot. A szünet
        // szándékos, csak a „Folytatás" hozhatja vissza.
        if (s === States.PAUSED) {
          return { reason: 'szünet közben az ingest-jelzés nem vált állapotot' };
        }
        if (s === States.INTRO || s === States.RECONNECTING) {
          return { to: States.LIVE, contextPatch: { resumePending: false } };
        }
        return { reason: `az ingest-jelzés nem releváns ebben az állapotban (${s})` };
      }

      // --- Ingest: nincs stream / megállt (már debounce-olva) -------------
      case Events.INGEST_DOWN: {
        this._context.ingestFlowing = false;

        if (s === States.PAUSED) {
          return { reason: 'szünet közben az ingest-jelzés nem vált állapotot' };
        }
        if (s !== States.LIVE) {
          return { reason: `nem élő állapotban nincs mit megszakítani (${s})` };
        }

        // ★ A 2 perces szabály — az EGYETLEN hely, ahol számít.
        const elapsed = this.liveElapsedMs();
        if (elapsed >= this.liveThresholdMs) {
          return {
            to: States.RECONNECTING,
            contextPatch: { interruptions: ctx.interruptions + 1 },
          };
        }
        return {
          to: States.INTRO,
          contextPatch: {
            interruptions: ctx.interruptions + 1,
            introReason: IntroReason.INTERRUPTED,
            playIntroMedia: true,
          },
        };
      }

      // --- Az outro lejárt -------------------------------------------------
      case Events.OUTRO_DONE: {
        if (s !== States.OUTRO) {
          return { reason: `nem outro állapotban vagyunk (${s})` };
        }
        return { to: States.ENDED, effects: [{ type: Effects.SHUTDOWN }] };
      }

      default:
        return { reason: `ismeretlen esemény: ${event}` };
    }
  }

  // -------------------------------------------------------------------------
  // Belépés / kilépés
  // -------------------------------------------------------------------------

  _exit(state, at) {
    if (state === States.LIVE && this._context.liveSince) {
      this._context.liveTotalMs += at - this._context.liveSince;
      this._context.liveSince = null;
    }
  }

  _enter(to, from, event, at, patch) {
    if (patch.newSession) {
      const { sessionCount } = patch;
      this._context = this._freshContext();
      this._context.sessionCount = sessionCount;
      this._context.sessionId = `s${sessionCount}-${at}`;
      this._context.startedAt = at;
    }

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'newSession' || key === 'sessionCount') continue;
      this._context[key] = value;
    }

    if (to === States.LIVE) {
      this._context.liveSince = at;
      this._context.introReason = null;
      this._context.resumePending = false;
    }

    if (to === States.ENDED) {
      this._context.endedAt = at;
    }
  }
}

/**
 * Melyik képernyőt mutassa a `/live` oldal.
 *
 * A `paused` és a `reconnecting` SZÁNDÉKOSAN ugyanaz vizuálisan —
 * a néző nem tudja, és nem is kell tudnia, hogy a szakadás szándékos volt-e.
 */
export function screenFor(state) {
  switch (state) {
    case States.INTRO:
      return 'intro';
    case States.LIVE:
      return 'live';
    case States.RECONNECTING:
    case States.PAUSED:
      return 'interrupted';
    case States.OUTRO:
      return 'outro';
    case States.ENDED:
    case States.IDLE:
    default:
      return 'blank';
  }
}
