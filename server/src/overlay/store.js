/**
 * Overlay-tár: widgetek, pozíciók, láthatóság (6–7. szegmens).
 *
 * A koordináták mindig a **fix 1920×1080-as vászonhoz** viszonyítva értendők,
 * függetlenül a Browser Source ablakának méretétől: a `/live` oldal a teljes
 * vásznat egyben skálázza. Így egy widget pozíciója ugyanoda esik 1080p-ben és
 * 720p-ben is, és a szerkesztő abszolút pixelben dolgozhat.
 *
 * Perzisztencia: `data/overlay.json` (elrendezés) + `data/widgets/` (feltöltött
 * logók). Szerver-újraindítás után minden pozíció és láthatóság megmarad.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CANVAS = Object.freeze({ width: 1920, height: 1080 });

export const WIDGET_TYPES = Object.freeze(['logo', 'embed', 'text', 'notification']);

/** Az állapot-képernyők, amikre egy widget szűrhető. */
export const SCREENS = Object.freeze(['intro', 'live', 'interrupted', 'outro', 'blank']);

const DEFAULT_SIZE = Object.freeze({
  logo: { width: 320, height: 160 },
  embed: { width: 420, height: 620 },
  text: { width: 640, height: 120 },
  notification: { width: 720, height: 140 },
});

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class OverlayStore {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.assetDir = path.join(dataDir, 'widgets');
    this.filePath = path.join(dataDir, 'overlay.json');
    this.data = { widgets: [] };
    this.ready = this.#load();
  }

  async #load() {
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });
    if (!existsSync(this.assetDir)) await mkdir(this.assetDir, { recursive: true });

    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed.widgets)) {
        this.data.widgets = parsed.widgets
          .map((widget) => this.#normalize(widget))
          .filter(Boolean);
      }
    } catch {
      // Első indítás: üres elrendezés. A `/live` ilyenkor csak az
      // állapot-képernyőket rendereli, widget nélkül.
    }
    await this.#pruneAssets();
  }

  /** Olyan képfájlok törlése, amikhez már nem tartozik widget. */
  async #pruneAssets() {
    try {
      const used = new Set(
        this.data.widgets.map((widget) => widget.data?.file).filter(Boolean),
      );
      for (const name of await readdir(this.assetDir)) {
        if (!used.has(name)) {
          await rm(path.join(this.assetDir, name), { force: true });
          this.logger?.info(`Elárvult widget-kép törölve: ${name}`);
        }
      }
    } catch (error) {
      this.logger?.warn(`Widget-képek takarítása sikertelen: ${error.message}`);
    }
  }

  async #save() {
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  // -------------------------------------------------------------------------
  // Normalizálás
  // -------------------------------------------------------------------------

  /**
   * Minden bejövő adat ezen megy át. A `/live` oldal így sosem kap hiányos
   * vagy értelmezhetetlen widgetet — egy hibás elem adás közben törné el a
   * kompozit réteget.
   */
  #normalize(widget) {
    if (!widget || !WIDGET_TYPES.includes(widget.type)) return null;

    const size = DEFAULT_SIZE[widget.type];
    const data = typeof widget.data === 'object' && widget.data ? { ...widget.data } : {};

    // Az embed-kulcs sosem a kliensé: mindig a szerver adja.
    if (widget.type === 'embed') {
      data.html = typeof data.html === 'string' ? data.html : '';
      data.embedKey = typeof data.embedKey === 'string' && data.embedKey.length >= 16
        ? data.embedKey
        : randomBytes(16).toString('hex');
      data.version = createHash('sha256').update(data.html).digest('hex').slice(0, 10);
    }

    return {
      id: String(widget.id ?? `${widget.type}-${Date.now().toString(36)}`),
      type: widget.type,
      name: String(widget.name ?? defaultName(widget.type)).slice(0, 80),
      visible: widget.visible !== false,
      locked: widget.locked === true,
      x: clamp(num(widget.x), -CANVAS.width, CANVAS.width * 2),
      y: clamp(num(widget.y), -CANVAS.height, CANVAS.height * 2),
      width: clamp(num(widget.width, size.width), 24, CANVAS.width * 2),
      height: clamp(num(widget.height, size.height), 24, CANVAS.height * 2),
      opacity: clamp(num(widget.opacity, 1), 0, 1),
      zIndex: clamp(Math.round(num(widget.zIndex, 1)), 0, 999),
      /** Mely képernyőkön látszódjon. Üres = mindegyiken. */
      screens: Array.isArray(widget.screens)
        ? widget.screens.filter((screen) => SCREENS.includes(screen))
        : [],
      data,
    };
  }

  // -------------------------------------------------------------------------
  // Lekérdezés
  // -------------------------------------------------------------------------

  get widgets() {
    return this.data.widgets.map((widget) => ({ ...widget, data: { ...widget.data } }));
  }

  find(id) {
    return this.data.widgets.find((widget) => widget.id === id) ?? null;
  }

  assetPath(id) {
    const widget = this.find(id);
    return widget?.data?.file ? path.join(this.assetDir, widget.data.file) : null;
  }

  /**
   * A `/live` oldalnak szánt leírás.
   *
   * Az embed HTML-je **nem** kerül bele: azt a böngésző külön, sandboxolt
   * iframe-ben tölti be a saját kulcsával. Így a nyers third-party kód nem
   * kerül be a szülő dokumentum adatfolyamába.
   */
  manifest() {
    return {
      canvas: CANVAS,
      widgets: this.widgets
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((widget) => {
          const view = {
            id: widget.id,
            type: widget.type,
            name: widget.name,
            visible: widget.visible,
            x: widget.x,
            y: widget.y,
            width: widget.width,
            height: widget.height,
            opacity: widget.opacity,
            zIndex: widget.zIndex,
            screens: widget.screens,
            data: {},
          };

          if (widget.type === 'logo' && widget.data.file) {
            view.data.url = `/overlay/asset/${widget.id}?v=${widget.data.version}`;
          } else if (widget.type === 'embed') {
            view.data.embedUrl = widget.data.html
              ? `/embed/${widget.id}?k=${widget.data.embedKey}&v=${widget.data.version}`
              : null;
          } else {
            view.data = {
              text: widget.data.text ?? '',
              color: widget.data.color,
              fontSize: widget.data.fontSize,
              align: widget.data.align,
            };
          }
          return view;
        }),
    };
  }

  /** Az admin szerkesztőnek: a nyers adat is kell (embed HTML szerkesztéshez). */
  adminManifest() {
    return {
      canvas: CANVAS,
      screens: SCREENS,
      widgets: this.widgets
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((widget) => ({
          ...widget,
          data: {
            ...widget.data,
            // A kulcsot nem adjuk ki feleslegesen a szerkesztőnek sem.
            embedKey: undefined,
            url: widget.data.file ? `/overlay/asset/${widget.id}?v=${widget.data.version}` : undefined,
            embedUrl: widget.data.html
              ? `/embed/${widget.id}?k=${widget.data.embedKey}&v=${widget.data.version}`
              : undefined,
          },
        })),
    };
  }

  /** Az embed tartalom kiadása — csak a widgethez tartozó kulccsal. */
  embedContent(id, key) {
    const widget = this.find(id);
    if (!widget || widget.type !== 'embed' || !widget.data.html) return null;
    if (!constantTimeEquals(String(key ?? ''), widget.data.embedKey)) return null;
    return { html: widget.data.html, version: widget.data.version };
  }

  // -------------------------------------------------------------------------
  // Módosítás
  // -------------------------------------------------------------------------

  async create(widget) {
    await this.ready;
    const created = this.#normalize({
      zIndex: this.data.widgets.length + 1,
      ...widget,
      id: undefined, // az azonosítót mindig a szerver adja
    });
    if (!created) throw new Error(`Ismeretlen widget típus: ${widget?.type}`);

    created.id = `${created.type}-${randomBytes(4).toString('hex')}`;
    this.data.widgets.push(created);
    await this.#save();
    this.logger?.info(`Widget létrehozva: ${created.name} (${created.type})`);
    return created;
  }

  /**
   * Részleges módosítás. A típus és az azonosító nem írható át, a feltöltött
   * kép pedig megmarad, akkor is, ha a hívó nem küldi vissza.
   */
  async update(id, patch) {
    await this.ready;
    const index = this.data.widgets.findIndex((widget) => widget.id === id);
    if (index < 0) throw new Error(`Nincs ilyen widget: ${id}`);

    const current = this.data.widgets[index];
    const merged = this.#normalize({
      ...current,
      ...patch,
      id: current.id,
      type: current.type,
      data: { ...current.data, ...(patch?.data ?? {}) },
    });

    this.data.widgets[index] = merged;
    await this.#save();
    return merged;
  }

  async remove(id) {
    await this.ready;
    const index = this.data.widgets.findIndex((widget) => widget.id === id);
    if (index < 0) throw new Error(`Nincs ilyen widget: ${id}`);

    const [removed] = this.data.widgets.splice(index, 1);
    await this.#save();
    if (removed.data?.file) {
      await rm(path.join(this.assetDir, removed.data.file), { force: true });
    }
    this.logger?.info(`Widget törölve: ${removed.name}`);
    return removed;
  }

  async replaceAll(widgets) {
    await this.ready;
    if (!Array.isArray(widgets)) throw new Error('A widgets mezőnek tömbnek kell lennie.');
    this.data.widgets = widgets.map((widget) => this.#normalize(widget)).filter(Boolean);
    await this.#save();
    await this.#pruneAssets();
    return this.manifest();
  }

  /**
   * Logó képének beállítása. A validálás a hívó dolga
   * (`media/validate.js`) — ide már csak ellenőrzött kép jut el.
   */
  async setImage(id, { buffer, ext, mime, originalName }) {
    await this.ready;
    const widget = this.find(id);
    if (!widget) throw new Error(`Nincs ilyen widget: ${id}`);
    if (widget.type !== 'logo') throw new Error('Képet csak logó widgethez lehet feltölteni.');

    const version = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
    const fileName = `${id}-${version}${ext}`;
    const target = path.join(this.assetDir, fileName);

    const temp = `${target}.tmp`;
    await writeFile(temp, buffer);
    await rename(temp, target);

    const previous = widget.data.file;
    widget.data = { ...widget.data, file: fileName, version, mime, originalName };
    await this.#save();

    if (previous && previous !== fileName) {
      await rm(path.join(this.assetDir, previous), { force: true });
    }
    this.logger?.ok(`Widget-kép feltöltve: ${widget.name} (${originalName})`);
    return widget;
  }
}

function defaultName(type) {
  return { logo: 'Logó', embed: 'Beágyazás', text: 'Szöveg', notification: 'Értesítés' }[type] ?? 'Widget';
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
