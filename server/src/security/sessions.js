/**
 * Admin munkamenetek (10. szegmens).
 *
 * A 8. szegmensig az admin jelszó minden kérésben elment egy fejlécben, és a
 * böngésző `localStorage`-ában várakozott. Ez most lecserélődik rendes
 * munkamenetre:
 *
 *  - a jelszó **egyszer** utazik, a bejelentkezéskor,
 *  - utána egy véletlen munkamenet-token dolgozik, **HttpOnly** sütiben,
 *    amit a JavaScript nem tud kiolvasni (így egy XSS sem viszi el),
 *  - a munkamenet lejár, és minden használatnál csúszik előre.
 *
 * A tár szándékosan memóriában van: a szerver újraindítása után újra be kell
 * jelentkezni. Egy egygépes, egyfelhasználós rendszernél ez helyes
 * alapértelmezés — nincs mit perzisztálni, és nincs mit ellopni a lemezről.
 */

import { randomBytes } from 'node:crypto';
import { constantTimeEquals } from './passwords.js';

const DEFAULTS = {
  /** Meddig él egy munkamenet utolsó használat után. */
  ttlMs: 12 * 60 * 60 * 1000,
  /** Egyszerre ennyi bejelentkezés élhet (több eszköz, több fül). */
  maxSessions: 20,
};

export class SessionStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    this.now = options.now ?? (() => Date.now());
    this.sessions = new Map();
  }

  /**
   * Új munkamenet.
   *
   * A CSRF token szándékosan NEM a sütiben van: a süti automatikusan megy
   * minden kéréssel (ez az ereje és a gyengéje is), ezért a kérésnek egy
   * olyan értéket is vinnie kell, amit csak a mi oldalunk JavaScriptje ismer.
   * Egy idegen oldalról indított kérés a sütit viszi, a CSRF tokent nem.
   */
  create({ userAgent, ip } = {}) {
    this.#prune();

    if (this.sessions.size >= this.maxSessions) {
      // A legrégebbi kiesik — a friss bejelentkezést sosem utasítjuk el.
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }

    const token = randomBytes(32).toString('base64url');
    const session = {
      token,
      csrf: randomBytes(24).toString('base64url'),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      userAgent: String(userAgent ?? '').slice(0, 120),
      ip: String(ip ?? ''),
    };
    this.sessions.set(token, session);
    return session;
  }

  /** Érvényes-e a token; ha igen, a lejárat csúszik előre. */
  touch(token) {
    if (!token) return null;
    this.#prune();

    const session = this.sessions.get(token);
    if (!session) return null;

    session.lastSeenAt = this.now();
    return session;
  }

  /** CSRF ellenőrzés — állapotváltoztató kéréseknél kötelező. */
  verifyCsrf(session, suppliedToken) {
    return Boolean(session) && constantTimeEquals(String(suppliedToken ?? ''), session.csrf);
  }

  destroy(token) {
    return this.sessions.delete(token);
  }

  destroyAll() {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  get size() {
    this.#prune();
    return this.sessions.size;
  }

  list() {
    this.#prune();
    return [...this.sessions.values()].map((session) => ({
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      userAgent: session.userAgent,
      ip: session.ip,
    }));
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, session] of this.sessions) {
      if (session.lastSeenAt < cutoff) this.sessions.delete(token);
    }
  }
}

/** Süti-fejléc értelmezése (nincs szükség külön csomagra). */
export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;

  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

/**
 * Süti-sor összeállítása.
 *
 * `HttpOnly`: a JavaScript nem olvashatja.
 * `SameSite=Strict`: idegen oldalról indított kérésekkel nem megy el.
 * `Secure`: csak HTTPS-en — a Cloudflare Tunnel mögött a `X-Forwarded-Proto`
 * alapján derül ki, hogy a kliens felé HTTPS volt-e a kapcsolat.
 */
export function buildCookie(name, value, { maxAgeMs, secure, clear = false } = {}) {
  const parts = [
    `${name}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${Math.floor((maxAgeMs ?? 0) / 1000)}`);
  return parts.join('; ');
}
