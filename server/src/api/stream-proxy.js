/**
 * Lejátszás-proxy: WHEP és HLS (6. szegmens).
 *
 * MIÉRT PROXY, és miért nem közvetlenül a MediaMTX:
 * a `live.galandras.com` a cloudflared konfigurációban a Node szerverre mutat,
 * és a cloudflared NEM ír át útvonalat (docs/NETWORKING.md), ezért nem lehet
 * egy al-útvonalat a MediaMTX-re irányítani. A proxyval viszont:
 *
 *  - egyetlen origin van (nincs CORS-tánc a böngészőben és az OBS-ben),
 *  - a hozzáférés egy helyen szabályozható (token, később 10. szegmens),
 *  - a MediaMTX olvasási joga localhostra szorítva maradhat.
 *
 * A szerződést a 3. szegmens rögzítette (docs/INGEST.md 4.1) — ez a
 * megvalósítása.
 */

import { Router } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * WHEP munkamenetek: saját azonosító → MediaMTX erőforrás-URL.
 *
 * Miért kell: a MediaMTX a `Location` fejlécben a SAJÁT belső URL-jét adja
 * vissza. Ha ezt változatlanul továbbadnánk a böngészőnek, a lejátszó egy
 * kifelé nem létező címre próbálna DELETE-et küldeni, és a munkamenetek
 * ottragadnának a MediaMTX-ben (az OBS gyakran újraindítja a forrást —
 * néhány óra alatt tucatnyi halott olvasó gyűlne össze).
 */
class WhepSessions {
  constructor(maxAgeMs = 12 * 60 * 60 * 1000) {
    this.map = new Map();
    this.maxAgeMs = maxAgeMs;
  }

  add(resourceUrl) {
    const id = randomUUID();
    this.map.set(id, { resourceUrl, createdAt: Date.now() });
    this.#prune();
    return id;
  }

  take(id) {
    const entry = this.map.get(id);
    if (entry) this.map.delete(id);
    return entry?.resourceUrl ?? null;
  }

  #prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, entry] of this.map) {
      if (entry.createdAt < cutoff) this.map.delete(id);
    }
  }
}

export function createStreamProxyRoutes({ config, logger, liveAuth }) {
  const router = Router();
  const sessions = new WhepSessions();

  const whepBase = config.ingest.apiBase.replace(/:\d+$/, `:${config.ingest.whepPort}`);
  const hlsBase = config.ingest.apiBase.replace(/:\d+$/, `:${config.ingest.hlsPort}`);

  // =========================================================================
  //  WHEP — alacsony látenciájú WebRTC lejátszás (~0,2–0,5 s)
  // =========================================================================

  /**
   * SDP offer továbbítása. A böngésző `application/sdp` törzset küld,
   * és ugyanazt kapja vissza válaszként.
   */
  router.post('/api/whep/:path', liveAuth, async (req, res) => {
    const path = encodeURIComponent(req.params.path);
    const target = `${whepBase}/${path}/whep`;

    try {
      const offer = await readBody(req);
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer,
        signal: AbortSignal.timeout(10_000),
      });

      const answer = await upstream.text();

      if (!upstream.ok) {
        logger.warn(`WHEP proxy hiba: HTTP ${upstream.status} (${target})`);
        return res.status(upstream.status).type('text/plain').send(answer);
      }

      const location = upstream.headers.get('location');
      if (location) {
        const absolute = new URL(location, target).toString();
        // Saját azonosítót adunk vissza, a belső URL-t nem szivárogtatjuk ki.
        res.setHeader('Location', `/api/whep/session/${sessions.add(absolute)}`);
      }

      res.status(201).type('application/sdp').send(answer);
    } catch (error) {
      logger.warn(`WHEP proxy kivétel: ${error.message}`);
      res.status(502).json({ error: 'Az ingest réteg nem érhető el.' });
    }
  });

  /** A lejátszó lezárása (a böngésző `beforeunload`-nál küldi). */
  router.delete('/api/whep/session/:id', liveAuth, async (req, res) => {
    const resourceUrl = sessions.take(req.params.id);
    if (!resourceUrl) return res.status(404).end();

    try {
      await fetch(resourceUrl, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    } catch (error) {
      logger.info(`WHEP session lezárása nem sikerült: ${error.message}`);
    }
    res.status(204).end();
  });

  // =========================================================================
  //  HLS — tartalék útvonal (~2–6 s késleltetés)
  // =========================================================================

  /**
   * Playlist és szegmensek továbbítása.
   *
   * A MediaMTX relatív URL-eket ír a playlistbe, ezért a prefix-alapú
   * proxyzás önmagában helyesen feloldódik a böngészőben — nem kell a
   * playlist tartalmát átírni.
   */
  router.get('/api/hls/*', liveAuth, async (req, res) => {
    const suffix = req.params[0] ?? '';
    const target = `${hlsBase}/${suffix}`;

    try {
      const upstream = await fetch(target, { signal: AbortSignal.timeout(10_000) });
      if (!upstream.ok) return res.status(upstream.status).end();

      const type = upstream.headers.get('content-type');
      if (type) res.setHeader('Content-Type', type);
      // A playlist másodpercenként változik, a szegmensek viszont állandóak.
      res.setHeader(
        'Cache-Control',
        suffix.endsWith('.m3u8') ? 'no-store' : 'public, max-age=60',
      );

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      logger.info(`HLS proxy hiba: ${error.message}`);
      res.status(502).end();
    }
  });

  return router;
}

/** A nyers kérés-törzs beolvasása (az express.json ezt a típust nem kezeli). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) reject(new Error('Túl nagy SDP.'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
