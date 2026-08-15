/**
 * Bejelentkezés, kijelentkezés, biztonsági állapot (10. szegmens).
 *
 *  - `POST /api/auth/login`   — jelszó → munkamenet-süti + CSRF token
 *  - `POST /api/auth/logout`  — munkamenet megszüntetése
 *  - `GET  /api/auth/me`      — be vagyok-e jelentkezve (és a CSRF token)
 *  - `GET  /api/admin/security` — biztonsági helyzetkép az admin felületnek
 */

import { Router } from 'express';
import { assessSecret, verifyPassword } from '../security/passwords.js';
import { clientKey } from '../security/rate-limit.js';
import { buildCookie, parseCookies } from '../security/sessions.js';
import { CSRF_HEADER, SESSION_COOKIE } from './auth.js';

export function createAuthRoutes({ config, sessions, limiter, adminGuard, logger }) {
  const router = Router();

  /** A süti csak HTTPS-en menjen — a tunnel mögött az X-Forwarded-Proto dönt. */
  const isSecure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

  router.post('/api/auth/login', (req, res) => {
    const key = clientKey(req);
    const state = limiter.check(key);

    if (!state.allowed) {
      const seconds = Math.ceil(state.retryAfterMs / 1000);
      res.setHeader('Retry-After', seconds);
      logger.warn(`Zárolt bejelentkezési kísérlet innen: ${key} (még ${seconds} mp)`);
      return res.status(429).json({
        error: `Túl sok sikertelen próbálkozás. Próbáld újra ${seconds} másodperc múlva.`,
        retryAfterSeconds: seconds,
      });
    }

    const password = String(req.body?.password ?? '');
    const ok = verifyPassword(password, {
      hash: config.adminPasswordHash,
      plain: config.adminPassword,
    });

    if (!ok) {
      const after = limiter.fail(key);
      logger.warn(`Sikertelen bejelentkezés innen: ${key}`);
      return res.status(401).json({
        error: 'Hibás jelszó.',
        remainingAttempts: Math.max(0, limiter.threshold - after.failures),
      });
    }

    limiter.succeed(key);
    const session = sessions.create({ userAgent: req.get('user-agent'), ip: key });

    res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, session.token, {
      maxAgeMs: sessions.ttlMs,
      secure: isSecure(req),
    }));

    logger.ok(`Admin bejelentkezés innen: ${key}`);
    // A CSRF token szándékosan a TÖRZSBEN megy, nem sütiben: a sütit a
    // böngésző automatikusan küldi, ezt viszont csak a mi oldalunk tudja.
    res.json({ ok: true, csrfToken: session.csrf, expiresInMs: sessions.ttlMs });
  });

  router.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookies(req.get('cookie'));
    const token = cookies[SESSION_COOKIE];
    if (token) sessions.destroy(token);

    res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, '', { clear: true, secure: isSecure(req) }));
    res.json({ ok: true });
  });

  router.get('/api/auth/me', (req, res) => {
    const cookies = parseCookies(req.get('cookie'));
    const session = sessions.touch(cookies[SESSION_COOKIE]);

    if (!session) {
      return res.json({
        authenticated: false,
        // Ha nincs jelszó beállítva, a localhostos fejlesztés ne akadjon el.
        passwordConfigured: Boolean(config.adminPassword || config.adminPasswordHash),
      });
    }
    res.json({
      authenticated: true,
      csrfToken: session.csrf,
      createdAt: session.createdAt,
      passwordConfigured: true,
    });
  });

  // -------------------------------------------------------------------------
  //  Biztonsági helyzetkép
  // -------------------------------------------------------------------------

  const admin = Router();
  admin.use(adminGuard);

  /**
   * Mit véd mi — egy helyen, az admin felületnek.
   *
   * Titkot sosem ad vissza, csak azt, hogy be van-e állítva és mennyire erős.
   */
  admin.get('/security', (req, res) => {
    res.json({
      admin: {
        passwordConfigured: Boolean(config.adminPassword || config.adminPasswordHash),
        hashed: Boolean(config.adminPasswordHash),
        headerAuthAllowed: config.allowHeaderAuth !== false,
        activeSessions: sessions.size,
        assessment: config.adminPasswordHash
          ? { level: 'strong', message: 'Admin jelszó: hash-elve tárolva.' }
          : assessSecret(config.adminPassword, { name: 'Admin jelszó', minLength: 12 }),
      },
      ingest: {
        streamKeyConfigured: Boolean(config.streamKey),
        assessment: assessSecret(config.streamKey, { name: 'Streamkulcs', minLength: 20 }),
      },
      live: {
        tokenConfigured: Boolean(config.liveToken),
        assessment: config.liveToken
          ? assessSecret(config.liveToken, { name: 'Lejátszási token', minLength: 16 })
          : { level: 'open', message: 'A /live nyilvános (nincs token).' },
      },
      hooks: {
        secretConfigured: Boolean(config.hookSecret),
        assessment: assessSecret(config.hookSecret, { name: 'Hook titok', minLength: 16 }),
      },
      rateLimit: {
        threshold: limiter.threshold,
        trackedClients: limiter.size,
      },
    });
  });

  /** Minden munkamenet kiléptetése — ha elveszett egy eszköz. */
  admin.post('/security/logout-all', (req, res) => {
    const count = sessions.destroyAll();
    logger.warn(`Minden admin munkamenet megszüntetve (${count} db).`);
    res.json({ ok: true, destroyed: count });
  });

  router.use('/api/admin', admin);

  return router;
}

export { CSRF_HEADER, SESSION_COOKIE };
