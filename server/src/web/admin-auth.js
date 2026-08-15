/**
 * Közös admin-kliens segéd (10. szegmens).
 *
 * A 8. szegmensig minden admin oldal a `localStorage`-ban tárolt jelszót
 * küldte minden kérésben. Ez lecserélődött munkamenetre:
 *
 *  - a munkamenet HttpOnly sütiben van, a JavaScript nem is látja,
 *  - a kliens csak a CSRF tokent tartja meg (sessionStorage), és minden
 *    állapotváltoztató kéréshez hozzáteszi,
 *  - 401 esetén automatikusan a bejelentkező oldalra megyünk.
 */

window.OnLiveAdmin = (() => {
  const csrf = {
    get: () => sessionStorage.getItem('onlive.csrf') ?? '',
    set: (value) => value && sessionStorage.setItem('onlive.csrf', value),
  };

  function toLogin() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace('/admin/login?next=' + next);
  }

  /** Belépve vagyunk-e; ha nem, átirányít. A CSRF tokent frissen hozza. */
  async function requireAuth() {
    try {
      const me = await (await fetch('/api/auth/me')).json();
      if (!me.authenticated) {
        // Jelszó nélküli (localhostos) fejlesztésnél nincs mit bejelentkezni.
        if (me.passwordConfigured) toLogin();
        return me;
      }
      csrf.set(me.csrfToken);
      return me;
    } catch {
      return { authenticated: false };
    }
  }

  /** `fetch` admin kéréshez: CSRF fejléc, süti, és 401 → bejelentkezés. */
  async function api(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (!(options.body instanceof FormData) && options.body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
    if (options.method && options.method !== 'GET') {
      headers['X-OnLIVE-CSRF'] = csrf.get();
    }

    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401) {
      toLogin();
      throw new Error('Bejelentkezés szükséges.');
    }
    return response;
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    sessionStorage.removeItem('onlive.csrf');
    toLogin();
  }

  return { api, requireAuth, logout, csrf };
})();
