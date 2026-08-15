/**
 * Hitelesítési middleware-ek (10. szegmens).
 *
 * Három, egymástól elkülönített jogosultsági szint — pontosan a subdomain-ek
 * felosztása szerint (docs/NETWORKING.md 2.):
 *
 * | Ki | Mivel | Mit tehet |
 * |---|---|---|
 * | admin | munkamenet-süti (belépés jelszóval) | mindent |
 * | telefon | streamkulcs (Bearer) | session-jelzés, telemetria |
 * | néző / OBS | lejátszási token (opcionális) | **csak megtekintés** |
 *
 * A lejátszási token szándékosan NEM ad vezérlési jogot: a `/live`, a média és
 * a lejátszás-proxy elérhető vele, de sem az admin API-hoz, sem a session
 * vezérléséhez nem nyúlhat. Ezt teszt is védi.
 */

import { constantTimeEquals, verifyPassword } from '../security/passwords.js';
import { clientKey } from '../security/rate-limit.js';
import { parseCookies } from '../security/sessions.js';

export const SESSION_COOKIE = 'onlive_session';
export const CSRF_HEADER = 'x-onlive-csrf';

const isLocal = (req) => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

const bearerToken = (req) => {
  const header = req.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

/** Állapotváltoztató kérés? Ezeknél kötelező a CSRF token. */
const isMutating = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

/**
 * A telefon: `Authorization: Bearer <streamKey>`.
 *
 * Sebességkorlátozott: a `/api/session/*` a publikus admin subdomainen is
 * elérhető, tehát a streamkulcs is próbálgatható lenne.
 */
export function phoneAuth(config, logger, limiter) {
  return (req, res, next) => {
    if (!config.streamKey) {
      logger.warn('Nincs beállítva ONLIVE_STREAM_KEY — a session API védtelen!');
      return next();
    }

    const key = clientKey(req);
    const state = limiter?.check(key);
    if (state && !state.allowed) {
      res.setHeader('Retry-After', Math.ceil(state.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Túl sok sikertelen próbálkozás.' });
    }

    if (constantTimeEquals(bearerToken(req) ?? '', config.streamKey)) {
      limiter?.succeed(key);
      return next();
    }

    limiter?.fail(key);
    logger.warn(`Elutasított session-kérés (${req.path}) innen: ${key}`);
    return res.status(401).json({ error: 'Érvénytelen streamkulcs.' });
  };
}

/**
 * A MediaMTX hookjai: `X-OnLIVE-Hook-Secret`.
 * A hívás localhostról jön, de a titok akkor is kell.
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
    if (constantTimeEquals(req.get('x-onlive-hook-secret') ?? '', config.hookSecret)) return next();
    return res.status(401).json({ error: 'Érvénytelen hook titok.' });
  };
}

/**
 * Az admin felület és API.
 *
 * Elfogadott bizonyítékok, ebben a sorrendben:
 *  1. **munkamenet-süti** (a web UI ezt használja) — állapotváltoztató
 *     kérésnél CSRF tokennel együtt,
 *  2. **`X-OnLIVE-Admin-Password` fejléc vagy Bearer** — szkriptekhez,
 *     `curl`-höz; kikapcsolható (`ONLIVE_ALLOW_HEADER_AUTH=false`).
 *
 * Ha nincs jelszó beállítva, kizárólag localhostról enged — így egy
 * félkonfigurált rendszer nem nyílik ki a publikus címen.
 */
export function adminAuth(config, logger, deps = {}) {
  const { sessions, limiter } = deps;

  return (req, res, next) => {
    // 1) Munkamenet-süti
    const cookies = parseCookies(req.get('cookie'));
    const session = sessions?.touch(cookies[SESSION_COOKIE]);

    if (session) {
      if (isMutating(req) && !sessions.verifyCsrf(session, req.get(CSRF_HEADER))) {
        logger.warn(`CSRF ellenőrzés bukott: ${req.method} ${req.path}`);
        return res.status(403).json({ error: 'Hiányzó vagy érvénytelen CSRF token.' });
      }
      req.adminSession = session;
      return next();
    }

    // 2) Fejléces hitelesítés (szkriptekhez)
    if (config.allowHeaderAuth !== false) {
      const supplied = req.get('x-onlive-admin-password') ?? bearerToken(req) ?? '';
      if (supplied) {
        const key = clientKey(req);
        const state = limiter?.check(key);
        if (state && !state.allowed) {
          res.setHeader('Retry-After', Math.ceil(state.retryAfterMs / 1000));
          return res.status(429).json({ error: 'Túl sok sikertelen próbálkozás.' });
        }

        if (verifyPassword(supplied, { hash: config.adminPasswordHash, plain: config.adminPassword })) {
          limiter?.succeed(key);
          return next();
        }
        limiter?.fail(key);
        return res.status(401).json({ error: 'Érvénytelen admin jelszó.' });
      }
    }

    // 3) Nincs jelszó beállítva → csak localhost
    if (!config.adminPassword && !config.adminPasswordHash) {
      if (isLocal(req)) {
        logger.warn('Nincs beállítva admin jelszó — az admin API csak localhostról érhető el.');
        return next();
      }
      return res.status(401).json({ error: 'Az admin jelszó nincs beállítva.' });
    }

    return res.status(401).json({ error: 'Bejelentkezés szükséges.', login: '/admin/login' });
  };
}

/**
 * A `/live` oldal és a lejátszás — **csak megtekintés**.
 *
 * Token nélkül nyilvános (az OBS-be így elég a puszta URL). Ha van token,
 * elfogadjuk a `?token=` paramétert, a `X-OnLIVE-Live-Token` fejlécet, vagy
 * egy érvényes admin munkamenetet (hogy az admin beágyazott előnézete külön
 * token nélkül is működjön).
 *
 * FIGYELEM: ez a middleware **sehol** nem véd vezérlő végpontot. A lejátszási
 * token birtokosa nem tud sessiont indítani, leállítani, médiát feltölteni
 * vagy widgetet mozgatni.
 */
export function liveAuth(config, deps = {}) {
  const { sessions } = deps;

  return (req, res, next) => {
    if (!config.liveToken) return next();

    const supplied = String(req.query.token ?? req.get('x-onlive-live-token') ?? '');
    if (constantTimeEquals(supplied, config.liveToken)) return next();

    const cookies = parseCookies(req.get('cookie'));
    if (sessions?.touch(cookies[SESSION_COOKIE])) return next();

    const adminHeader = req.get('x-onlive-admin-password') ?? '';
    if (
      config.allowHeaderAuth !== false && adminHeader &&
      verifyPassword(adminHeader, { hash: config.adminPasswordHash, plain: config.adminPassword })
    ) {
      return next();
    }

    return res.status(401).json({ error: 'Érvénytelen vagy hiányzó lejátszási token.' });
  };
}

/** Socket.io handshake — ugyanaz a szabály, nem express-middleware. */
export function isLiveTokenValid(config, token) {
  if (!config.liveToken) return true;
  return constantTimeEquals(String(token ?? ''), config.liveToken);
}

/** Socket.io: admin szerephez admin munkamenet vagy token kell. */
export function isAdminSocket(config, handshake, sessions) {
  const cookies = parseCookies(handshake.headers?.cookie);
  if (sessions?.touch(cookies[SESSION_COOKIE])) return true;

  const supplied = String(handshake.query?.adminPassword ?? '');
  if (!supplied) return false;
  return verifyPassword(supplied, { hash: config.adminPasswordHash, plain: config.adminPassword });
}
