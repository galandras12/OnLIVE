/**
 * Overlay-elrendezés (6. szegmens: a RENDERELÉS oldala).
 *
 * A szerver leírja, MI látszik és HOL — a `/live` oldal ezt rendereli.
 * A koordináták mindig a **fix 1920×1080-as vászonhoz** viszonyítva
 * értendők, függetlenül attól, mekkora a Browser Source ablaka: a `/live`
 * oldal a teljes vásznat egyben skálázza. Így egy widget pozíciója
 * ugyanoda esik 1080p-ben és 720p-ben is.
 *
 * FIGYELEM a hatáskörre: ez a modul csak az elrendezés TÁROLÁSA és
 * KIADÁSA. A widgetek szerkesztője (drag-and-drop admin felület), a chat-
 * források és az értesítés-küldés a **7. szegmens** feladata — az erre a
 * tárolóra fog építeni.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CANVAS = Object.freeze({ width: 1920, height: 1080 });

/** A renderer által ismert típusok. Bővítés: 7. szegmens. */
export const WIDGET_TYPES = Object.freeze(['logo', 'text', 'notification']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export class OverlayStore {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'overlay.json');
    this.data = { widgets: [] };
    this.ready = this.#load();
  }

  async #load() {
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed.widgets)) {
        this.data.widgets = parsed.widgets.map((widget) => this.#normalize(widget)).filter(Boolean);
      }
    } catch {
      // Első indítás: üres elrendezés. A `/live` ilyenkor csak az
      // állapot-képernyőket rendereli, widget nélkül.
    }
  }

  async #save() {
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  /**
   * Egy widget épeszű alakra hozása. Minden bejövő adatot átengedünk ezen —
   * a `/live` oldal így sosem kap hiányos vagy vásznon kívüli elemet.
   */
  #normalize(widget) {
    if (!widget || !WIDGET_TYPES.includes(widget.type)) return null;

    return {
      id: String(widget.id ?? `${widget.type}-${Date.now()}`),
      type: widget.type,
      visible: widget.visible !== false,
      x: clamp(widget.x, -CANVAS.width, CANVAS.width * 2),
      y: clamp(widget.y, -CANVAS.height, CANVAS.height * 2),
      width: clamp(widget.width ?? 320, 16, CANVAS.width * 2),
      height: clamp(widget.height ?? 120, 16, CANVAS.height * 2),
      opacity: Math.min(1, Math.max(0, Number(widget.opacity ?? 1))),
      /** Melyik állapotokban látszódjon. Üres/hiányzó = mindegyikben. */
      screens: Array.isArray(widget.screens) ? widget.screens : [],
      /** Típus-specifikus tartalom (szöveg, kép-URL, stílus…). */
      data: typeof widget.data === 'object' && widget.data ? widget.data : {},
    };
  }

  get widgets() {
    return this.data.widgets.map((widget) => ({ ...widget }));
  }

  manifest() {
    return { canvas: CANVAS, widgets: this.widgets };
  }

  /** A teljes elrendezés cseréje (a 7. szegmens szerkesztője ezt hívja majd). */
  async replaceAll(widgets) {
    await this.ready;
    if (!Array.isArray(widgets)) throw new Error('A widgets mezőnek tömbnek kell lennie.');

    this.data.widgets = widgets.map((widget) => this.#normalize(widget)).filter(Boolean);
    await this.#save();
    return this.manifest();
  }

  /** Egyetlen widget részleges módosítása — ezt használja a mozgatás. */
  async update(id, patch) {
    await this.ready;
    const index = this.data.widgets.findIndex((widget) => widget.id === id);
    if (index < 0) throw new Error(`Nincs ilyen widget: ${id}`);

    const merged = this.#normalize({ ...this.data.widgets[index], ...patch, id, type: this.data.widgets[index].type });
    this.data.widgets[index] = merged;
    await this.#save();
    return merged;
  }
}
