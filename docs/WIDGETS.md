# OnLIVE — 7. szegmens: Widget rendszer

> Szabadon mozgatható és átméretezhető widgetek a `/live` kompozit felületen,
> Canva-szerű szerkesztővel az admin oldalon. A pozíció és a láthatóság
> fájlban tárolódik, tehát szerver-újraindítás után is megmarad.

Forrás: [`server/src/overlay/store.js`](../server/src/overlay/store.js),
[`server/src/api/overlay.js`](../server/src/api/overlay.js),
[`server/src/web/admin-overlay.html`](../server/src/web/admin-overlay.html).
Szerkesztő: `/admin/overlay`.

---

## 1. Widget típusok

| Típus | Mit csinál | Tartalom |
|---|---|---|
| `logo` | statikus kép | feltöltött jpg / png / webp |
| `embed` | third-party beágyazás | tetszőleges HTML/script (chat, értesítés, YouTube/Twitch overlay) |
| `text` | egyszerű felirat | szöveg, szín, méret |
| `notification` | kiemelt értesítés-doboz | ugyanaz, sötét háttérrel és színes csíkkal |

Minden widgetnek van **be/ki kapcsolója** (`visible`), és opcionálisan
megadható, hogy **mely állapot-képernyőkön** látszódjon (`screens`):

- üres lista → mindenhol látszik (pl. állandó logó),
- `["live"]` → csak élő képen (pl. chat-doboz, hogy az intro alatt ne zavarjon),
- `["intro","outro"]` → csak a be- és kivezető képernyőn.

## 2. A szerkesztő (`/admin/overlay`)

- **Fix 1920×1080-as vászon**, a böngészőablakhoz skálázva — ugyanaz a
  koordináta-rendszer, amit a `/live` használ (lásd [`OBS.md`](OBS.md) 2.).
- **Élő háttér:** a vászon mögött a valódi `/live` oldal fut iframe-ben, így a
  widgeteket a tényleges kompozícióhoz képest lehet elhelyezni. Kikapcsolható.
- **Mozgatás:** húzd a dobozt. **Átméretezés:** a négy sarok fogantyúja.
- **Rácsra illesztés** 10 pixelenként; `Shift` lenyomva szabad mozgatás,
  `Alt` átméretezésnél megtartja a képarányt.
- **Nyilak:** 1 px finomhangolás, `Shift`+nyíl 10 px.
- **Rétegek listája:** kiválasztás, láthatóság kapcsolása egy kattintással,
  a sorrend a `z` érték szerint (felül a legfelső réteg).
- **Rögzítés** (`locked`): a widget nem mozdítható véletlenül adás közben.
- Minden változás azonnal mentődik, és a `/live` oldal **újratöltés nélkül**
  követi — az OBS-hez nem kell hozzányúlni.

Mozgatás közben nem minden pixelnél megy kérés a szerverre: a mentés
250 ms-os késleltetéssel csoportosít, az egér felengedésekor pedig kap egy
biztos, végleges mentést.

## 3. Perzisztencia

```
server/data/
├── overlay.json      # widgetek: típus, pozíció, méret, láthatóság, z, szűrők
└── widgets/
    └── logo-<id>-<hash>.png
```

- A pozíció, a méret, a láthatóság és a képernyő-szűrő **globálisan** tárolódik
  (nem session-önként) — így egy újraindítás vagy egy új adás után is pontosan
  ott folytatódik minden, ahol abbahagytad.
- A feltöltött kép fájlneve tartalom-hasht tartalmaz, tehát csere után a
  böngésző és az OBS biztosan az újat kapja.
- Induláskor a tár törli azokat a képeket, amikhez már nincs widget.
- Minden bejövő adat **normalizáláson** megy át (típus-ellenőrzés, méret- és
  koordináta-határok, opacitás 0–1 közé szorítva). Egy hibás elem így nem tudja
  eltörni a kompozit réteget adás közben.

## 4. Biztonság: a beágyazott third-party kód

Ez a szegmens legfontosabb pontja. A beágyazás **sandboxolt iframe-ben** fut,
három egymást erősítő védelemmel:

### 4.1 Sandbox `allow-same-origin` nélkül

```html
<iframe sandbox="allow-scripts" src="/embed/<id>?k=<kulcs>&v=<verzió>"></iframe>
```

A `sandbox="allow-scripts"` **`allow-same-origin` nélkül** átlátszatlan
(opaque) origint ad az iframe-nek. Ez azt jelenti, hogy a benne futó kód:

- nem éri el a szülő oldal DOM-ját (`window.parent.document` tiltott),
- nem olvassa a `localStorage`-ot és a sütiket,
- nem tud a mi originünk nevében kérést indítani.

> A két jogosultság **együtt** (`allow-scripts allow-same-origin`) kioltaná a
> sandboxot — a beágyazott kód ilyenkor ki tudna törni. Ezért soha nem adjuk
> meg egyszerre. A `/live` oldalon csak `allow-scripts` szerepel.

### 4.2 A beágyazás saját kulcsot kap, nem a lejátszási tokent

A tartalom nem a fő oldal URL-jén érhető el, hanem widgetenkénti véletlen
kulccsal (`?k=`), amit **a szerver generál** (a kliens nem adhatja meg).

Miért számít: a beágyazott szkript ki tudja olvasni a saját címsorát. Ha a
lejátszási tokent tennénk bele, egy kompromittált chat-widget megszerezhetné
és továbbküldhetné. Így legfeljebb a saját, szűk hatókörű kulcsát látja.

### 4.3 Fejlécek az embed dokumentumon

| Fejléc | Mit véd |
|---|---|
| `Content-Security-Policy: frame-ancestors 'self'` | csak a mi oldalunk ágyazhatja be |
| `X-Content-Type-Options: nosniff` | nincs tartalom-típus találgatás |
| `Referrer-Policy: no-referrer` | a third-party nem kapja meg, honnan jött |
| `Cache-Control: no-store` | kód-csere után nem marad régi példány |

### 4.4 Fenyegetettségi modell

A beágyazott HTML-t **az üzemeltető adja meg**, tehát nem ismeretlen forrásból
származik. A védelem arra szól, hogy egy **kompromittált vagy rosszindulatúan
viselkedő third-party szkript** (chat-szolgáltató, értesítés-widget) ne
férhessen hozzá az OnLIVE felülethez, az admin munkamenethez és a tokenekhez.

Emellett: a nyers beágyazási kód **nem kerül bele** a `/live` oldal
manifestjébe — az csak a betöltő URL-t kapja meg. Így a third-party kód
sosem jelenik meg a szülő dokumentum adatfolyamában.

## 5. A `/live` oldali renderelés

A widgetek renderelése **inkrementális**: az elemek megmaradnak, és csak a
pozíció, méret, láthatóság frissül.

Miért nem egyszerű újrarajzolás: egy beágyazott chat iframe minden
újralétrehozáskor újratöltene. Állapotváltáskor (pl. `live` → `reconnecting`
→ `live`) elveszne az addigi beszélgetés, és a third-party szkript újraindulna.
Iframe-et ezért csak akkor cserélünk, ha tényleg megváltozott a forrás — azaz
ha a beágyazott kódot szerkesztetted.

## 6. API

| Végpont | Metódus | Mit csinál |
|---|---|---|
| `/api/admin/overlay` | GET | teljes elrendezés a szerkesztőnek |
| `/api/admin/overlay` | POST | új widget |
| `/api/admin/overlay` | PUT | a teljes elrendezés cseréje |
| `/api/admin/overlay/:id` | PATCH | módosítás (mozgatás, méret, láthatóság, tartalom) |
| `/api/admin/overlay/:id` | DELETE | törlés (a képével együtt) |
| `/api/admin/overlay/:id/image` | POST | logó kép feltöltése (`multipart`, mező: `file`) |
| `/api/overlay` | GET | elrendezés a `/live` oldalnak (embed HTML nélkül) |
| `/overlay/asset/:id` | GET | a feltöltött logó képe |
| `/embed/:id?k=…` | GET | a beágyazott tartalom saját, sandboxolt dokumentumban |

Socket esemény minden változásnál: `onlive:overlay`.

Korlátok: kép max. 16 MB (csak jpg/png/webp, tartalom-alapú ellenőrzéssel),
beágyazott kód max. 64 kB.

## 7. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Chat-üzenetek fogadása/megjelenítése saját megoldással | nincs a tervben — a chat third-party beágyazásként jön |
| Az admin felület többi része (állapotvezérlés, metrikák) | 8. szegmens |
| Nézőszám, letölthető napló | 9. szegmens |
| Munkamenet-alapú admin hitelesítés (most fejléces jelszó) | 10. szegmens |
