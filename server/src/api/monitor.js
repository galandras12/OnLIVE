/**
 * Monitor, napló és linkek végpontjai (9. szegmens).
 *
 *  - `/api/admin/report`      — időszakok + grafikon-adatok (JSON)
 *  - `/api/admin/report.csv`  — letölthető napló
 *  - `/api/admin/sessions`    — session-lista a szűrőhöz
 *  - `/api/admin/links`       — chat-linkek szerkesztése
 *  - `/api/links`             — a nyilvános `/links` oldal listája
 */

import { Router } from 'express';
import { buildPeriods, summarize, toChartSeries, toCsv } from '../log/report.js';
import { LogEvent, Source, clientId, describeChanges, diffSettings } from '../log/logger.js';

export function createMonitorRoutes({ config, store, metrics, links, logger, adminGuard }) {
  const router = Router();

  const admin = Router();
  admin.use(adminGuard);

  /** A szűrők értelmezése: `from`/`to` ISO dátum vagy ezredmásodperc. */
  function parseRange(query) {
    const parse = (value) => {
      if (!value) return null;
      const asNumber = Number(value);
      const ms = Number.isFinite(asNumber) && String(value).length > 8
        ? asNumber
        : Date.parse(value);
      return Number.isFinite(ms) ? ms : null;
    };
    return {
      from: parse(query.from),
      to: parse(query.to),
      sessionId: query.session || undefined,
    };
  }

  async function collect(query) {
    const range = parseRange(query);
    const [transitions, samples] = await Promise.all([
      store.recentTransitions(20_000),
      metrics.read(range),
    ]);
    const periods = buildPeriods(transitions, samples, range);
    return { range, samples, periods };
  }

  admin.get('/report', async (req, res) => {
    try {
      const { periods, samples } = await collect(req.query);
      res.json({
        periods,
        sessions: summarize(periods),
        chart: toChartSeries(samples, periods),
      });
    } catch (error) {
      logger.warn(`A jelentés összeállítása sikertelen: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Letölthető napló.
   *
   * A böngésző `Content-Disposition` alapján tölti le. A fájlnév tartalmazza
   * a szűrőt, hogy több letöltés után is tudni lehessen, melyik micsoda.
   */
  admin.get('/report.csv', async (req, res) => {
    try {
      const { periods } = await collect(req.query);
      const separator = req.query.sep === 'comma' ? 'comma' : 'semicolon';

      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
      const scope = req.query.session ? `-${String(req.query.session).slice(0, 24)}` : '';
      const fileName = `onlive-naplo${scope}-${stamp}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.send(toCsv(periods, { separator }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  admin.get('/sessions', async (req, res) => {
    try {
      const transitions = await store.recentTransitions(20_000);
      const samples = await metrics.read({});
      res.json(summarize(buildPeriods(transitions, samples)));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // -------------------------------------------------------------------------
  //  Chat-linkek
  // -------------------------------------------------------------------------

  admin.get('/links', (req, res) => res.json({ links: links.list() }));

  admin.post('/links', async (req, res) => {
    try {
      const link = await links.create(req.body ?? {});
      logLinkChange(req, `Chat-link hozzáadva: ${link.name}`, {
        nev: { regi: null, uj: link.name }, url: { regi: null, uj: link.url },
      });
      res.json({ ok: true, link });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.patch('/links/:id', async (req, res) => {
    try {
      const before = links.list().find((item) => item.id === req.params.id);
      const link = await links.update(req.params.id, req.body ?? {});
      const changes = diffSettings(before, link, ['name', 'url', 'public']);
      if (changes) logLinkChange(req, `Chat-link módosítva: ${link.name}`, changes);
      res.json({ ok: true, link });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.delete('/links/:id', async (req, res) => {
    try {
      const removed = await links.remove(req.params.id);
      logLinkChange(req, `Chat-link törölve: ${removed.name}`, {
        nev: { regi: removed.name, uj: null },
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  function logLinkChange(req, message, changes) {
    logger.event({
      type: LogEvent.SETTINGS,
      source: Source.WEB,
      client: clientId(req),
      message: `${message} — ${describeChanges(changes)}`,
      area: 'links',
      changes,
    });
  }

  router.use('/api/admin', admin);

  /** A nyilvános link-oldal listája — csak a publikusra jelölt elemek. */
  router.get('/api/links', (req, res) => res.json({ links: links.list({ onlyPublic: true }) }));

  return router;
}
