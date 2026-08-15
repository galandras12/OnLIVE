/**
 * Overlay/widget végpontok (6–7. szegmens).
 *
 *  - `GET  /api/overlay`               — elrendezés a `/live` oldalnak
 *  - `GET  /overlay/asset/:id`         — feltöltött logó képe
 *  - `GET  /embed/:id?k=…`             — a beágyazott third-party tartalom,
 *                                        saját dokumentumban (sandbox!)
 *  - `/api/admin/overlay/*`            — szerkesztés (admin jelszó)
 *
 * Minden módosítás után azonnal megy az `onlive:overlay` socket esemény, így a
 * `/live` oldal és az OBS Browser Source **újratöltés nélkül** követi a
 * mozgatást, átméretezést és a ki/be kapcsolást.
 */

import { Router } from 'express';
import multer from 'multer';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { validateMedia, MediaKind } from '../media/validate.js';
import { LogEvent, Source, clientId, describeChanges, diffSettings } from '../log/logger.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_EMBED_CHARS = 64 * 1024;

export function createOverlayRoutes({ config, overlayStore, controller, logger, liveAuth, adminGuard }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

  const broadcast = () => controller.emit('overlay', overlayStore.manifest());

  // =========================================================================
  //  Nyilvános (vagy tokenes): amit a `/live` oldal használ
  // =========================================================================

  router.get('/api/overlay', liveAuth, (req, res) => res.json(overlayStore.manifest()));

  router.get('/overlay/asset/:id', liveAuth, async (req, res) => {
    const widget = overlayStore.find(req.params.id);
    const filePath = overlayStore.assetPath(req.params.id);
    if (!widget || !filePath) return res.status(404).end();

    try {
      const info = await stat(filePath);
      res.setHeader('Content-Type', widget.data.mime ?? 'application/octet-stream');
      res.setHeader('Content-Length', info.size);
      res.setHeader('ETag', `"${widget.data.version}"`);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === `"${widget.data.version}"`) return res.status(304).end();
      return createReadStream(filePath).pipe(res);
    } catch {
      return res.status(404).end();
    }
  });

  /**
   * A beágyazott third-party tartalom SAJÁT dokumentumban.
   *
   * BIZTONSÁG — ez a szegmens legfontosabb pontja:
   *
   *  1. A `/live` oldal ezt `sandbox="allow-scripts"` iframe-ben tölti be,
   *     `allow-same-origin` NÉLKÜL. Így az iframe **átlátszatlan (opaque)
   *     origint** kap: nem éri el a szülő DOM-ját, a `localStorage`-ot, a
   *     sütiket, és nem tud a szülő nevében kérést indítani. A két jogosultság
   *     EGYÜTT (allow-scripts + allow-same-origin) kioltaná a sandboxot —
   *     ezért soha nem adjuk meg egyszerre.
   *
   *  2. A tartalom nem a fő oldal URL-jén érhető el, hanem widgetenkénti
   *     véletlen kulccsal (`?k=`). Így a beágyazott szkript a saját
   *     címsorából **nem tudja kiolvasni a lejátszási tokent** — csak a
   *     saját, korlátozott hatókörű kulcsát látja.
   *
   *  3. `frame-ancestors 'self'`: a beágyazó oldal csak a mi originünk lehet.
   *
   * Fenyegetettségi modell: a HTML-t az üzemeltető adja meg, tehát nem
   * ismeretlen forrás — a védelem arra szól, hogy egy KOMPROMITTÁLT vagy
   * rosszindulatúan viselkedő third-party szkript (chat, értesítés) ne
   * férhessen hozzá az OnLIVE felülethez és a tokenekhez.
   */
  router.get('/embed/:id', (req, res) => {
    const content = overlayStore.embedContent(req.params.id, req.query.k);
    if (!content) return res.status(404).type('text/plain').send('Nincs ilyen beágyazás.');

    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(embedDocument(content.html));
  });

  // =========================================================================
  //  Admin: szerkesztés
  // =========================================================================

  const admin = Router();
  admin.use(adminGuard);

  admin.get('/', (req, res) => res.json(overlayStore.adminManifest()));

  admin.post('/', async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.type === 'embed' && (body.data?.html?.length ?? 0) > MAX_EMBED_CHARS) {
        return res.status(413).json({ error: 'A beágyazott kód túl hosszú.' });
      }
      const widget = await overlayStore.create(body);
      logger.event({
        type: LogEvent.SETTINGS,
        source: Source.WEB,
        client: clientId(req),
        message: `Widget létrehozva: ${widget.name} (${widget.type})`,
        area: 'widget',
        widgetId: widget.id,
        widgetType: widget.type,
      });
      broadcast();
      res.json({ ok: true, widget });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.patch('/:id', async (req, res) => {
    try {
      const patch = req.body ?? {};
      if ((patch.data?.html?.length ?? 0) > MAX_EMBED_CHARS) {
        return res.status(413).json({ error: 'A beágyazott kód túl hosszú.' });
      }
      const before = overlayStore.find(req.params.id);
      const widget = await overlayStore.update(req.params.id, patch);

      // Pozíció, méret, láthatóság, réteg — ezek a leggyakoribb változások,
      // és utólag pont ezekre kérdez rá az ember („mikor csúszott el a logó?").
      const changes = diffSettings(before, widget, [
        'x', 'y', 'width', 'height', 'visible', 'opacity', 'zIndex', 'locked', 'name', 'screens',
      ]);
      if (changes) {
        logger.event({
          type: LogEvent.SETTINGS,
          source: Source.WEB,
          client: clientId(req),
          message: `Widget módosítva (${widget.name}) — ${describeChanges(changes)}`,
          area: 'widget',
          widgetId: widget.id,
          changes,
        });
      }
      broadcast();
      res.json({ ok: true, widget });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  admin.delete('/:id', async (req, res) => {
    try {
      const before = overlayStore.find(req.params.id);
      await overlayStore.remove(req.params.id);
      logger.event({
        type: LogEvent.SETTINGS,
        source: Source.WEB,
        client: clientId(req),
        message: `Widget törölve: ${before?.name ?? req.params.id}`,
        area: 'widget',
        widgetId: req.params.id,
      });
      broadcast();
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  admin.put('/', async (req, res) => {
    try {
      const manifest = await overlayStore.replaceAll(req.body?.widgets ?? []);
      broadcast();
      res.json({ ok: true, ...manifest });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /** Logó kép feltöltése egy meglévő widgethez. */
  admin.post('/:id/image', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nem érkezett fájl (mező neve: "file").' });

    const check = validateMedia(req.file, MAX_IMAGE_BYTES);
    if (!check.ok) return res.status(415).json({ error: check.error });
    if (check.kind !== MediaKind.IMAGE) {
      return res.status(415).json({ error: 'Logóhoz csak kép tölthető fel (jpg, png, webp).' });
    }

    try {
      const before = overlayStore.find(req.params.id)?.data?.originalName;
      const widget = await overlayStore.setImage(req.params.id, {
        buffer: req.file.buffer,
        ext: check.ext,
        mime: check.mime,
        originalName: req.file.originalname,
      });

      logger.event({
        type: LogEvent.SETTINGS,
        level: 'ok',
        source: Source.WEB,
        client: clientId(req),
        message: `Widget kép csere (${widget.name}): ${before ?? 'nem volt'} → ${req.file.originalname}`,
        area: 'widget',
        widgetId: widget.id,
        changes: { kep: { regi: before ?? null, uj: req.file.originalname } },
      });
      broadcast();
      res.json({ ok: true, widget });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.use('/api/admin/overlay', admin);

  return router;
}

/**
 * A beágyazás gazdadokumentuma.
 *
 * Szándékosan minimális: átlátszó háttér, nincs görgetősáv, és semmilyen
 * OnLIVE-szkript nincs benne — a sandbox miatt úgysem érne el semmit, de
 * így az sem kerül a third-party kód kezébe, amit nem muszáj.
 */
function embedDocument(html) {
  return `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OnLIVE — beágyazás</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
  body > * { max-width: 100%; }
  iframe { border: 0; width: 100%; height: 100%; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}
