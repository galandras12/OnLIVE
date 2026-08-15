/**
 * Napló-összeállítás (9. szegmens).
 *
 * Két forrásból dolgozik:
 *   - `transitions.jsonl` — mikor melyik állapotba lépett a rendszer,
 *   - `metrics.jsonl`     — 3 másodpercenként mért bitráta, fps, RTT, vesztés.
 *
 * A kettőből **időszakokat** épít: egy időszak egy összefüggő állapot-szakasz
 * (pl. „14:02:11-től 14:19:40-ig live"), a rá eső mintákból számolt
 * átlag/min/max bitrátával. Pontosan ez az, ami utólag megválaszolja, hogy
 * „mennyit ment folyamatosan, és mikor esett szét".
 */

/** Melyik állapotok számítanak kiesésnek a jelentésben. */
const OUTAGE_STATES = new Set(['reconnecting', 'paused']);

const AVERAGE = (values) =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

/**
 * Állapot-szakaszok építése.
 *
 * @param {object[]} transitions a `transitions.jsonl` sorai (időrendben)
 * @param {object[]} samples a `metrics.jsonl` sorai (időrendben)
 * @param {object} [range] `{ from, to, sessionId }` — ezredmásodperces szűrők
 */
export function buildPeriods(transitions, samples, range = {}) {
  const { from, to, sessionId } = range;
  const now = Date.now();

  const events = transitions
    .map((entry) => ({ ...entry, ms: Date.parse(entry.at) }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => a.ms - b.ms);

  const periods = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const start = event.ms;
    // Az időszak addig tart, amíg a következő átmenet be nem következik.
    const end = events[index + 1]?.ms ?? now;

    if (sessionId && event.sessionId !== sessionId) continue;
    if (to && start > to) continue;
    if (from && end < from) continue;

    // Részleges átfedésnél a szűrő határai vágnak.
    const clippedStart = from ? Math.max(start, from) : start;
    const clippedEnd = to ? Math.min(end, to) : end;

    const inPeriod = samples.filter((sample) => sample.ms >= clippedStart && sample.ms < clippedEnd);
    const bitrates = inPeriod.map((sample) => sample.videoKbps).filter((value) => value > 0);

    periods.push({
      sessionId: event.sessionId ?? null,
      state: event.to,
      event: event.event,
      source: event.source,
      start: new Date(clippedStart).toISOString(),
      end: new Date(clippedEnd).toISOString(),
      durationSeconds: Math.max(0, Math.round((clippedEnd - clippedStart) / 1000)),
      outage: OUTAGE_STATES.has(event.to),
      samples: inPeriod.length,
      avgKbps: AVERAGE(bitrates),
      minKbps: bitrates.length ? Math.min(...bitrates) : 0,
      maxKbps: bitrates.length ? Math.max(...bitrates) : 0,
      avgFps: AVERAGE(inPeriod.map((sample) => sample.fps)),
      avgRttMs: AVERAGE(inPeriod.map((sample) => sample.rttMs)),
      avgJitterMs: AVERAGE(inPeriod.map((sample) => sample.jitterMs ?? 0)),
      maxLossPercent: inPeriod.length
        ? Number(Math.max(...inPeriod.map((sample) => sample.lossPercent ?? 0)).toFixed(2))
        : 0,
    });
  }

  return periods;
}

/** Session-szintű összegzés a szűrő legördülőjéhez és a fejléchez. */
export function summarize(periods) {
  const sessions = new Map();

  for (const period of periods) {
    const key = period.sessionId ?? 'ismeretlen';
    if (!sessions.has(key)) {
      sessions.set(key, {
        sessionId: period.sessionId,
        start: period.start,
        end: period.end,
        liveSeconds: 0,
        outageSeconds: 0,
        outages: 0,
        avgKbps: [],
        maxKbps: 0,
      });
    }
    const summary = sessions.get(key);
    summary.end = period.end;

    if (period.state === 'live') {
      summary.liveSeconds += period.durationSeconds;
      if (period.avgKbps) summary.avgKbps.push(period.avgKbps);
      summary.maxKbps = Math.max(summary.maxKbps, period.maxKbps);
    } else if (period.outage) {
      summary.outageSeconds += period.durationSeconds;
      summary.outages += 1;
    }
  }

  return [...sessions.values()].map((summary) => ({
    ...summary,
    avgKbps: AVERAGE(summary.avgKbps),
  }));
}

/**
 * CSV előállítás.
 *
 * Alapból **pontosvessző** az elválasztó és van BOM: a magyar Excel így
 * oszlopokra bontva nyitja meg dupla kattintásra. A Google Sheets a vesszős
 * változatot szereti — arra a `separator: 'comma'` opció való.
 */
export function toCsv(periods, { separator = 'semicolon' } = {}) {
  const sep = separator === 'comma' ? ',' : ';';

  const header = [
    'session', 'allapot', 'kieses', 'kezdet', 'vege', 'hossz_mp',
    'minta_db', 'atlag_kbps', 'min_kbps', 'max_kbps',
    'atlag_fps', 'atlag_rtt_ms', 'atlag_jitter_ms', 'max_vesztes_szazalek',
    'esemeny', 'forras',
  ];

  const rows = periods.map((period) => [
    period.sessionId ?? '',
    period.state,
    period.outage ? 'igen' : 'nem',
    period.start,
    period.end,
    period.durationSeconds,
    period.samples,
    period.avgKbps,
    period.minKbps,
    period.maxKbps,
    period.avgFps,
    period.avgRttMs,
    period.avgJitterMs,
    period.maxLossPercent,
    period.event,
    period.source,
  ]);

  const escape = (value) => {
    const text = String(value ?? '');
    return /[";\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  const lines = [header, ...rows].map((row) => row.map(escape).join(sep));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A beágyazott grafikonhoz: idősor + a kiesések sávjai. */
export function toChartSeries(samples, periods) {
  return {
    points: samples.map((sample) => ({
      t: sample.ms,
      kbps: sample.videoKbps,
      state: sample.state,
    })),
    outages: periods
      .filter((period) => period.outage)
      .map((period) => ({
        from: Date.parse(period.start),
        to: Date.parse(period.end),
        state: period.state,
      })),
  };
}
