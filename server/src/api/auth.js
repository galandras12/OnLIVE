/**
 * Hitelesítési middleware-ek.
 *
 * FIGYELEM: ez a réteg a 4. szegmenshez szükséges MINIMUM. A teljes
 * jogosultsági rendszer (admin munkamenet, sütik, rate limit, Cloudflare
 * Access) a **10. szegmens** feladata. Ami itt van, az szándékosan egyszerű,
 * de nem hagy nyitva ajtót: minden végpontnak van őre.
 */

const isLocal = (req) => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

const bearerToken = (req) => {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** Időzítés-független összehasonlítás. */
const equals = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * A telefon: `Authorization: Bearer <streamKey>`.
 * (Az ingest felé ugyanez a kulcs HTTP Basic-ként megy — más rendszer,
 * más konvenció; lásd docs/INGEST.md 2. fejezet.)
 */
export function phoneAuth(config, logger) {
  return (req, res, next) => {
    if (!config.streamKey) {
      logger.warn('Nincs beállítva ONLIVE_STREAM_KEY — a session API védtelen!');
      return next();
    }
    if (equals(bearerToken(req) ?? '', config.streamKey)) return next();
    return res.status(401).json({ error: 'Érvénytelen streamkulcs.' });
  };
}

/**
 * A MediaMTX hookjai: `X-OnLIVE-Hook-Secret`.
 * A hívás localhostról jön, de a titok akkor is kell — enélkül bárki, aki
 * eléri a portot, hamis ingest-eseményt küldhetne.
 */
export function hookAuth(config, logger) {
  return (req, res, next) => {
    if (!config.hookSecret) {
      if (isLocal(req)) {
        logger.warn('Nincs beállítva ONLIVE_HOOK_SECRET — csak localhost hívhat.');
        return next();
      }
      return res.status(401).json({ error: 'A hook titok nincs beállítva.' });
    }
    if (equals(req.get('x-onlive-hook-secret') ?? '', config.hookSecret)) return next();
    return res.status(401).json({ error: 'Érvénytelen hook titok.' });
  };
}

/**
 * Az admin felület. Ideiglenes megoldás a 10. szegmensig: jelszó fejlécben
 * vagy Bearerként. Ha nincs jelszó beállítva, kizárólag localhostról enged.
 */
export function adminAuth(config, logger) {
  return (req, res, next) => {
    if (!config.adminPassword) {
      if (isLocal(req)) {
        logger.warn('Nincs beállítva ONLIVE_ADMIN_PASSWORD — csak localhost vezérelhet.');
        return next();
      }
      return res.status(401).json({ error: 'Az admin jelszó nincs beállítva.' });
    }
    const supplied = req.get('x-onlive-admin-password') ?? bearerToken(req) ?? '';
    if (equals(supplied, config.adminPassword)) return next();
    return res.status(401).json({ error: 'Érvénytelen admin jelszó.' });
  };
}
