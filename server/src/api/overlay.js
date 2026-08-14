/**
 * Overlay végpontok (6. szegmens — a renderelés oldala).
 *
 *  - `GET  /api/overlay`             — az elrendezés a `/live` oldalnak.
 *  - `PUT  /api/admin/overlay`       — a teljes elrendezés cseréje.
 *  - `PATCH /api/admin/overlay/:id`  — egyetlen widget módosítása (mozgatás).
 *
 * Minden módosítás után azonnal megy a `onlive:overlay` socket esemény, így
 * a `/live` oldal és az OBS Browser Source **újratöltés nélkül** követi a
 * mozgatást — ez a szegmens egyik kifejezett elvárása.
 *
 * A widget-szerkesztő felület, a chat-források és az értesítés-küldés a
 * 7. szegmensé; ez a réteg csak tárol, validál és kiad.
 */

import { Router } from 'express';
import { adminAuth } from './auth.js';

export function createOverlayRoutes({ config, overlayStore, controller, logger, liveAuth }) {
  const router = Router();

  router.get('/api/overlay', liveAuth, (req, res) => res.json(overlayStore.manifest()));

  const admin = Router();
  admin.use(adminAuth(config, logger));

  admin.get('/', (req, res) => res.json(overlayStore.manifest()));

  admin.put('/', async (req, res) => {
    try {
      const manifest = await overlayStore.replaceAll(req.body?.widgets ?? []);
      controller.emit('overlay', manifest);
      res.json({ ok: true, ...manifest });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.patch('/:id', async (req, res) => {
    try {
      const widget = await overlayStore.update(req.params.id, req.body ?? {});
      controller.emit('overlay', overlayStore.manifest());
      res.json({ ok: true, widget });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  router.use('/api/admin/overlay', admin);

  return router;
}
