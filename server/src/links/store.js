/**
 * Chat-link gyűjtő (9. szegmens).
 *
 * Egyszerű, elnevezett linkek listája („YouTube chat", „Twitch chat",
 * „Discord"), amiket egyszer beállítasz, és utána egy gombnyomással
 * megnyithatók — mobil böngészőben új fülön.
 *
 * ELHATÁROLÁS a 7. szegmens beágyazott widgetjeitől: ez **nem ágyaz be**
 * semmit. Nem fut third-party kód, nincs iframe, nincs sandbox-kérdés —
 * egyszerűen megnyit egy címet kattintásra. A kettő párhuzamosan használható:
 * a chat mehet overlay-ként a képre, és nyitható külön ablakban is.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/**
 * Csak `http` és `https` engedélyezett.
 *
 * Miért fontos: egy `javascript:` séma a gombra kattintva a mi oldalunk
 * kontextusában futna le. A lista admin-szerkesztett, de az ellenőrzés
 * olcsó, és a link a publikus oldalon is megjelenhet.
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('Az URL nem lehet üres.');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Érvénytelen URL. Teljes címet adj meg, https://-sel.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Nem engedélyezett protokoll: ${url.protocol}`);
  }
  return url.toString();
}

export class LinkStore {
  constructor({ dataDir, logger }) {
    this.logger = logger;
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'links.json');
    this.data = { links: [] };
    this.ready = this.#load();
  }

  async #load() {
    if (!existsSync(this.dataDir)) await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed.links)) {
        this.data.links = parsed.links.map((link) => this.#normalize(link)).filter(Boolean);
      }
    } catch {
      // Első indítás: üres lista.
    }
  }

  async #save() {
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(temp, this.filePath);
  }

  #normalize(link) {
    if (!link?.url) return null;
    let url;
    try {
      url = normalizeUrl(link.url);
    } catch {
      return null;
    }
    return {
      id: String(link.id ?? `link-${randomBytes(3).toString('hex')}`),
      name: String(link.name ?? 'Link').slice(0, 60),
      url,
      /** Megjelenjen-e a nyilvános `/links` oldalon is. */
      public: link.public !== false,
      order: Number.isFinite(Number(link.order)) ? Number(link.order) : 0,
    };
  }

  get links() {
    return [...this.data.links].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'hu'));
  }

  /** Az admin mindent lát; a nyilvános oldal csak a publikusra jelölteket. */
  list({ onlyPublic = false } = {}) {
    return this.links.filter((link) => !onlyPublic || link.public);
  }

  async create({ name, url, public: isPublic = true }) {
    await this.ready;
    const link = this.#normalize({
      name,
      url: normalizeUrl(url),
      public: isPublic,
      order: this.data.links.length,
    });
    if (!link) throw new Error('Érvénytelen link.');

    this.data.links.push(link);
    await this.#save();
    this.logger?.info(`Link hozzáadva: ${link.name}`);
    return link;
  }

  async update(id, patch) {
    await this.ready;
    const index = this.data.links.findIndex((link) => link.id === id);
    if (index < 0) throw new Error(`Nincs ilyen link: ${id}`);

    const current = this.data.links[index];
    const merged = this.#normalize({
      ...current,
      ...patch,
      id: current.id,
      url: patch.url !== undefined ? normalizeUrl(patch.url) : current.url,
    });
    if (!merged) throw new Error('Érvénytelen link.');

    this.data.links[index] = merged;
    await this.#save();
    return merged;
  }

  async remove(id) {
    await this.ready;
    const index = this.data.links.findIndex((link) => link.id === id);
    if (index < 0) throw new Error(`Nincs ilyen link: ${id}`);

    const [removed] = this.data.links.splice(index, 1);
    await this.#save();
    this.logger?.info(`Link törölve: ${removed.name}`);
    return removed;
  }
}
