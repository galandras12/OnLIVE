/**
 * Sebességkorlátozás (10. szegmens).
 *
 * Az admin felület és az ingest a Cloudflare Tunnelen keresztül **publikusan
 * elérhető címen** van. Egy jelszó vagy streamkulcs önmagában nem elég, ha
 * korlátlanul lehet próbálkozni: egy egyszerű szótáras támadás percek alatt
 * lefut. Ezért a sikertelen próbálkozásokat IP-nként számoljuk, és a
 * küszöb felett egyre hosszabb zárlat jön.
 *
 * A sikeres belépés nullázza a számlálót — a saját elgépeléseid nem
 * halmozódnak fel.
 */

const DEFAULTS = {
  /** Ennyi sikertelen próbálkozás után jön az első zárlat. */
  threshold: 5,
  /** Ennyi idő után elfelejtjük a korábbi hibákat. */
  windowMs: 15 * 60 * 1000,
  /** Az első zárlat hossza; a következők duplázódnak. */
  baseLockMs: 30 * 1000,
  maxLockMs: 15 * 60 * 1000,
};

export class RateLimiter {
  constructor(options = {}) {
    this.threshold = options.threshold ?? DEFAULTS.threshold;
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.baseLockMs = options.baseLockMs ?? DEFAULTS.baseLockMs;
    this.maxLockMs = options.maxLockMs ?? DEFAULTS.maxLockMs;
    this.now = options.now ?? (() => Date.now());
    this.entries = new Map();
  }

  /**
   * Szabad-e próbálkozni?
   * @returns {{allowed: boolean, retryAfterMs: number, failures: number}}
   */
  check(key) {
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true, retryAfterMs: 0, failures: 0 };

    const now = this.now();

    if (entry.lockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.lockedUntil - now, failures: entry.failures };
    }
    if (now - entry.lastFailureAt > this.windowMs) {
      this.entries.delete(key);
      return { allowed: true, retryAfterMs: 0, failures: 0 };
    }
    return { allowed: true, retryAfterMs: 0, failures: entry.failures };
  }

  /** Sikertelen próbálkozás rögzítése. */
  fail(key) {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0, locks: 0 };

    if (now - entry.lastFailureAt > this.windowMs) entry.failures = 0;

    entry.failures += 1;
    entry.lastFailureAt = now;

    if (entry.failures >= this.threshold) {
      entry.locks += 1;
      const lock = Math.min(this.maxLockMs, this.baseLockMs * 2 ** (entry.locks - 1));
      entry.lockedUntil = now + lock;
      entry.failures = 0; // a zárlat után tiszta lappal, de hosszabb büntetéssel
    }

    this.entries.set(key, entry);
    return this.check(key);
  }

  /** Sikeres belépés — a korábbi hibák törlődnek. */
  succeed(key) {
    this.entries.delete(key);
  }

  /** Takarítás: a rég nem látott bejegyzések eldobása. */
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil < now && now - entry.lastFailureAt > this.windowMs) {
        this.entries.delete(key);
      }
    }
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * A kérés kulcsa a korlátozáshoz.
 *
 * A Cloudflare Tunnel mögött az `X-Forwarded-For` hordozza a valódi kliens
 * IP-t; az express `trust proxy` beállítása miatt ezt a `req.ip` már
 * feloldva adja.
 */
export function clientKey(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'ismeretlen';
}
