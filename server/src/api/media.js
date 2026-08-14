/**
 * Média végpontok (5. szegmens).
 *
 *  - `/api/admin/media/*` — feltöltés, törlés, beállítások (admin jelszó).
 *  - `/api/media`         — manifest a `/live` oldalnak (nyilvános, csak leírás).
 *  - `/media/:slot`       — maga a fájl (nyilvános, mert az OBS és a nézők
 *                           böngészője tölti be).
 */

import { Router } from 'express';
import multer from 'multer';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { SLOTS } from '../media/store.js';
import { ALLOWED_MIME_TYPES, validateMedia } from '../media/validate.js';
import { adminAuth } from './auth.js';

/** 512 MB — egy intro/outro videóhoz bőven elég, de nem engedi a lemezt megtölteni. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export function createMediaRoutes({ config, mediaStore, controller, logger, liveAuth }) {
  // Ha a `/live` tokennel védett, a médiafájlok is azok — különben az intro
  // és az outro videó token nélkül letölthető maradna.
  const guard = liveAuth ?? ((req, res, next) => next());
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // =========================================================================
  //  Admin: feltöltés és beállítások
  // =========================================================================

  const admin = Router();
  admin.use(adminAuth(config, logger));

  admin.get('/', (req, res) => res.json(mediaStore.manifest()));

  admin.post('/settings', async (req, res) => {
    try {
      const settings = await mediaStore.setOutroDuration(req.body?.outroDurationSeconds);
      // Az állapotgép a következő outrónál már ezt az értéket használja
      // (a controller függvényként kéri le, nem fix értékként).
      controller.emit('change', controller.snapshot(), null);
      res.json({ ok: true, settings });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.post('/:slot', upload.single('file'), async (req, res) => {
    const { slot } = req.params;
    if (!SLOTS.includes(slot)) {
      return res.status(404).json({ error: `Ismeretlen slot: ${slot}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Nem érkezett fájl (mező neve: "file").' });
    }

    // A validáció a fájl TARTALMÁT nézi, nem a kiterjesztést és nem a
    // kliens által küldött Content-Type-ot — lásd media/validate.js.
    const check = validateMedia(req.file, MAX_UPLOAD_BYTES);
    if (!check.ok) {
      logger.warn(`Elutasított feltöltés (${slot}): ${check.error}`);
      return res.status(415).json({ error: check.error, allowed: ALLOWED_MIME_TYPES });
    }

    try {
      const entry = await mediaStore.setSlot(slot, {
        buffer: req.file.buffer,
        mime: check.mime,
        kind: check.kind,
        ext: check.ext,
        originalName: req.file.originalname,
      });
      broadcastMedia();
      res.json({ ok: true, slot, media: entry });
    } catch (error) {
      logger.error(`Feltöltés sikertelen (${slot}): ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  admin.patch('/:slot', async (req, res) => {
    try {
      const entry = await mediaStore.setSlotOptions(req.params.slot, req.body ?? {});
      broadcastMedia();
      res.json({ ok: true, media: entry });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.delete('/:slot', async (req, res) => {
    try {
      await mediaStore.clearSlot(req.params.slot);
      broadcastMedia();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.use('/api/admin/media', admin);

  // =========================================================================
  //  Nyilvános: manifest és fájlkiszolgálás
  // =========================================================================

  router.get('/api/media', guard, (req, res) => res.json(mediaStore.manifest()));

  /**
   * A médiafájl kiszolgálása.
   *
   * Range-kérést is kezel, mert a böngészők (és az OBS beépített CEF-je)
   * videónál részleges letöltéssel indulnak — Range támogatás nélkül egyes
   * lejátszók el sem indítják az mp4-et.
   */
  router.get('/media/:slot', guard, async (req, res) => {
    const { slot } = req.params;
    if (!SLOTS.includes(slot)) return res.status(404).end();

    const entry = mediaStore.slot(slot);
    const filePath = mediaStore.filePath(slot);
    if (!entry || !filePath) return res.status(404).json({ error: 'Nincs feltöltött média.' });

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return res.status(404).json({ error: 'A médiafájl hiányzik a lemezről.' });
    }

    res.setHeader('Content-Type', entry.mime);
    res.setHeader('ETag', `"${entry.version}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    // A tartalom-hash az URL-ben van (?v=), a slot URL viszont állandó —
    // ezért újravalidálást kérünk, de a bájtokat nem töltjük le újra.
    res.setHeader('Cache-Control', 'no-cache');

    if (req.headers['if-none-match'] === `"${entry.version}"`) {
      return res.status(304).end();
    }

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number.parseInt(match[1], 10) : 0;
        const end = match[2] ? Number.parseInt(match[2], 10) : info.size - 1;

        if (Number.isNaN(start) || start >= info.size || end >= info.size || start > end) {
          res.setHeader('Content-Range', `bytes */${info.size}`);
          return res.status(416).end();
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        res.setHeader('Content-Length', end - start + 1);
        return createReadStream(filePath, { start, end }).pipe(res);
      }
    }

    res.setHeader('Content-Length', info.size);
    return createReadStream(filePath).pipe(res);
  });

  /**
   * Médiaváltozás után a `/live` oldalnak és az adminnak is friss manifest kell,
   * különben a már megnyitott OBS Browser Source a régi fájlt mutatná.
   */
  function broadcastMedia() {
    controller.emit('media', mediaStore.manifest());
  }

  return router;
}
