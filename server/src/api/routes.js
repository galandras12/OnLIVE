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

export function createRoutes({ config, controller, monitor, store, commands, limiter, adminGuard, logger, startedAt }) {
  const router = Router();

  // =========================================================================
  //  A telefon session-jelzései (2. szegmens ↔ 4. szegmens szerződés)
  // =========================================================================

  const session = Router();
  session.use(phoneAuth(config, logger, limiter));

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
