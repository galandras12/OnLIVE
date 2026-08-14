/**
 * Az ingest réteg vezérlése (5. szegmens).
 *
 * Eddig csak FIGYELTÜK a MediaMTX-et; az `ended` állapothoz viszont be is kell
 * tudni avatkozni: a session lezárásakor a telefon publisher-kapcsolatát
 * aktívan bontani kell.
 *
 * Miért nem elég megvárni, hogy a telefon magától lecsatlakozzon: ha az app
 * ottragad (elakadt gomb, hálózati féllábon állás), az adás a szerver szerint
 * már véget ért, a MediaMTX viszont még fogadná a képet — és a következő
 * session azonnal `live`-ba ugrana egy régi stream miatt.
 *
 * FONTOS: itt a *session* zárul le, nem a folyamat. Sem a MediaMTX, sem a
 * vezérlő szerver nem áll le — mindkettő készen áll a következő adásra.
 */

export class IngestControl {
  constructor({ config, logger }) {
    this.apiBase = config.ingest.apiBase.replace(/\/+$/, '');
    this.path = config.ingest.path;
    this.logger = logger;
  }

  /**
   * A jelenlegi publisher lekapcsolása.
   *
   * A MediaMTX API-ja munkamenet-típusonként külön kick végpontot ad, ezért
   * előbb ki kell deríteni, milyen típusú a forrás (WHIP esetén
   * `webRTCSession`), és mi az azonosítója.
   *
   * @returns {Promise<{closed: boolean, reason?: string}>}
   */
  async closePublisher() {
    const source = await this.#currentSource();
    if (!source) return { closed: false, reason: 'nincs aktív publisher' };

    const endpoint = KICK_ENDPOINTS[source.type];
    if (!endpoint) {
      return { closed: false, reason: `ismeretlen forrás-típus: ${source.type}` };
    }

    try {
      const response = await fetch(`${this.apiBase}/v3/${endpoint}/kick/${source.id}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { closed: false, reason: `HTTP ${response.status}` };
      }
      this.logger.ok(`A publisher lekapcsolva (${source.type} ${source.id}).`);
      return { closed: true };
    } catch (error) {
      this.logger.warn(`A publisher lekapcsolása sikertelen: ${error.message}`);
      return { closed: false, reason: error.message };
    }
  }

  async #currentSource() {
    try {
      const response = await fetch(
        `${this.apiBase}/v3/paths/get/${encodeURIComponent(this.path)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) return null;
      const body = await response.json();
      return body.ready && body.source?.id ? body.source : null;
    } catch (error) {
      this.logger.warn(`A publisher lekérdezése sikertelen: ${error.message}`);
      return null;
    }
  }
}

/** MediaMTX kick végpontok forrás-típusonként. */
const KICK_ENDPOINTS = Object.freeze({
  webRTCSession: 'webrtcsessions',
  rtmpConn: 'rtmpconns',
  rtspSession: 'rtspsessions',
  srtConn: 'srtconns',
});
