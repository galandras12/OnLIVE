/**
 * Eszköz-vezérlés az admin felületről (8. szegmens).
 *
 * A web UI ezeken keresztül utasítja a telefont. A parancsok a telefon
 * következő telemetria-válaszával jutnak el hozzá (lásd `device/commands.js`).
 *
 * FONTOS elhatárolás: a session-állapotot **mindig a szerver állapotgépe**
 * dönti el. A `start` / `pause` / `resume` / `stop` itt KÉT dolgot tesz:
 *   1. lépteti az állapotgépet (ahogy az admin API eddig is),
 *   2. és szól a telefonnak, hogy ő is kövesse (különben az app tovább
 *      publikálna, és „ÉLŐ"-t mutatna egy már lezárt adás alatt).
 */

import { Router } from 'express';
import { DeviceCommands } from '../device/commands.js';
import { Events } from '../state/machine.js';
import { LogEvent, Source, clientId, describeChanges, diffSettings } from '../log/logger.js';
import {
  AUDIO_BITRATES,
  AUDIO_SAMPLE_RATES,
  FRAME_RATES,
  ORIENTATIONS,
  VIDEO_BITRATE,
  assessOrientation,
  assessResolution,
  resolutionLabel,
} from '../device/capture-options.js';

/** Az admin gomb → állapotgép-esemény + telefon-parancs párosítás. */
const SESSION_ACTIONS = {
  start: { event: Events.SESSION_START, command: DeviceCommands.START },
  pause: { event: Events.SESSION_PAUSE, command: DeviceCommands.PAUSE },
  resume: { event: Events.SESSION_RESUME, command: DeviceCommands.RESUME },
  stop: { event: Events.SESSION_END, command: DeviceCommands.STOP },
};

export function createDeviceRoutes({ config, controller, commands, logger, adminGuard }) {
  const router = Router();
  const admin = Router();
  admin.use(adminGuard);

  admin.get('/', (req, res) => res.json(commands.status()));

  /** Session-vezérlés a web UI-ról — a telefon is megkapja. */
  for (const [name, action] of Object.entries(SESSION_ACTIONS)) {
    admin.post(`/${name}`, (req, res) => {
      const client = clientId(req);
      logger.event({
        type: LogEvent.SESSION,
        source: Source.WEB,
        client,
        message: `Session-vezérlés a web UI-ról: ${name}`,
        action: name,
      });

      const result = controller.send(action.event, { reason: 'admin' }, Source.WEB, client);
      commands.push(action.command);
      res.json({ ok: true, changed: result.changed, state: result.snapshot.state });
    });
  }

  /** Lencseváltás: front | main | tele | ultra_wide */
  admin.post('/lens', (req, res) => {
    const lens = String(req.body?.lens ?? '').toLowerCase();
    if (!['front', 'main', 'tele', 'ultra_wide'].includes(lens)) {
      return res.status(400).json({ error: `Ismeretlen lencse: ${lens}` });
    }
    logChange(req, 'kamera', { lencse: { regi: commands.presence.capture?.lens ?? null, uj: lens } });
    res.json({ ok: true, command: commands.push(DeviceCommands.SET_LENS, { lens }) });
  });

  /**
   * Forrásváltás: camera | screen.
   *
   * KORLÁT: képernyő-megosztáshoz az Android **felhasználói hozzájárulást**
   * követel, amit távolról nem lehet megkerülni. A parancs hatására a telefon
   * felteszi a rendszer kérdését — ha nincs ott senki, a váltás nem történik meg.
   * Kamerára visszaváltani viszont távolról is működik.
   */
  admin.post('/source', (req, res) => {
    const source = String(req.body?.source ?? '').toLowerCase();
    if (!['camera', 'screen'].includes(source)) {
      return res.status(400).json({ error: `Ismeretlen forrás: ${source}` });
    }
    logChange(req, 'kamera', { forras: { regi: commands.presence.capture?.source ?? null, uj: source } });
    res.json({
      ok: true,
      command: commands.push(DeviceCommands.SET_SOURCE, { source }),
      note: source === 'screen'
        ? 'A telefonon meg kell erősíteni a képernyő-megosztást.'
        : undefined,
    });
  });

  /** Minőség: felbontás, fps, videó bitráta, hang mintavétel és bitráta. */
  admin.post('/quality', (req, res) => {
    const payload = {};
    const body = req.body ?? {};

    if (body.resolution) {
      const assessment = assessResolution(body.resolution);
      if (!assessment.ok) return res.status(400).json({ error: assessment.error });
      payload.resolution = assessment.value;
    }
    if (body.fps !== undefined) {
      const fps = Number(body.fps);
      if (!FRAME_RATES.includes(fps)) {
        return res.status(400).json({ error: `Ismeretlen képfrissítés: ${body.fps}` });
      }
      payload.fps = fps;
    }
    if (body.videoBitrateKbps !== undefined) {
      const kbps = Number(body.videoBitrateKbps);
      if (!Number.isFinite(kbps) || kbps < VIDEO_BITRATE.minKbps || kbps > VIDEO_BITRATE.maxKbps) {
        return res.status(400).json({
          error: `A videó bitráta ${VIDEO_BITRATE.minKbps} és ${VIDEO_BITRATE.maxKbps} kbps között lehet.`,
        });
      }
      payload.videoBitrateKbps = Math.round(kbps);
    }
    if (body.audioSampleRate !== undefined) {
      const hz = Number(body.audioSampleRate);
      if (!AUDIO_SAMPLE_RATES.includes(hz)) {
        return res.status(400).json({ error: `Ismeretlen mintavétel: ${body.audioSampleRate}` });
      }
      payload.audioSampleRate = hz;
    }
    if (body.audioBitrateKbps !== undefined) {
      const kbps = Number(body.audioBitrateKbps);
      if (!AUDIO_BITRATES.includes(kbps)) {
        return res.status(400).json({ error: `Ismeretlen hang bitráta: ${body.audioBitrateKbps}` });
      }
      payload.audioBitrateKbps = kbps;
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: 'Nincs értelmezhető minőségi beállítás.' });
    }

    // A régi értékeket a telefon utolsó `session/config` jelzéséből tudjuk.
    //
    // A felbontást KÖZÖS alakra hozzuk a naplóhoz: a parancs a telefon enum
    // nevét viszi (`P720`), az app viszont címkével jelent vissza (`720p`).
    // Enélkül minden állítás „1080p → P720" alakban látszana, a következő
    // jelentés után pedig „P720 → 720p" — vagyis a naplóban változásnak
    // tűnne az is, ami valójában ugyanaz.
    const current = commands.presence.capture ?? {};
    const changes = diffSettings(
      {
        resolution: current.resolution, fps: current.fps,
        videoBitrateKbps: current.videoBitrateKbps,
        audioSampleRate: current.audio?.sampleRate, audioBitrateKbps: current.audio?.bitrateKbps,
      },
      { ...payload, ...(payload.resolution ? { resolution: resolutionLabel(payload.resolution) } : {}) },
    );
    if (changes) logChange(req, 'minoseg', changes);

    res.json({ ok: true, command: commands.push(DeviceCommands.SET_QUALITY, payload) });
  });

  /**
   * Kép-irány: 16:9 fekvő vagy 9:16 álló (1.0.101).
   *
   * Miért külön végpont a minőségtől: ez nem menet közben állítható. A capture
   * arányát az adás INDÍTÁSAKOR rögzítjük, mert élő stream közben cserélni a
   * kép arányát azt jelentené, hogy a nézőnél átugrik a kompozíció — az OBS
   * jelenet, az overlay-ek és a felvétel is 16:9-re vagy 9:16-ra van szabva.
   * A telefon ezért a parancsot csak készenlétben hajtja végre.
   */
  admin.post('/orientation', (req, res) => {
    const assessment = assessOrientation(req.body?.orientation);
    if (!assessment.ok) return res.status(400).json({ error: assessment.error });

    const live = controller.snapshot().state;
    logChange(req, 'kamera', {
      irany: { regi: commands.presence.capture?.orientation ?? null, uj: assessment.value },
    });

    res.json({
      ok: true,
      command: commands.push(DeviceCommands.SET_ORIENTATION, { orientation: assessment.value }),
      note: ['idle', 'ended'].includes(live)
        ? undefined
        : 'Adás közben nem vált irányt: a telefon a következő indításnál veszi figyelembe.',
    });
  });

  /** A választható értékek — a web felület ebből építi a gombokat. */
  admin.get('/options', (req, res) => res.json({
    orientations: ORIENTATIONS,
    frameRates: FRAME_RATES,
    videoBitrate: VIDEO_BITRATE,
  }));

  /** Kiegészítők: vaku, kép mentése, helyi felvétel. */
  admin.post('/torch', (req, res) => {
    logChange(req, 'kamera', { vaku: { regi: null, uj: req.body?.on === true } });
    res.json({ ok: true, command: commands.push(DeviceCommands.TORCH, { on: req.body?.on === true }) });
  });

  admin.post('/photo', (req, res) =>
    res.json({ ok: true, command: commands.push(DeviceCommands.PHOTO) }));

  admin.post('/recording', (req, res) =>
    res.json({ ok: true, command: commands.push(DeviceCommands.RECORDING) }));

  /** Beállítás-változás naplózása egységes formában. */
  function logChange(req, area, changes) {
    logger.event({
      type: LogEvent.SETTINGS,
      source: Source.WEB,
      client: clientId(req),
      message: `${area === 'minoseg' ? 'Minőség' : 'Kamera'} módosítás — ${describeChanges(changes)}`,
      area,
      changes,
    });
  }

  router.use('/api/admin/device', admin);
  return router;
}
