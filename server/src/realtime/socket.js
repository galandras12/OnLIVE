/**
 * Valós idejű állapot-szinkron (Socket.io).
 *
 * Minden állapotátmenethez tartozik esemény, hogy a web UI és az OBS
 * Browser Source végpont is azonnal kövesse a változást — poll nélkül.
 *
 * Két szerep, két információs szint:
 *
 *  - `live`  — a `/live` kompozit oldal és az OBS. Csak azt kapja, ami a
 *    megjelenítéshez kell. Nem lát telemetriát és belső részleteket.
 *  - `admin` — a vezérlőfelület. Mindent lát: ingest-állapot, a telefon
 *    bitrátája/fps-e/RTT-je, capture-beállítások.
 *
 * A szerepet a kliens a kapcsolat query paraméterében kéri
 * (`io('…', { query: { role: 'live' } })`), és külön szobába kerül.
 */

import { Server } from 'socket.io';

export const SocketEvents = Object.freeze({
  /** Teljes pillanatkép — csatlakozáskor és minden változáskor. */
  STATE: 'onlive:state',
  /** Egy konkrét átmenet: honnan, hova, milyen esemény hatására. */
  TRANSITION: 'onlive:transition',
  /** Állapot-specifikus események — a UI ezekre köthet animációt/médiát. */
  ENTER_IDLE: 'onlive:idle',
  ENTER_INTRO: 'onlive:intro',
  ENTER_LIVE: 'onlive:live',
  ENTER_RECONNECTING: 'onlive:reconnecting',
  ENTER_PAUSED: 'onlive:paused',
  ENTER_OUTRO: 'onlive:outro',
  ENTER_ENDED: 'onlive:ended',
  /** Csak adminnak: telefon-telemetria és ingest-részletek. */
  STATS: 'onlive:stats',
  INGEST: 'onlive:ingest',
  /**
   * Médiaváltozás (5. szegmens): feltöltés, törlés, beállítás-módosítás.
   * Enélkül egy már megnyitott OBS Browser Source a régi fájlt mutatná.
   */
  MEDIA: 'onlive:media',
});

const ENTER_EVENT = {
  idle: SocketEvents.ENTER_IDLE,
  intro: SocketEvents.ENTER_INTRO,
  live: SocketEvents.ENTER_LIVE,
  reconnecting: SocketEvents.ENTER_RECONNECTING,
  paused: SocketEvents.ENTER_PAUSED,
  outro: SocketEvents.ENTER_OUTRO,
  ended: SocketEvents.ENTER_ENDED,
};

/** A `/live` oldalnak szánt, szűkített nézet. */
function publicView(snapshot) {
  return {
    state: snapshot.state,
    screen: snapshot.screen,
    playIntroMedia: snapshot.context.playIntroMedia,
    introReason: snapshot.context.introReason,
    liveElapsedMs: snapshot.liveElapsedMs,
    outro: snapshot.outro,
    at: snapshot.at,
  };
}

export function attachSocket(httpServer, { controller, mediaStore, logger }) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    serveClient: true,
  });

  io.on('connection', (socket) => {
    const role = socket.handshake.query?.role === 'admin' ? 'admin' : 'live';
    socket.join(role);

    logger.info(`Socket csatlakozott: ${socket.id} (szerep: ${role})`);

    const snapshot = controller.snapshot();
    socket.emit(SocketEvents.STATE, role === 'admin' ? snapshot : publicView(snapshot));
    if (mediaStore) socket.emit(SocketEvents.MEDIA, mediaStore.manifest());

    socket.on('disconnect', (reason) => {
      logger.info(`Socket lecsatlakozott: ${socket.id} (${reason})`);
    });
  });

  controller.on('media', (manifest) => {
    io.emit(SocketEvents.MEDIA, manifest);
  });

  controller.on('change', (snapshot, result) => {
    io.to('admin').emit(SocketEvents.STATE, snapshot);
    io.to('live').emit(SocketEvents.STATE, publicView(snapshot));

    if (result?.changed) {
      const transition = {
        from: result.from,
        to: result.to,
        event: result.event,
        at: result.at,
        screen: snapshot.screen,
      };
      io.emit(SocketEvents.TRANSITION, transition);

      const enterEvent = ENTER_EVENT[result.to];
      if (enterEvent) {
        io.to('admin').emit(enterEvent, snapshot);
        io.to('live').emit(enterEvent, publicView(snapshot));
      }
    }

    // A részletek csak az adminnak mennek.
    io.to('admin').emit(SocketEvents.INGEST, snapshot.ingest);
    if (snapshot.stats) io.to('admin').emit(SocketEvents.STATS, snapshot.stats);
  });

  return io;
}
