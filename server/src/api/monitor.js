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
import { adminAuth } from './auth.js';

export function createMonitorRoutes({ config, store, metrics, links, logger }) {
  const router = Router();

  const admin = Router();
  admin.use(adminAuth(config, logger));

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
      res.json({ ok: true, link: await links.create(req.body ?? {}) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.patch('/links/:id', async (req, res) => {
    try {
      res.json({ ok: true, link: await links.update(req.params.id, req.body ?? {}) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  admin.delete('/links/:id', async (req, res) => {
    try {
      await links.remove(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  router.use('/api/admin', admin);

  /** A nyilvános link-oldal listája — csak a publikusra jelölt elemek. */
  router.get('/api/links', (req, res) => res.json({ links: links.list({ onlyPublic: true }) }));

  return router;
}
