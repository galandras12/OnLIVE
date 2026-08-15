# OnLIVE — 9. szegmens: Stream-monitor, letölthető napló, link-gyűjtő

> Három dolog, ami adás közben és adás után is kell: **látni, mi megy**,
> **utólag megnézni, mi történt**, és **egy koppintással elérni a chatet**.

Forrás: [`server/src/log/`](../server/src/log),
[`server/src/links/store.js`](../server/src/links/store.js),
[`server/src/web/admin-monitor.html`](../server/src/web/admin-monitor.html),
[`server/src/web/links.html`](../server/src/web/links.html).
Felület: `/admin` → **Monitor és linkek** fül, vagy közvetlenül `/admin/monitor`.

---

## 1. Élő monitor — és miben más, mint a `/live`

| | `/live` (6. szegmens) | `/admin/monitor` (ez) |
|---|---|---|
| Kinek | OBS, nézők | **csak az üzemeltetőnek** |
| Mit mutat | a kész kompozit: intro/outro, overlay, widgetek | a **nyers bejövő stream**, overlay nélkül |
| Célja | ez megy adásba | diagnosztika |
| Háttér | átlátszó (kompozitálható) | fekete, kis méret |

A nyers előnézet ugyanazon a WHEP proxyn keresztül jön, mint a `/live`
lejátszója, de **külön munkamenetben** — és csak akkor indul el, ha
megnyomod az „Indítás" gombot. Így nem terheli a hálózatot, amikor épp nem
nézed, és a lapot elhagyva a munkamenet lezárul.

### Pillanatnyi értékek

| Érték | Honnan |
|---|---|
| videó / hang bitráta, fps, RTT, **jitter**, csomagvesztés | a telefon WebRTC `getStats()` hívásából, 3 mp-enként |
| felbontás | a telefon capture-beállításából |
| adásidő | az állapotgéptől |
| MediaMTX elérhető / érkezik-e adat / sávok / olvasók | az ingest-figyelőtől (3. szegmens) |

A jitter ehhez a szegmenshez került be az Android oldali statisztikába
(`remote-inbound-rtp` → `jitter`), mert a panel enélkül hiányos lenne.

Külön jelezve a **„megállt"** eset: a publisher csatlakozva van, de nem nő a
bájtszámláló — ez más hiba, mint a teljes szakadás
([`INGEST.md`](INGEST.md) 3.2).

## 2. Letölthető napló

### Mit rögzít a szerver

| Fájl | Tartalom | Mikor ír |
|---|---|---|
| `data/transitions.jsonl` | minden állapotátmenet (mikor, honnan, hova, milyen esemény, ki váltotta ki) | átmenetkor |
| `data/metrics.jsonl` | bitráta, fps, RTT, jitter, vesztés — **az akkori állapottal együtt** | ~3 mp-enként |

A metrika mellé azért kerül oda az állapot, mert enélkül utólag nem lehetne
megmondani, hogy egy bitráta-esés **élő adás közben** történt-e, vagy már a
megszakadás alatt. Mindkettő append-only JSONL: egy félbeszakadt írás nem
viszi el a korábbi adatot, és nem kell hozzá adatbázis. A metrika-fájl 32 MB
felett elforgatódik (egy `.1` példány marad).

### Időszakok

A napló nem nyers sorokat ad, hanem **időszakokat**: egy időszak egy
összefüggő állapot-szakasz, a rá eső mintákból számolt adatokkal.

```
allapot  kezdet                    hossz  atlag  min   max   kieses
intro    2026-08-15T10:00:00Z       10 mp  4320  4320  4320  nem
live     2026-08-15T10:00:10Z      180 mp  4500  3000  6000  nem
reconnecting 2026-08-15T10:03:10Z   30 mp     0     0     0  igen
live     2026-08-15T10:03:40Z      180 mp  5300  5200  5400  nem
```

Ez válaszolja meg azt, amiért a napló készül: **mennyit ment folyamatosan, és
mikor esett szét.** A `paused` is kiesésnek számít a naplóban — az adás
szempontjából ugyanúgy nem ment kép, akkor is, ha szándékos volt.

### CSV letöltés

A „Napló letöltése" gomb a szűrők szerint generál fájlt:

- **session** szerint (legördülő), vagy
- **dátum-tartományra** (`ettől` / `eddig`).

Két elválasztó közül lehet választani, mert a két cél-program mást szeret:

| Választás | Mikor |
|---|---|
| **pontosvessző** (alapértelmezés) | magyar Excel — dupla kattintásra oszlopokra bontva nyílik |
| **vessző** | Google Sheets |

A fájl **BOM-mal** kezdődik, hogy az Excel ne rontsa el az ékezeteket, és
CRLF sorvégekkel megy. Az elválasztót vagy idézőjelet tartalmazó mezők
idézőjelbe kerülnek, a belső idézőjel duplázódik.

Oszlopok: `session, allapot, kieses, kezdet, vege, hossz_mp, minta_db,
atlag_kbps, min_kbps, max_kbps, atlag_fps, atlag_rtt_ms, atlag_jitter_ms,
max_vesztes_szazalek, esemeny, forras`.

A letöltés `fetch`-csel megy és blobként mentődik — mert az admin
hitelesítés fejlécben utazik, egy sima `<a href>` nem vinné magával.

### Grafikon

A CSV mellett a felületen egy egyszerű vonalgrafikon: **videó bitráta időben**,
alatta színes sávok a kiesésekre — **piros** a nem szándékos megszakadás,
**borostyán** a szándékos szünet. Külső könyvtár nélkül, canvasra rajzolva
(az oldal így nem hoz be újabb függőséget).

## 3. Chat-link gyűjtő

Elnevezett linkek listája („YouTube chat", „Twitch chat", „Discord"), amiket
egyszer beállítasz az admin felületen.

**Ez nem ugyanaz, mint a 7. szegmens beágyazott widgetjei.** Az ott
third-party kódot futtat a képen, sandboxolt iframe-ben. Ez **nem ágyaz be
semmit**: egyszerűen megnyit egy címet új fülön. A kettő párhuzamosan
használható — a chat mehet overlay-ként a képre, és nyitható külön ablakban is.

| | beágyazott widget (7.) | link-gyűjtő (9.) |
|---|---|---|
| Fut-e third-party kód | igen, sandboxban | **nem** |
| Hol jelenik meg | a `/live` kompozit képen | gombként, kattintásra nyílik |
| Mire jó | chat a képen a nézőknek | neked, adás közben, telefonon |

### Hol jelennek meg a gombok

- **`/admin/monitor`** — szerkeszthető lista és gyors megnyitás.
- **`/links`** — külön, mobilra szabott nyilvános oldal, nagy gombokkal.
  Ezt nyitod meg a telefonon, és egy koppintással ugrasz a chatre. Az oldal
  fejlécében az adás állapota is látszik.

**Miért külön oldal, és miért nem a `/live`:** a `/live` a kompozit
render-felület, ahol szándékosan nincs interakció (nincs kurzor, nincs
kattintható elem, nincs görgetés) — az OBS-ben ezek műtermékek lennének.
Linkgombokat tenni oda elrontaná a Browser Source-t.

Linkenként állítható, hogy megjelenjen-e a nyilvános oldalon (`public`), így a
belső linkek (pl. moderátor-panel) csak az adminban látszanak.

### Biztonság

Csak `http` és `https` séma engedélyezett. Egy `javascript:` séma a gombra
kattintva a mi oldalunk kontextusában futna le — a lista ugyan
admin-szerkesztett, de az ellenőrzés olcsó, és a link a publikus oldalon is
megjelenhet. A `data:` és `file:` sémák is tiltottak.

## 4. API

| Végpont | Mit ad |
|---|---|
| `GET /api/admin/report` | időszakok, session-összegzés, grafikon-adatok (JSON) |
| `GET /api/admin/report.csv` | letölthető napló (`?session=`, `?from=`, `?to=`, `?sep=comma`) |
| `GET /api/admin/sessions` | session-lista a szűrő legördülőjéhez |
| `GET /api/admin/links` | linkek (admin) |
| `POST/PATCH/DELETE /api/admin/links[/:id]` | link kezelése |
| `GET /api/links` | a **publikusra** jelölt linkek (nyilvános) |

## 5. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Nézőszám-statisztika, hosszú távú analitika | nincs a tervben (a MediaMTX olvasó-száma látszik) |
| A napló automatikus e-mailezése/exportja | nincs a tervben |
| Munkamenet-alapú admin hitelesítés, rate limit | 10. szegmens |
| `start.bat`, üzemeltetés, tesztelési terv | 11. szegmens |
