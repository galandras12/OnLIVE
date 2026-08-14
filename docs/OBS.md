# OnLIVE — 6. szegmens: OBS integráció (Browser Source)

> A `/live` oldal az **egyetlen hely, ahol a végleges kép összeáll**: az
> állapotnak megfelelő tartalom (intro / élő videó / „Megszakadt" / outro) és
> az aktív overlay widgetek egyetlen vászonra renderelve. Az OBS-ben ez egy
> darab Browser Source — nincs jelenetváltás, nincs kézi kapcsolgatás.

Forrás: [`server/src/web/live.html`](../server/src/web/live.html),
[`server/src/api/stream-proxy.js`](../server/src/api/stream-proxy.js).
Beállítási segédlet a felületen: `/admin/obs`.

---

## 1. Beállítás OBS-ben

1. **Források** → **+** → **Böngésző** (Browser Source)
2. **URL:** `https://live.galandras.com/live`
   (tokenes módban: `…/live?token=<token>`)
3. **Szélesség × Magasság:** `1920 × 1080`
4. **FPS:** 30 (vagy 60, ha a stream is annyi)
5. **Egyéni CSS:** hagyd üresen — az oldal háttere alapból átlátszó
6. Vedd ki a pipát ezekről:
   - „Forrás leállítása, ha nem látható"
   - „Böngésző frissítése jelenetváltáskor"

A 6. pont nem kozmetika: bekapcsolva minden jelenetváltásnál újraindulna a
WebRTC lejátszó, és **másodpercek esnének ki** az adásból.

A `/admin/obs` oldal kimásolható URL-t és ugyanezt a táblázatot adja.

## 2. Fix vászon, skálázott megjelenítés

Minden elem egy **fix 1920×1080-as vásznon** van, amit az oldal egyben
skáláz a Browser Source ablakához (`transform: scale`).

Ezért:

- egy widget koordinátája ugyanoda esik 1080p-ben és 720p-ben is,
- a szerkesztő (7. szegmens) abszolút pixelben dolgozhat,
- a méretarány sosem torzul (a rövidebb oldalhoz igazítunk).

## 3. Átlátszó háttér

A `body` háttere alapból `transparent`, tehát ahol nincs tartalom, ott az OBS
alatt lévő rétegek látszanak át. Két kivétel, szándékosan:

| Elem | Háttér | Miért |
|---|---|---|
| élő videó (`<video>`) | fekete | a videó mögött nem világít át semmi, különben a képarány melletti sávokban zavaros keveredés lenne |
| `?bg=solid` | `#0B0D10` | önálló böngészős nézéshez, ahol nincs mi alá kompozitálni |

Az oldal emellett letiltja a görgetősávot, a szövegkijelölést és az
egérkurzort — ezek Browser Source-ban mind zavaró műtermékek.

## 4. A videó útja: WHEP, HLS tartalékkal

```
böngésző/OBS ──POST /api/whep/onlive──> Node proxy ──> MediaMTX :8889 (WHEP)
             ──GET  /api/hls/onlive/…──> Node proxy ──> MediaMTX :8888 (HLS)
```

| Mód | Késleltetés | Mikor |
|---|---|---|
| **WHEP (WebRTC)** | ~0,2–0,5 s | alapértelmezés |
| **HLS** | ~2–6 s | ha három WHEP-próbálkozás sem sikerül |

A lejátszó exponenciális visszalépéssel próbálkozik (1 s → 2 s → 4 s → …
max 10 s), és három sikertelen WebRTC-kísérlet után **magától átvált HLS-re**.
Kézi felülbírálás: `?player=whep` vagy `?player=hls`.

**A lejátszó csak a `live` képernyőn fut.** Intro, „Megszakadt" és outro alatt
leáll — fölösleges lenne a sávszélesség és a CPU, ha a kép úgysem látszik.

### 4.1 Miért proxy, és nem közvetlen MediaMTX

A `live.galandras.com` a cloudflared konfigurációban a Node szerverre mutat, a
cloudflared pedig **nem ír át útvonalat** ([`NETWORKING.md`](NETWORKING.md)),
ezért nem lehet egy al-útvonalat a MediaMTX-re irányítani. A proxyval:

- egyetlen origin van (nincs CORS-tánc a böngészőben és az OBS CEF-jében),
- a hozzáférés egy helyen szabályozható (token, majd 10. szegmens),
- a MediaMTX olvasási joga **localhostra szorítva** maradhat.

Ezt a szerződést a 3. szegmens rögzítette ([`INGEST.md`](INGEST.md) 4.1).

### 4.2 A WHEP munkamenetek lezárása

A MediaMTX a `Location` fejlécben a saját belső URL-jét adja vissza. A proxy
ezt **saját azonosítóra cseréli** (`/api/whep/session/<uuid>`), és a
lejátszó ezen keresztül zárja le a munkamenetet.

Miért számít: az OBS gyakran újraindítja a forrást (jelenetváltás, program
újraindítás). Ha a munkamenetek nem záródnának le, néhány óra alatt tucatnyi
halott olvasó gyűlne össze a MediaMTX-ben.

## 5. Widgetek a vásznon

A `/live` oldal a szervertől kapott elrendezést rendereli:

```json
{
  "canvas": { "width": 1920, "height": 1080 },
  "widgets": [
    { "id": "logo", "type": "logo", "x": 1600, "y": 60, "width": 240, "height": 120,
      "opacity": 1, "screens": [], "data": { "url": "/media/logo" } },
    { "id": "hir", "type": "notification", "x": 80, "y": 900, "width": 700, "height": 110,
      "screens": ["live"], "data": { "text": "Üdv az adásban!" } }
  ]
}
```

- `screens`: mely állapotokban látszódjon (`[]` = mindegyikben). Így egy logó
  mehet az intro alatt is, egy chat-doboz viszont csak élő képen.
- A koordináták a fix vászonhoz viszonyítanak.
- Minden bejövő widget **normalizáláson** megy át (típus-ellenőrzés,
  határok közé szorítás), hogy egy hibás elem ne törje el a kompozit réteget
  adás közben.

**Ez a szegmens a renderelést adja.** A widget-szerkesztő (drag-and-drop
admin), a chat-források és az értesítés-küldés a **7. szegmensé** — az erre az
adatszerkezetre és az `onlive:overlay` eseményre fog épülni.

## 6. Valós idejű frissítés

| Socket esemény | Mit vált ki |
|---|---|
| `onlive:state` | képernyőváltás (intro → live → …), időzítők |
| `onlive:media` | új intro/outro/megszakadt fájl vagy beállítás |
| `onlive:overlay` | **widget mozgatása, ki-be kapcsolása** |

Mindhárom **újratöltés nélkül** hat a már futó Browser Source-ra. Az OBS-t
nem kell hozzányúlni, amíg az adás megy.

## 7. Hozzáférés: nyilvános vagy tokenes

Alapból a `/live` **nyilvános** — így az OBS-be elég a puszta URL.

Tokenes védelemhez állítsd be az `ONLIVE_LIVE_TOKEN` értékét. Ekkor token kell
ezekhez: `/live`, `/api/state`, `/api/media`, `/media/:slot`, `/api/overlay`,
`/api/whep/*`, `/api/hls/*`, **és a Socket.io kapcsolathoz is** — különben az
állapot-folyam token nélkül is olvasható maradna.

Az admin jelszó is elfogadott a token helyett, hogy az admin felület beágyazott
előnézete külön token nélkül működjön.

## 8. URL paraméterek

| Paraméter | Mit csinál |
|---|---|
| `?bg=solid` | fekete háttér átlátszó helyett (önálló nézéshez) |
| `?debug=1` | a lejátszó állapota a jobb alsó sarokban |
| `?player=whep` / `?player=hls` | kényszerített lejátszási mód |
| `?preview=intro\|interrupted\|outro\|live` | rögzített képernyő (admin előnézet) |
| `?token=…` | lejátszási token, ha be van kapcsolva |
| `?path=…` | másik stream neve (alapból a szerver beállítása) |

## 9. Hibakeresés

| Tünet | Ok | Teendő |
|---|---|---|
| „Újracsatlakozás…" marad WebRTC módban | nincs TURN — a WHIP jelzés átmegy az alagúton, a média nem | [`NETWORKING.md`](NETWORKING.md) 3. fejezet |
| HLS-re vált, de működik | a WebRTC médiaút nem jött össze | ugyanaz — a TURN beállítása után visszaáll |
| Fekete kép élő állapotban | nincs bejövő stream, vagy „megállt" a publisher | `infra/mediamtx/ingest-probe.ps1` |
| Jelenetváltáskor kiesik pár másodperc | be van kapcsolva a „Forrás leállítása, ha nem látható" | kapcsold ki (1. fejezet) |
| Nem indul a videó, `401` a naplóban | tokenes mód, de az URL-ben nincs token | `/admin/obs` oldalon a kész URL |
| Az intro videó néma | a némítás alapból be van kapcsolva | `/admin/media` → az adott slotnál kapcsold ki |

Beállításkor a `?debug=1` a leggyorsabb út: a jobb alsó sarok megmutatja, hogy
a lejátszó éppen mit csinál (`Élő (WebRTC)`, `Élő (HLS)`, `Újracsatlakozás…`).

## 10. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Widget-szerkesztő, drag-and-drop, chat-források | 7. szegmens |
| A teljes admin felület | 8. szegmens |
| Nézőszám, letölthető napló | 9. szegmens |
| Munkamenet-alapú hitelesítés, rate limit | 10. szegmens |
