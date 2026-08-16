/**
 * HTTP végpontok.
 *
 * Három, élesen elkülönített csoport, mindegyik saját őrrel:
 *
 *  - `/api/session/*` — a TELEFON jelzései (streamkulcs). Az app nem tud az
 *    intróról vagy az outróról; csak azt mondja meg, mit nyomott a felhasználó.
 *  - `/api/ingest/*`  — a MediaMTX hookjai (közös titok). Nem állítanak
 *    állapotot, csak azonnali ellenőrzést kérnek.
 *  - `/api/admin/*`   — a web UI vezérlése (admin jelszó).
 *
 * Plusz a `/healthz`, amit az 1. szegmens tunnel-watchdogja pollozik.
 */

import { Router } from 'express';
import { Events } from '../state/machine.js';
import { DeviceCommands } from '../device/commands.js';
import { LogEvent, Source, clientId, describeChanges, diffSettings } from '../log/logger.js';
import { hookAuth, phoneAuth } from './auth.js';
import { assessPublicUrls } from '../settings/public-urls.js';
import { localEndpoints } from '../settings/local-address.js';

export function createRoutes({ config, controller, monitor, store, commands, limiter, streamKeys, adminGuard, logger, startedAt }) {
  const router = Router();

  // =========================================================================
  //  A telefon session-jelzései (2. szegmens ↔ 4. szegmens szerződés)
  // =========================================================================

  const session = Router();
  session.use(phoneAuth(config, logger, limiter, streamKeys));

  session.post('/start', (req, res) => {
    if (req.body && Object.keys(req.body).length) controller.updateCapture(req.body);
    commands.touch({ device: req.body?.device, capture: req.body });
    const result = controller.send(Events.SESSION_START, {}, Source.PHONE, clientId(req));
    res.json({ ok: true, state: result.snapshot.state, changed: result.changed });
  });

  session.post('/pause', (req, res) => {
    const result = controller.send(Events.SESSION_PAUSE, { reason: req.body?.reason }, Source.PHONE, clientId(req));
    res.json({ ok: true, state: result.snapshot.state, changed: result.changed });
  });

  session.post('/resume', (req, res) => {
    if (req.body && Object.keys(req.body).length) controller.updateCapture(req.body);
    const result = controller.send(Events.SESSION_RESUME, {}, Source.PHONE, clientId(req));
    res.json({ ok: true, state: result.snapshot.state, changed: result.changed });
  });

  session.post('/end', (req, res) => {
    const result = controller.send(Events.SESSION_END, { reason: req.body?.reason }, Source.PHONE, clientId(req));
    res.json({ ok: true, state: result.snapshot.state, changed: result.changed });
  });

  /** Menet közbeni beállítás-változás (felbontás, lencse, forrás…). */
  session.post('/config', (req, res) => {
    // A telefonon végzett beállítás-változtatás is naplózandó, régi → új
    // értékkel, hogy a két felület módosításai együtt legyenek visszakereshetők.
    const before = controller.capture;
    controller.updateCapture(req.body ?? {});
    commands.touch({ device: req.body?.device, capture: req.body });

    const changes = diffSettings(before, controller.capture, [
      'resolution', 'fps', 'videoBitrateKbps', 'source', 'lens', 'audio',
    ]);
    if (changes) {
      logger.event({
        type: LogEvent.SETTINGS,
        source: Source.PHONE,
        client: clientId(req),
        message: `Capture beállítás a telefonon — ${describeChanges(changes)}`,
        area: 'capture',
        changes,
      });
    }
    res.json({ ok: true });
  });

  /**
   * 3 másodpercenként érkező telemetria.
   *
   * A VÁLASZ hozza a telefonra váró parancsokat (8. szegmens): így a web UI-ról
   * indított kamera-váltás, minőség-állítás vagy „Befejezés" plusz kérés nélkül,
   * legfeljebb 3 másodperces késéssel eljut az apphoz.
   */
  session.post('/stats', (req, res) => {
    controller.updateStats(req.body ?? {});
    commands.touch();
    res.json({ ok: true, commands: commands.pull() });
  });

  /** Külön lekérdezés — ha az app gyorsabb reakciót akar, mint a stats ciklus. */
  session.get('/commands', (req, res) => {
    commands.touch();
    res.json({ commands: commands.pull() });
  });

  /**
   * Kapcsolat-teszt a telefon beállítás-képernyőjéről (1.0.010).
   *
   * Ha ide 200 érkezik, akkor a Tunnel-cím és a streamkulcs is helyes — a
   * felhasználónak nem kell adást indítania ahhoz, hogy kiderüljön, elgépelte-e
   * a kulcsot. A válasz elárulja a WHIP célcímet is, hogy a telefonon látszódjon,
   * hova fog publikálni.
   */
  session.get('/ping', (req, res) => {
    res.json({
      ok: true,
      server: 'OnLIVE',
      state: controller.machine.state,
      streamPath: config.ingest.path,
      ingestUser: config.ingest.user,
      whipUrl: `${config.publicUrls.ingest}/${config.ingest.path}/whip`,
      at: new Date().toISOString(),
    });
  });

  router.use('/api/session', session);

  // =========================================================================
  //  A MediaMTX hookjai (3. szegmens)
  // =========================================================================

  const ingest = Router();
  ingest.use(hookAuth(config, logger));

  const hookHandler = (event) => (req, res) => {
    // SZÁNDÉKOSAN nem állítunk állapotot a hook alapján: csak azonnali
    // ellenőrzést kérünk. A döntés mindig a friss MediaMTX API-válaszon
    // alapul, így egy elveszett vagy hamis hook sem visz tévútra.
    monitor.hint(event);
    res.json({ ok: true });
  };

  ingest.post('/ready', hookHandler('ready'));
  ingest.post('/notready', hookHandler('notready'));

  router.use('/api/ingest', ingest);

  /**
   * A MediaMTX külső hitelesítése (`authMethod: http`, 1.0.010).
   *
   * EZ TESZI LEHETŐVÉ, hogy a streamkulcs sehol ne legyen nyersen tárolva:
   * a MediaMTX nem a saját felhasználólistájából dolgozik, hanem minden
   * publikálási kísérletnél ide kérdez, mi pedig a scrypt hash ellen
   * ellenőrzünk. A `mediamtx.yml`-be így nem kerül titok.
   *
   * A hookAuth-on KÍVÜL van: a MediaMTX nem a mi hook titkunkat küldi, hanem a
   * saját hitelesítési kérését. Cserébe a végpont csak localhostról hívható —
   * a MediaMTX ugyanezen a gépen fut.
   *
   * Válasz: 200 = mehet, 401 = tilos. Ha a vezérlő szerver áll, a MediaMTX
   * minden kérést elutasít — ilyenkor amúgy sincs kinek adást vezérelni.
   */
  router.post('/api/ingest/auth', (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
      req.ip ?? req.socket?.remoteAddress ?? '',
    );
    if (!local) return res.status(401).json({ error: 'Csak helyi hívás.' });

    const { user, password, action, path: streamPath, ip } = req.body ?? {};

    // Olvasás, API, metrikák: a MediaMTX ezekre is kérdez. Ezek localhostra
    // vannak kötve (a lejátszás a mi proxynkon megy), ezért engedjük.
    if (action !== 'publish') return res.json({ ok: true });

    const client = String(ip ?? 'ismeretlen');
    const limited = limiter?.check(`whip:${client}`);
    if (limited && !limited.allowed) {
      logger.warn(`WHIP publish zárlat alatt innen: ${client}`);
      return res.status(401).json({ error: 'Túl sok sikertelen próbálkozás.' });
    }

    const pathOk = String(streamPath ?? '') === config.ingest.path;
    const userOk = String(user ?? '') === config.ingest.user;
    const keyOk = streamKeys?.configured
      ? streamKeys.verify(password ?? '')
      : true; // kulcs nélküli (fejlesztői) állapot — az indulási napló figyelmeztet

    if (pathOk && userOk && keyOk) {
      limiter?.succeed(`whip:${client}`);
      streamKeys?.markUsed();
      logger.event({
        type: LogEvent.INGEST,
        level: 'ok',
        source: Source.PHONE,
        client,
        message: `WHIP publikálás engedélyezve (${streamPath}).`,
        action,
      });
      return res.json({ ok: true });
    }

    limiter?.fail(`whip:${client}`);
    logger.event({
      type: LogEvent.AUTH,
      level: 'warn',
      source: Source.INGEST,
      client,
      message: 'WHIP publikálás elutasítva.',
      reason: !pathOk ? 'ismeretlen útvonal' : !userOk ? 'ismeretlen felhasználó' : 'hibás streamkulcs',
      path: streamPath ?? null,
    });
    return res.status(401).json({ error: 'Érvénytelen streamkulcs.' });
  });

  // =========================================================================
  //  Admin vezérlés (a teljes hitelesítés: 10. szegmens)
  // =========================================================================

  const admin = Router();
  admin.use(adminGuard);

  const adminEvents = {
    start: Events.SESSION_START,
    pause: Events.SESSION_PAUSE,
    resume: Events.SESSION_RESUME,
    end: Events.SESSION_END,
  };

  for (const [name, event] of Object.entries(adminEvents)) {
    admin.post(`/${name}`, (req, res) => {
      // Forrás és kliens: a naplóban meg kell tudni különböztetni, hogy a
      // Kezdés/Befejezés a telefonról vagy a web felületről (és melyik
      // böngészőből) jött — a két felület ugyanazt az átmenetet váltja ki.
      const result = controller.send(event, { reason: req.body?.reason }, Source.WEB, clientId(req));
      res.json({
        ok: true,
        changed: result.changed,
        from: result.from,
        to: result.to,
        reason: result.reason ?? null,
      });
    });
  }

  admin.get('/state', (req, res) => res.json(controller.snapshot()));

  /**
   * A telefon beállításához szükséges címek egy helyen (1.0.010).
   *
   * A streamkulcs-oldal ebből mutatja meg, mit kell az appba beírni — így nem
   * kézzel másolt, elavuló szöveg áll a felületen.
   */
  admin.get('/endpoints', (req, res) => res.json({
    admin: config.publicUrls.admin,
    live: config.publicUrls.live,
    ingest: config.publicUrls.ingest,
    streamPath: config.ingest.path,
    ingestUser: config.ingest.user,
    whipUrl: `${config.publicUrls.ingest}/${config.ingest.path}/whip`,
    /**
     * A címek hibái (1.0.019). A felület ezeket kiírja, mert egy elgépelt
     * alap-cím a telefonon csak egy 404-nek látszik.
     */
    warnings: assessPublicUrls(config.publicUrls),
    /**
     * Helyi (LAN / Tailscale) elérés (1.0.101). Ezeken az alagút megkerülhető,
     * és a WebRTC média is helyben marad — TURN nélkül is van kép.
     */
    local: localEndpoints({ port: config.port, whipPort: config.ingest.whepPort }),
  }));

  admin.get('/transitions', async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 1000);
    res.json(await store.recentTransitions(limit));
  });

  router.use('/api/admin', admin);

  // =========================================================================
  //  Nyilvános állapot és health-check
  // =========================================================================

  /**
   * A `/live` oldalnak és a Browser Source-nak: csak az, ami a
   * megjelenítéshez kell — telemetria és belső részletek nélkül.
   */
  router.get('/api/state', (req, res) => {
    const snapshot = controller.snapshot();
    res.json({
      state: snapshot.state,
      screen: snapshot.screen,
      playIntroMedia: snapshot.context.playIntroMedia,
      introReason: snapshot.context.introReason,
      liveElapsedMs: snapshot.liveElapsedMs,
      outro: snapshot.outro,
      at: snapshot.at,
    });
  });

  /**
   * Health-check. Ezt pollozza az 1. szegmens tunnel-watchdogja
   * (`https://live.galandras.com/healthz`), ezért MINDIG gyorsan és
   * hitelesítés nélkül válaszol.
   *
   * A HTTP státusz szándékosan 200 marad akkor is, ha nincs adás: a watchdog
   * azt figyeli, él-e a szerver az alagút mögött, nem azt, hogy megy-e éppen
   * a közvetítés. Az ingest hibája a törzsben látszik.
   */
  router.get('/healthz', (req, res) => {
    const snapshot = controller.snapshot();
    res.json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      state: snapshot.state,
      screen: snapshot.screen,
      ingest: {
        available: snapshot.ingest.available,
        flowing: snapshot.ingest.flowing,
        stalled: snapshot.ingest.stalled,
      },
      at: new Date().toISOString(),
    });
  });

  return router;
}
