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
import { isAdminSocket, isLiveTokenValid } from '../api/auth.js';
import { LogEvent, Source } from '../log/logger.js';

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
  /**
   * Overlay-elrendezés (6. szegmens): widget mozgatása, ki-be kapcsolása.
   * Ettől frissül a Browser Source újratöltés nélkül.
   */
  OVERLAY: 'onlive:overlay',
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

export function attachSocket(httpServer, { controller, mediaStore, overlayStore, config, sessions, logger }) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    serveClient: true,
  });

  // Ha a `/live` tokennel védett, a socket kapcsolat is azt kéri — különben
  // az állapot-folyam token nélkül is kiolvasható lenne.
  io.use((socket, next) => {
    if (isLiveTokenValid(config ?? {}, socket.handshake.query?.token)) return next();
    next(new Error('Érvénytelen lejátszási token.'));
  });

  io.on('connection', (socket) => {
    /*
      A szerep nem kérés kérdése, hanem jogosultságé (10. szegmens): az admin
      csatorna telemetriát, ingest-részleteket és session-azonosítót is szór.
      Aki nem tud felmutatni admin munkamenetet, `live` szerepet kap — akkor
      is, ha adminként jelentkezett be.
    */
    const wantsAdmin = socket.handshake.query?.role === 'admin';
    const role = wantsAdmin && isAdminSocket(config ?? {}, socket.handshake, sessions) ? 'admin' : 'live';
    if (wantsAdmin && role !== 'admin') {
      logger.warn(`Admin socket-szerep elutasítva: ${socket.id}`);
    }
    socket.join(role);

    /*
      Az OBS Browser Source és egy sima böngésző is `live` szerepben jön, de
      a User-Agentből megkülönböztethető — az OBS beépített CEF-je jellemzően
      "OBS" jelölést visz. A naplóban így látszik, mikor csatlakozott rá az
      OBS, és mikor egy néző.
    */
    const agent = String(socket.handshake.headers['user-agent'] ?? '');
    const kind = role === 'admin' ? Source.WEB : (/OBS|CEF/i.test(agent) ? Source.OBS : Source.WEB);
    const ip = socket.handshake.address ?? 'ismeretlen';

    logger.event({
      type: LogEvent.CLIENT,
      source: kind,
      client: `${ip}/${socket.id.slice(0, 6)}`,
      message: `Kapcsolat létrejött (${kind === Source.OBS ? 'OBS Browser Source' : role === 'admin' ? 'admin felület' : 'néző'}).`,
      role,
      userAgent: agent.slice(0, 120),
    });

    const snapshot = controller.snapshot();
    socket.emit(SocketEvents.STATE, role === 'admin' ? snapshot : publicView(snapshot));
    if (mediaStore) socket.emit(SocketEvents.MEDIA, mediaStore.manifest());
    if (overlayStore) socket.emit(SocketEvents.OVERLAY, overlayStore.manifest());

    socket.on('disconnect', (reason) => {
      logger.event({
        type: LogEvent.CLIENT,
        source: kind,
        client: `${ip}/${socket.id.slice(0, 6)}`,
        message: `Kapcsolat megszakadt (${reason}).`,
        role,
        reason,
      });
    });
  });

  controller.on('media', (manifest) => {
    io.emit(SocketEvents.MEDIA, manifest);
  });

  controller.on('overlay', (manifest) => {
    io.emit(SocketEvents.OVERLAY, manifest);
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
