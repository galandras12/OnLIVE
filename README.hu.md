# OnLIVE

**1.0.103 verzió** · [Changelog](CHANGELOG.hu.md) · [In English](README.md)

Élő közvetítő rendszer: Android telefonról (kamera/képernyő + hang) induló adás,
amit WHIP-en keresztül egy self-hosted szerver fogad, intro/outro/megszakadás-
logikával és overlay-jel (logó, chat, értesítés) lát el, majd OBS Browser
Source-ként és közvetlen weblejátszóként is kiszolgál.

**Alapelv:** a telefon kizárólag adatfolyam-forrás — minden vezérlési logika a
szerveren és a web UI-n van.

## 1.0 verzió

Az 1.0 lezárta a projekt alap szakaszát: a tervezett tizenegy szegmens
(`0.1` – `0.11`) elkészült, tehát a rendszer végponttól végpontig használható —
a telefonon megnyomott „Kezdés"-től a kompozit kép OBS-ben való megjelenéséig,
naplózással, hitelesítéssel és dokumentált tesztelési tervvel.

Az **1.0.010** hozza a streamkulcs webes kezelését (ott jön létre, és csak a
scrypt hash-e tárolódik), valamint az Android app fogaskereke mögötti valódi
beállítás-képernyőt, ahol a kulcsot és a Tunnel címeit meg lehet adni.

Az **1.0.011** a szerver portját teszi a webes felületről állíthatóvá — a
következő indításkor lép életbe —, és az alapértelmezést **8080**-ra viszi. Az
**1.0.012** javítja a `start.bat`-ot, ami eddig felvillant és eltűnt, és
lépésenkénti kiírást ad neki.

A szegmensenkénti történet a [`CHANGELOG.hu.md`](CHANGELOG.hu.md) fájlban van, a
géppel olvasható verziószám pedig a [`versions.onlive`](versions.onlive)-ban.

## Komponensek

1. **Android app** (Kotlin, CameraX + MediaProjection + WebRTC) — capture,
   kódolás, WHIP publish.
2. **Media ingest** (MediaMTX) — WHIP be, WebRTC / RTMP / HLS ki.
3. **Vezérlő szerver** (Node.js + Express + Socket.io, fájl-alapú JSON tárolás) —
   állapotgép, overlay-kompozíció, admin API.
4. **Web UI** — az `/admin` vezérlőfelület és a `/live` kompozit lejátszó
   (OBS Browser Source).

## Publikus végpontok

```
Admin UI     : https://admin.galandras.com/admin    (fülek: vezérlés, overlay, média, OBS, monitor)
Live / OBS   : https://live.galandras.com/live      (Browser Source, 1920x1080)
Chat-linkek  : https://live.galandras.com/links     (mobilra, egy koppintás)
WHIP ingest  : https://ingest.galandras.com/<stream>/whip
```

Mindegyik egyetlen Cloudflare Tunnelen keresztül érhető el — nincs
port-forwarding, nincs dinamikus DNS, és a címek IP-váltás vagy újraindítás után
sem változnak.

## Első lépések

**Dupla kattintás a `config.bat`-ra.** A beállító varázsló sorban, egyesével
végigkérdezi azt, amiről tényleg dönteni kell, és maga írja be a helyükre:

```
[1/9] szerver port       -> .env + server/data/server.json
[2/9] admin jelszó       -> scrypt hash; a jelszó maga sehova nem kerül
[3/9] streamkulcs        -> server/data/stream-key.json, hash-elve
[4/9] a /live védelme    -> generált lejátszási token, vagy nyilvános
[5/9] publikus domain    -> a három tunnel-cím
[6/9] stream útvonal     -> a WHIP cím, amit a telefon hív
[7/9] MediaMTX helye     -> .env
[8/9] tunnel service     -> .env
[9/9] hook titok         -> .env + infra/mediamtx/hooks/hook-env.bat
```

Semmit nem ír, amíg a végén az összefoglalóra rá nem bólintasz, a korábbi
`.env`-ről mentés készül (`.env.bak`), az ENTER pedig mindenhol a jelenlegi
értéket hagyja — tehát bármikor újrafuttatható, ha csak egyetlen dolgot akarsz
átállítani. `npm install` sem kell hozzá: csak a Node beépített moduljait
használja.

Körülötte, sorrendben:

```powershell
# 1) hálózat: fix, publikus URL-ek NAT mögül
#    docs/NETWORKING.md → 4. fejezet (cloudflared telepítése)

# 2) media ingest: a telefon ide publikál
#    docs/INGEST.md → 6. fejezet
cd infra\mediamtx
powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1

# 3) vezérlő szerver
cd ..\..\server
npm install
npm test
npm start
```

A streamkulcsot a varázsló a végén **egyszer** kiírja. Ezt írd be a telefonon a
fogaskerék mögötti **Kapcsolat** szekcióba — a szerver csak a hash-ét tárolja.
Később a webes felületen is létrehozható vagy cserélhető: **Admin → Streamkulcs**.

## Az admin jelszó beállítása

Ezzel lépsz be az `/admin` felületre. Alapértelmezett jelszó **nincs**: amíg nem
állítasz be egyet, **az admin felület csak magáról a gépről válaszol**
(localhost) — egy félkonfigurált rendszer ne álljon nyitva a publikus címen.

**A rövid út a `config.bat`**, annak a 2. lépése: kétszer bekéri a jelszót (a
gépelés nem látszik), minősíti az erősségét, hash-eli, és beírja a `.env`-be —
fájlt sem kell megnyitnod. Az alábbi kézi út pontosan ugyanezt csinálja.

**1. Készítsd el a hash-t** (a `server` könyvtárban, idézőjelben a saját
jelszavaddal):

```powershell
cd server
npm run hash-password -- "egy hosszu sajat jelszo"
```

Kiír egy sort:

```
ONLIVE_ADMIN_PASSWORD_HASH=scrypt$16384$8$1$DLTHAcA8J5gUQnAdVIGZtg==$kwqOkiDHIas...
```

**2. Másold ezt a sort a `.env` fájlba** a projekt gyökerében (ha még nincs,
hozd létre a `.env.example`-ből), az üres `ONLIVE_ADMIN_PASSWORD_HASH=` sor
helyére. Az `ONLIVE_ADMIN_PASSWORD` sort pedig töröld.

**3. Indítsd újra a szervert** (`start.bat`, vagy `Ctrl+C` és `npm start`). A
`.env` beállításait a szerver induláskor olvassa be.

**4. Lépj be**: nyisd meg a `http://localhost:8080/admin` címet — átdob a
bejelentkező oldalra, ahol magát a jelszót írod be, nem a hash-t.

Amit érdemes tudni:

- **Csak a hash tárolódik**, tehát a `.env` kiszivárgása nem ad azonnal
  használható jelszót. A sima `ONLIVE_ADMIN_PASSWORD=…` kényelmi okból továbbra
  is működik, de a szerver minden indításkor figyelmeztet rá.
- **Legalább 12 karakter** legyen. Az eszköz szól, ha rövid vagy közismert
  jelszót adsz meg, a szerver pedig induláskor és az admin fejlécében
  („védelem" jelző) is jelzi a gyenge titkokat.
- **Elfelejtetted?** Semmi nem kötődik a régihez: csinálj új hash-t ugyanígy,
  cseréld a sort, indítsd újra. A már belépett munkameneteket a lejáratukig
  megtartja — az admin felület **Biztonság** része egyben ki is tudja léptetni
  mindet.
- A jelszó csak a webes felülethez kell. A telefon a **streamkulccsal**
  hitelesít, ezt a jelszót sosem látja.

Ezek után a napi indítás egyetlen mozdulat: **`start.bat`** a projekt gyökerében
(tunnel-ellenőrzés → MediaMTX → vezérlő szerver, nyitva maradó konzollal).
Részletek: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Dokumentáció

| Dokumentum | Tartalom |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | a 4 komponens és szigorúan elkülönített felelősségi köreik |
| [`docs/NETWORKING.md`](docs/NETWORKING.md) | **0.1** — Cloudflare Tunnel, subdomainek, watchdog, WebRTC-médiaút |
| [`docs/ANDROID.md`](docs/ANDROID.md) | **0.2** — capture, WHIP publish, háttérfutás, reconnect |
| [`android/`](android/) | az OnLIVE Android app forrása |
| [`docs/INGEST.md`](docs/INGEST.md) | **0.3** — MediaMTX, kimeneti formátumok, ingest-figyelés, health-check |
| [`infra/mediamtx/`](infra/mediamtx/) | MediaMTX konfiguráció, hookok, telepítő és ingest-próba |
| [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md) | **0.4** — állapotgép, a 2 perces szabály, Socket.io események, API |
| [`server/`](server/) | a vezérlő szerver forrása |
| [`docs/OVERLAY-MEDIA.md`](docs/OVERLAY-MEDIA.md) | **0.5** — intro/outro/megszakadt média, validáció, előnézet |
| [`docs/OBS.md`](docs/OBS.md) | **0.6** — Browser Source beállítás, átlátszó vászon, WHEP/HLS lejátszás |
| [`docs/WIDGETS.md`](docs/WIDGETS.md) | **0.7** — widgetek, drag-and-drop szerkesztő, sandboxolt beágyazások |
| [`docs/ADMIN-UI.md`](docs/ADMIN-UI.md) | **0.8** — admin felület, design tokenek, web→telefon parancscsatorna |
| [`docs/MONITORING.md`](docs/MONITORING.md) | **0.9** — stream-monitor, letölthető CSV napló, chat-link gyűjtő |
| [`docs/SECURITY.md`](docs/SECURITY.md) | **0.10** — jogosultsági szintek, bejelentkezés, streamkulcs, CSRF |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | **0.11** — telepítés, indítás, naplózás, tesztelési terv, hibaelhárítás |
| [`infra/cloudflared/`](infra/cloudflared/) | tunnel `config.yml` sablon + telepítési gyorstalpaló |
| [`scripts/`](scripts/) | tunnel watchdog és annak ütemezett feladatként való regisztrálása |

## Verziótörténet

| Verzió | Szegmens | Cím |
|---|---|---|
| [`0.1`](CHANGELOG.hu.md#01--architektúra-és-hálózati-réteg) | 1. | Architektúra és hálózati réteg |
| [`0.2`](CHANGELOG.hu.md#02--android-alkalmazás-capture-és-publish) | 2. | Android alkalmazás: capture és publish |
| [`0.3`](CHANGELOG.hu.md#03--media-ingest-réteg) | 3. | Media ingest réteg |
| [`0.4`](CHANGELOG.hu.md#04--vezérlő-szerver-az-állapotgép) | 4. | Vezérlő szerver: az állapotgép |
| [`0.5`](CHANGELOG.hu.md#05--overlay--és-médiakezelés) | 5. | Overlay- és médiakezelés |
| [`0.6`](CHANGELOG.hu.md#06--obs-integráció) | 6. | OBS integráció |
| [`0.7`](CHANGELOG.hu.md#07--widget-rendszer) | 7. | Widget rendszer |
| [`0.8`](CHANGELOG.hu.md#08--admin-web-felület) | 8. | Admin web felület |
| [`0.9`](CHANGELOG.hu.md#09--stream-monitor-napló-és-linkek) | 9. | Stream-monitor, napló és linkek |
| [`0.10`](CHANGELOG.hu.md#010--biztonság-és-hitelesítés) | 10. | Biztonság és hitelesítés |
| [`0.11`](CHANGELOG.hu.md#011--telepítés-üzemeltetés-tesztelési-terv) | 11. | Telepítés, üzemeltetés, tesztelési terv |
| [`1.0.000`](CHANGELOG.hu.md#10000--az-alap-szakasz-lezárása) | — | **Az alap szakasz lezárása** |
| [`1.0.010`](CHANGELOG.hu.md#10010--streamkulcs-a-webes-felületen-kapcsolat-beállítás-a-telefonon) | — | Streamkulcs a webes felületen, kapcsolat-beállítás a telefonon |
| [`1.0.011`](CHANGELOG.hu.md#10011--állítható-szerver-port-új-alapértelmezés-8080) | — | Állítható szerver-port, új alapértelmezés: 8080 |
| [`1.0.012`](CHANGELOG.hu.md#10012--startbat-az-eltűnő-ablak-javítása-lépésenkénti-kiírás) | — | start.bat: az eltűnő ablak javítása, lépésenkénti kiírás |
| [`1.0.013`](CHANGELOG.hu.md#10013--végre-van-kamerakép-és-a-lencseváltás-is-működik) | — | Végre van kamerakép, és a lencseváltás is működik |
| [`1.0.014`](CHANGELOG.hu.md#10014--16-kb-os-lapméret-rögzített-eszközlánc) | — | 16 KB-os lapméret, rögzített eszközlánc |
| [`1.0.015`](CHANGELOG.hu.md#10015--compilesdk-36-hogy-az-új-könyvtárak-leforduljanak) | — | compileSdk 36, hogy az új könyvtárak leforduljanak |
| [`1.0.016`](CHANGELOG.hu.md#10016--a-sárga-háromszögek-a-sync-naplóban) | — | A sárga háromszögek a sync-naplóban |
| [`1.0.017`](CHANGELOG.hu.md#10017--configbat-a-beállítás-többé-nem-fájlszerkesztés) | — | `config.bat`: a beállítás többé nem fájlszerkesztés |
| [`1.0.018`](CHANGELOG.hu.md#10018--feloldatlan-merge-konfliktus-a-gradleproperties-ben) | — | Feloldatlan merge-konfliktus a `gradle.properties`-ben |
| [`1.0.019`](CHANGELOG.hu.md#10019--a-404-ami-nem-a-szerverről-szólt) | — | A 404, ami nem a szerverről szólt |
| [`1.0.101`](CHANGELOG.hu.md#10101--álló-és-fekvő-adás-lencse-csúszka-helyi-útvonal) | — | Álló és fekvő adás, lencse-csúszka, helyi útvonal |
| [`1.0.102`](CHANGELOG.hu.md#10102--kölcsönös-visszajelzés-melyik-láb-áll-és-miért) | — | Kölcsönös visszajelzés: melyik láb áll, és miért |
| [`1.0.103`](CHANGELOG.hu.md#10103--az-ingest-alap-címben-bennfelejtett-útvonal) | — | Az ingest alap-címben bennfelejtett útvonal |
