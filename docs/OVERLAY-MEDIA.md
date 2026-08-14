# OnLIVE — 5. szegmens: Overlay- és médiakezelés

> Az állapotgép (4. szegmens) megmondja, **melyik képernyő** kell; ez a
> szegmens adja hozzá, hogy **mit mutasson** rajta. A telefon továbbra sem tud
> semmit az intróról és az outróról.

Forrás: [`server/src/media/`](../server/src/media), [`server/src/api/media.js`](../server/src/api/media.js),
[`server/src/web/`](../server/src/web).

---

## 1. Három slot, pontosan az állapotgép képernyőihez

| Slot | Melyik állapot használja | Alap-viselkedés |
|---|---|---|
| `intro` | `intro` — „Hamarosan kezdünk" | ismétlődik, amíg meg nem jön a kép |
| `interrupted` | `reconnecting` **és** `paused` | ismétlődik |
| `outro` | `outro` | **egyszer** megy le |

A `reconnecting` és a `paused` szándékosan ugyanazt a slotot használja: a néző
nem tudja, és nem is kell tudnia, hogy a szakadás szándékos volt-e
([`STATE-MACHINE.md`](STATE-MACHINE.md) 4.).

Ha egy slotba nincs feltöltve semmi, a `/live` oldal a beépített **szöveges
tartalék képernyőt** mutatja — sosem fekete képet.

## 2. Tárolás — helyben, adatbázis nélkül

```
server/data/
├── media.json          # metaadatok + beállítások (slotok, outro hossz)
└── media/
    ├── intro-<hash>.mp4
    ├── interrupted-<hash>.webp
    └── outro-<hash>.mp4
```

- **Slotonként egy aktív fájl.** Feltöltéskor a régi törlődik, tehát a lemez
  nem telik meg használat közben.
- A fájlnév tartalmaz egy **tartalom-hasht**. Így ha ugyanazt a nevet töltöd
  fel más tartalommal, a böngésző és az OBS biztosan az újat kapja.
- Az írás sorrendje szándékos: előbb az új fájl kerül a helyére, csak utána a
  metaadat. Ha az írás félbeszakad, a **régi beállítás marad érvényben** —
  nem lesz olyan állapot, hogy a metaadat egy nem létező fájlra mutat.
- Induláskor a tár kitakarítja az elárvult fájlokat (félbemaradt feltöltés).

## 3. Típus-validáció — három réteg

Engedélyezett: **kép** `jpg` / `png` / `webp`, **videó** `mp4` / `webm`.

| Réteg | Mit néz | Megbízható? |
|---|---|---|
| kiterjesztés | a fájl neve | ❌ a felhasználó írja |
| `Content-Type` | a böngésző fejléce | ❌ hamisítható |
| **magic bytes** | a fájl tényleges első bájtjai | ✅ ez nem hazudik |

**Miért nem elegendő az első kettő:** egy `.mp4`-nek nevezett, `video/mp4`
fejléccel feltöltött HTML fájl a `/live` oldalba ágyazva tetszőleges szkriptet
futtatna — az OBS Browser Source-ban is. Ezért a tartalom-ellenőrzés itt nem
kényelmi funkció.

A validáció **elutasítja azt is**, ha a fájl valódi típusa nem egyezik a
küldött `Content-Type`-pal (kivéve az `image/jpg` ↔ `image/jpeg` eltérést, ami
csak elnevezésbeli). Méretkorlát: 512 MB.

Tesztek: [`server/test/media.test.js`](../server/test/media.test.js) —
köztük az „mp4-nek álcázott HTML elbukik" eset.

## 4. Megjelenítési beállítások slotonként

| Beállítás | Érték | Mit csinál |
|---|---|---|
| `fit` | `cover` / `contain` | kitölti a képet levágással, vagy teljesen belefér (letterbox) |
| `loop` | be/ki | videónál ismétlés — az outrónál alapból **ki** |
| `muted` | be/ki | némítás — alapból **be** |

**A némítás alapértéke nem véletlen:** a böngészők csak némán engedik az
automatikus lejátszást, tehát egy hangos intro videó egy sima böngészőfülön
el sem indulna. Az **OBS Browser Source** viszont hanggal is lejátssza, ezért
ott nyugodtan kikapcsolható a némítás.

Váltáskor a videó mindig **elölről** indul (`currentTime = 0`), így egy outro
sosem ott folytatódik, ahol egy korábbi session abbahagyta.

## 5. Outro hossz → `ended` → a session lezárása

Az outro hossza az admin felületen állítható (1–600 másodperc), és **futásidőben
érvényesül**: az állapotgép controllere függvényként kéri le, nem fix értékként,
ezért a következő outro már az új értékkel indul, szerver-újraindítás nélkül.

Feltöltés után az admin felület felajánlja a videó tényleges hosszát —
a böngésző kiolvassa a metaadatból, és javasolja beállítani.

Amikor az idő lejár:

```
outro ──(outro/done, időzítő)──> ended
                                   │
                                   ├─ a publisher-kapcsolat aktív bontása
                                   │  (MediaMTX kick API)
                                   └─ a folyamatok FUTNAK tovább
```

**Miért kell aktívan bontani a publishert:** ha az app ottragad (elakadt gomb,
félholt hálózat), az adás a szerver szerint már véget ért, a MediaMTX viszont
még fogadná a képet — és a **következő session azonnal `live`-ba ugorna** egy
régi stream miatt. A `IngestControl.closePublisher()` ezért a MediaMTX
kick-végpontján lekapcsolja a forrást (`webrtcsessions/kick/<id>`).

**Ami NEM áll le:** sem a MediaMTX, sem a vezérlő szerver folyamata — mindkettő
készen áll a következő adásra. A szó szerinti folyamat-leállítás továbbra is
külön kapcsoló (`ONLIVE_SHUTDOWN_ON_ENDED=true`), az indoklás:
[`STATE-MACHINE.md`](STATE-MACHINE.md) 8.1.

## 6. Előnézet

```
/live?preview=intro
/live?preview=interrupted
/live?preview=outro
/live?preview=live
```

Az előnézet **ugyanaz a `/live` oldal**, csak rögzített képernyővel — nem egy
külön, „hasonló" nézet. Amit itt látsz, pontosan az megy majd élesben is,
ugyanazokkal a `fit`/`loop`/`muted` beállításokkal.

Az admin felület ezt ágyazza be iframe-be (`/admin/media`), gombokkal a négy
képernyő és a valós állapot között.

## 7. API

| Végpont | Metódus | Mit csinál |
|---|---|---|
| `/api/admin/media` | GET | a teljes manifest (slotok + beállítások) |
| `/api/admin/media/:slot` | POST | feltöltés (`multipart/form-data`, mező: `file`) |
| `/api/admin/media/:slot` | PATCH | `fit` / `loop` / `muted` módosítása |
| `/api/admin/media/:slot` | DELETE | a slot ürítése |
| `/api/admin/media/settings` | POST | `{ outroDurationSeconds }` |
| `/api/media` | GET | manifest a `/live` oldalnak (nyilvános) |
| `/media/:slot` | GET | maga a fájl (nyilvános) |

Az admin végpontokat az `X-OnLIVE-Admin-Password` fejléc védi (a teljes
munkamenet-kezelés a 10. szegmensé).

**A fájlkiszolgálás Range-kéréseket is kezel** — enélkül egyes lejátszók
(köztük az OBS beépített böngészője) el sem indítanák az mp4-et. `ETag` +
`no-cache`: a slot URL-je állandó, a tartalom viszont változhat, ezért
újravalidálást kérünk, de a bájtokat nem töltjük le újra (`304`).

### Socket.io

| Esemény | Mikor |
|---|---|
| `onlive:media` | csatlakozáskor, és minden feltöltés/törlés/beállítás után |

Enélkül egy már megnyitott OBS Browser Source a régi fájlt mutatná a következő
adásig — ez az esemény frissíti helyben.

## 8. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Az élő videó lejátszása a `live` képernyőn (WHEP) | 6. szegmens |
| Átlátszó háttér, OBS-specifikus finomságok | 6. szegmens |
| Logó, chat, értesítés, drag-and-drop widgetek | 7. szegmens |
| A teljes admin felület (a média-oldal ennek része lesz) | 8. szegmens |
| Munkamenet-alapú admin hitelesítés | 10. szegmens |
