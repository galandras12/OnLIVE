# OnLIVE — 8. szegmens: Admin / vezérlő felület

> Egyetlen oldal (`/admin`), amiről az egész adás vezérelhető: állapot,
> Kezdés/Szünet/Befejezés, kamera és minőség, overlay-szerkesztő, média,
> OBS-beállítás, és a stream-monitor a link-gyűjtővel.

Forrás: [`server/src/web/admin.html`](../server/src/web/admin.html),
[`server/src/web/admin.css`](../server/src/web/admin.css),
[`server/src/api/device.js`](../server/src/api/device.js),
[`server/src/device/commands.js`](../server/src/device/commands.js).

---

## 1. Dizájn

**Nincs külső style guide-om korábbi projektekből**, amire hivatkozhatnék —
ezért a 5–7. szegmens felületein már kialakult esztétikát emeltem ki közös
helyre ([`admin.css`](../server/src/web/admin.css)), és minden admin oldal
mostantól ezt használja.

A tokenek és az indoklásuk:

| Token | Érték | Miért |
|---|---|---|
| `--bg` / `--panel` | `#0B0D10` / `#12161c` | sötét alap: az operátor élő adás közben nézi, gyakran sötét szobában |
| `--accent` | `#e11d48` (rózsa) | **egyetlen** kiemelő szín, csak ott, ahol tényleg számít: élő állapot, elsődleges művelet, hiba |
| `--ok` / `--warn` / `--info` | zöld / borostyán / indigó | jelentés-színek: rendben, átmeneti állapot, outro |
| `--r-sm/md/lg` | 7 / 10 / 14 px | egységes lekerekítés |
| tipográfia | rendszer-betűtípus, tabuláris számok a metrikáknál | ne ugráljon a bitráta kijelzése |

Két szabály, ami végigmegy az egészen:

1. **A szín önmagában sosem hordoz információt** — minden állapotjelzés mellett
   ott a szöveg is (`ÉLŐ`, `Megszakadt`, `Szüneteltetve`).
2. **Minimalizmus tartalommal**: nincs dekoráció, minden elem vagy állapotot
   mutat, vagy műveletet indít.

## 2. Fülek

| Fül | Tartalom |
|---|---|
| **Vezérlés** | állapot, Kezdés/Szünet/Befejezés, élő metrikák, előnézet, kamera- és minőség-vezérlés |
| **Overlay** | a widget-szerkesztő (7. szegmens) beágyazva |
| **Média** | intro/outro/megszakadt feltöltő és előnézet (5. szegmens) |
| **OBS** | Browser Source URL és beállítási táblázat (6. szegmens) |
| **Monitor és linkek** | stream-monitor, állapot-előzmény, link-gyűjtő |

Az al-oldalak önállóan is megnyithatók (`/admin/overlay`, `/admin/media`,
`/admin/obs`) — itt iframe-ként vannak befűzve, és **csak az első
megnyitáskor** töltenek be, hogy az oldal indulása gyors maradjon.

## 3. Kétirányú szinkron

Az állapot Socket.io-n érkezik (`role: admin`), tehát:

- ha a **telefonon** nyomsz Kezdést, a web UI azonnal `intro`-ra vált,
- ha a **weben** nyomsz Befejezést, a telefon is leáll (lásd 4. fejezet),
- a Szünet gomb felirata mindkét felületen „Folytatás"-ra vált, ha a session
  szünetel.

Az admin szerep a szűkített `live` nézeten felül megkapja az ingest-részleteket
és a telefon telemetriáját is ([`STATE-MACHINE.md`](STATE-MACHINE.md) 6.).

## 4. A parancscsatorna: web UI → telefon

Ez a szegmens **új irányt** nyitott a rendszerben. Eddig a telefon csak
jelzett a szervernek; a kamera-váltáshoz és a minőség-állításhoz viszont a
szervernek utasítania kell tudni a telefont.

**Ez nem csak kényelmi kérdés.** A parancscsatorna nélkül, ha az admin
megnyomja a „Befejezés"-t, a szerver ugyan lezárja a sessiont és lekapcsolja a
publishert — de a telefon app, ahol a felhasználó nem nyomott semmit, **tovább
publikálna és „ÉLŐ"-t mutatna** egy már lezárt adás alatt.

### 4.1 Szállítás: a telemetria válaszában

```
telefon ──POST /api/session/stats (3 mp-enként)──> szerver
telefon <──── { ok: true, commands: [ … ] } ─────  szerver
```

Nulla plusz kérés, legfeljebb 3 másodperc késleltetés. Aki gyorsabb reakciót
akar, külön is lekérdezheti: `GET /api/session/commands`.

### 4.2 Parancsok

| Parancs | Mit csinál a telefonon |
|---|---|
| `start` / `pause` / `resume` / `stop` | ugyanazt, mint a telefon saját gombjai |
| `setLens` | lencseváltás (`front` / `main` / `tele` / `ultra_wide`) |
| `setSource` | kamera ↔ képernyő |
| `setQuality` | felbontás, fps, videó bitráta, hang mintavétel és bitráta |
| `torch` / `photo` / `recording` | vaku, képkocka mentése, helyi felvétel |

Az Android oldalon ugyanazok a belső kezelők futnak le, mint a gombokra —
így a két felület garantáltan ugyanazt csinálja
([`ANDROID.md`](ANDROID.md), `StreamService.handleRemoteCommand`).

### 4.3 Két tudatos részlet

**Összevonás.** A beállító parancsokból (`setQuality`, `setLens`, `setSource`,
`torch`) mindig csak a **legutóbbi** marad a sorban: ha az admin tekergeti a
bitráta-csúszkát, a telefonnak nem kell minden köztes lépést lejátszania. A
session-parancsok (`start`/`pause`/`resume`/`stop`) viszont **nem** vonódnak
össze — minden felhasználói művelet külön lépés.

**Elévülés.** Egy parancs 60 másodperc után eldobódik. Egy két perce kiadott
„fotózz" utasítást értelmetlen végrehajtani, ha a telefon közben nem
jelentkezett.

### 4.4 Korlát: a képernyő-megosztás nem kényszeríthető

Az Android a `MediaProjection`-höz **felhasználói hozzájárulást** követel, amit
távolról nem lehet megkerülni. A `setSource: screen` parancs hatására a telefon
felteszi a rendszer kérdését — ha nincs ott senki, a váltás nem történik meg.
Az admin felület ezt ki is írja a gomb alatt. Kamerára visszaváltani viszont
távolról is működik.

## 5. Vezérlők a Vezérlés fülön

- **Állapot** — nagy, egyértelmű kijelzés ponttal és szöveggel, alatta a
  session azonosítója és a kontextus (pl. „szándékos szünet — csak a Folytatás
  hozza vissza", vagy az outro visszaszámlálója).
- **Kezdés / Szünet / Befejezés** — a gombok az állapot szerint tiltódnak
  (nem lehet kétszer indítani, outro közben nincs szünet), a Befejezés
  megerősítést kér.
- **Élő metrikák** — videó bitráta, fps, RTT, csomagvesztés, adásidő.
- **Előnézet** — ugyanaz a `/live` oldal, amit az OBS is mutat.
- **Kamera** — lencse-chipek, forrásváltás, vaku / kép mentése / helyi felvétel.
- **Minőség** — felbontás- és fps-chipek, videó- és hang-bitráta csúszka,
  mintavétel. A csúszkák **húzás közben nem küldenek kérést**, csak elengedéskor.

A chipek az aktuális beállítást is mutatják: amit a telefon `session/config`-ban
felküld, az kijelölve jelenik meg.

## 6. Monitor és linkek

- **Stream-monitor:** ingest elérhető-e, érkezik-e adat (és külön jelezve a
  „megállt" eset), sávok, olvasók száma, a telefon típusa és utolsó életjele,
  az aktuális capture-beállítás, a szerver állapota.
- **Állapot-előzmény:** a legutóbbi átmenetek idővel, eseménnyel és forrással
  (telefon / admin / ingest / időzítő).
- **Link-gyűjtő:** kattintásra vágólapra másolja az OBS Browser Source URL-t,
  a böngészős nézetet, a diagnosztikai változatot, az admin felületet és a
  health-checket.

Ez a fül a **9. szegmens** panelének a helye is: a részletes stream-monitor és
a letölthető napló oda tartozik — az átmenet-napló, amiből épülni fog, már
gyűlik (`data/transitions.jsonl`).

## 7. Hitelesítés

Az admin jelszó a böngésző `localStorage`-ában marad, és minden kéréshez
elmegy `X-OnLIVE-Admin-Password` fejlécben. Ez a **10. szegmensig** ideiglenes:
ott jön a munkamenet-alapú bejelentkezés, a rate limit és a sütikezelés.

## 8. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Részletes stream-monitor, letölthető napló, link-gyűjtő bővítés | 9. szegmens |
| Munkamenet-alapú admin bejelentkezés, rate limit | 10. szegmens |
| `start.bat`, telepítés, üzemeltetési futtatókörnyezet | 11. szegmens |
