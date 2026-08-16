/**
 * Streamkulcs-kezelés a webes felületről (1.0.010).
 *
 *  - `GET    /api/admin/stream-key`           — állapot (a kulcs értéke nélkül)
 *  - `POST   /api/admin/stream-key/check`     — jelölt ellenőrzése mentés nélkül
 *  - `POST   /api/admin/stream-key/generate`  — a szerver generál; a nyers érték
 *                                               EGYSZER, ebben a válaszban látszik
 *  - `POST   /api/admin/stream-key`           — kézzel megadott kulcs
 *  - `DELETE /api/admin/stream-key`           — visszavonás
 *
 * A nyers kulcs egyetlen helyen hagyja el a szervert: a létrehozás válaszában.
 * Utána már sehonnan nem kérdezhető vissza — sem fájlból, sem API-n keresztül —,
 * mert csak a scrypt hash-e létezik.
 */

import { Router } from 'express';

import { assessStreamKey, generateStreamKey, keyRules } from '../security/stream-key.js';
import { LogEvent, Source, clientId } from '../log/logger.js';

export function createStreamKeyRoutes({ streamKeys, adminGuard, logger }) {
  const router = Router();
  const admin = Router();
  admin.use(adminGuard);

  const logChange = (req, message, extra = {}) => {
    logger.event({
      type: LogEvent.SETTINGS,
      level: 'ok',
      source: Source.WEB,
      client: clientId(req),
      message,
      area: 'streamkulcs',
      // A kulcs értéke SOHA nem kerül a naplóba — csak az, hogy változott.
      ...extra,
    });
  };

  admin.get('/', async (req, res) => {
    await streamKeys.ready;
    res.json(streamKeys.status());
  });

  /**
   * Élő visszajelzés gépelés közben.
   *
   * A böngésző ugyanezeket a szabályokat futtatja helyben is, de a mentés
   * szerveroldalon is ellenőriz — a felület nem hitelesítő réteg.
   */
  admin.post('/check', (req, res) => {
    const assessment = assessStreamKey(req.body?.key ?? '');
    res.json({ ok: assessment.ok, checks: assessment.checks, error: assessment.error ?? null });
  });

  admin.post('/generate', async (req, res) => {
    try {
      const length = Math.min(64, Math.max(16, Number(req.body?.length) || 32));
      const key = generateStreamKey(length);
      const status = await streamKeys.set(key, { by: clientId(req), origin: 'generalt' });

      logChange(req, `Streamkulcs generálva (${length} karakter).`, {
        origin: 'generalt',
        rotations: status.rotations,
      });

      // Az EGYETLEN alkalom, amikor a nyers kulcs kimegy a szerverről.
      res.json({ ok: true, key, status, once: true });
    } catch (error) {
      res.status(400).json({ error: error.message, checks: error.checks });
    }
  });

  admin.post('/', async (req, res) => {
    const key = String(req.body?.key ?? '');
    try {
      const status = await streamKeys.set(key, { by: clientId(req), origin: 'kezi' });
      logChange(req, 'Streamkulcs kézzel beállítva.', { origin: 'kezi', rotations: status.rotations });
      res.json({ ok: true, status });
    } catch (error) {
      const assessment = assessStreamKey(key);
      res.status(400).json({ error: error.message, checks: assessment.checks });
    }
  });

  admin.delete('/', async (req, res) => {
    const status = await streamKeys.clear();
    logChange(req, 'Streamkulcs visszavonva — a telefon nem tud publikálni, amíg nincs új.');
    res.json({ ok: true, status });
  });

  router.use('/api/admin/stream-key', admin);

  /** A követelmények listája a bejelentkező felületnek is (nem titok). */
  router.get('/api/stream-key/rules', (req, res) => res.json({ rules: keyRules() }));

  return router;
}
