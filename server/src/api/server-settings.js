/**
 * Szerver-beállítások a webes felületről (1.0.011).
 *
 *  - `GET    /api/admin/server` — a futó és a beállított port, forrás, függőségek
 *  - `POST   /api/admin/server/port` — új port (a KÖVETKEZŐ indításkor él)
 *  - `DELETE /api/admin/server/port` — vissza a környezeti változóhoz/alapértékhez
 *
 * Miért nem lép életbe azonnal: a port cseréje új figyelő socketet jelent. A
 * meglévő kapcsolatok (Socket.io a `/live`-hoz és az adminhoz, a WHEP proxy
 * munkamenetei, éppen zajló adás) mind elszakadnának — ráadásul a cloudflared
 * és a MediaMTX is a régi portra mutatna. Ezért a szerver csak eltárolja, és a
 * következő indulásnál veszi figyelembe.
 */

import { Router } from 'express';

import { assessPort } from '../settings/store.js';
import { LogEvent, Source, clientId, describeChanges } from '../log/logger.js';

export function createServerSettingsRoutes({ settings, config, logger, adminGuard, dependencyCheck }) {
  const router = Router();
  const admin = Router();
  // Ugyanaz az őr, mint mindenhol: munkamenet + CSRF + sebességkorlát.
  admin.use(adminGuard);

  /**
   * Amit a port átállítása MÉG érint. A felület ezt listázza ki, mert a két
   * másik komponens a régi porton keresné a szervert: a tunnel mögött
   * „502 Bad Gateway" lenne, a MediaMTX pedig minden WHIP publikálást
   * elutasítana.
   */
  const dependencies = (port) => ([
    {
      id: 'cloudflared',
      name: 'Cloudflare Tunnel',
      file: 'config.yml (a .cloudflared mappában)',
      change: `service: http://localhost:${port}`,
      why: 'enélkül a publikus címek 502-t adnak',
    },
    {
      id: 'mediamtx',
      name: 'MediaMTX',
      file: config.autostart.mediamtxConfig,
      change: `authHTTPAddress: http://127.0.0.1:${port}/api/ingest/auth`,
      why: 'enélkül a telefon nem tud publikálni (401 a WHIP-en)',
    },
    {
      id: 'watchdog',
      name: 'Tunnel watchdog',
      file: 'scripts/tunnel-watchdog.ps1',
      change: `-OriginPort ${port}`,
      why: 'enélkül a watchdog állónak hinné a szervert',
    },
  ]);

  const state = () => {
    const status = settings.status(config.port);
    return {
      ...status,
      dependencies: dependencies(status.port),
      /** Amit a rendszer indulásakor a fájlokban találtunk (ha ellenőrizhető). */
      dependencyCheck: dependencyCheck?.() ?? [],
    };
  };

  admin.get('/', (req, res) => res.json(state()));

  admin.post('/port', async (req, res) => {
    const assessment = assessPort(req.body?.port);
    if (!assessment.ok) return res.status(400).json({ error: assessment.error });

    const before = settings.status(config.port).port;
    try {
      await settings.setPort(assessment.port, { by: clientId(req) });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const changes = { port: { regi: before, uj: assessment.port } };
    logger.event({
      type: LogEvent.SETTINGS,
      level: 'warn',
      source: Source.WEB,
      client: clientId(req),
      message: `Szerver port módosítva — ${describeChanges(changes)} `
        + '(a következő indításkor lép életbe)',
      area: 'szerver',
      changes,
    });

    res.json({
      ok: true,
      ...state(),
      warning: assessment.warning ?? null,
      message: assessment.port === config.port
        ? 'A szerver már ezen a porton fut.'
        : `Mentve. A szerver a következő indításkor a ${assessment.port}-es porton indul.`,
    });
  });

  admin.delete('/port', async (req, res) => {
    const before = settings.status(config.port).port;
    await settings.clearPort();
    const after = state();

    logger.event({
      type: LogEvent.SETTINGS,
      level: 'warn',
      source: Source.WEB,
      client: clientId(req),
      message: `Szerver port visszaállítva — ${describeChanges({ port: { regi: before, uj: after.port } })}`,
      area: 'szerver',
      changes: { port: { regi: before, uj: after.port } },
    });

    res.json({ ok: true, ...after });
  });

  router.use('/api/admin/server', admin);

  return router;
}
