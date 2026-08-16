# OnLIVE — Architektúra és komponens-felelősségek

> Ez a dokumentum a **0. szegmens** kimenete. Kötelező referencia minden további
> szegmenshez: ha egy fejlesztési lépés olyan funkciót akar beletenni egy
> komponensbe, ami az itteni felosztás szerint máshová tartozik, akkor a lépés
> **hibás** — előbb ezt a dokumentumot kell módosítani, indoklással.

## 1. Rendszer-áttekintés

Az OnLIVE egy négy komponensből álló élő közvetítő rendszer. A telefon
**kizárólag adatfolyam-forrás**; minden vezérlési, kompozíciós és megjelenítési
logika a szerveren és a web UI-n van.

```
┌─────────────────────┐
│  1) Android app     │  Kotlin, CameraX + MediaProjection
│  "OnLIVE"           │  kamera/képernyő + mikrofon → enkód → WHIP publish
└──────────┬──────────┘
           │ WHIP (HTTP/HTTPS, SDP offer/answer)
           │ + WebRTC média (SRTP/ICE — lásd docs/NETWORKING.md)
           ▼
┌─────────────────────┐
│  2) Media ingest    │  MediaMTX (self-hosted)
│                     │  WHIP be → WebRTC / RTMP / HLS ki
└──────────┬──────────┘
           │ olvasás (WebRTC/HLS) + állapot (MediaMTX API)
           ▼
┌─────────────────────┐        WebSocket (Socket.io)
│  3) Vezérlő szerver │◄──────────────────────────────┐
│  Node.js + Express  │  állapotgép, overlay-kompozíció,│
│  + Socket.io        │  admin API, JSON/lowdb tárolás  │
└──────────┬──────────┘                                │
           │ HTTP + WS                                  │
           ▼                                            │
┌─────────────────────┐                                │
│  4) Web UI          │  /admin  → vezérlőfelület ──────┘
│                     │  /live   → kompozit lejátszó (OBS Browser Source)
└─────────────────────┘
```

## 2. Komponensek és felelősségi körük

### 2.1 Android app (Kotlin)

**Technológia:** Kotlin, CameraX (kamera), MediaProjection API (képernyő),
WebRTC natív stack, WHIP publish.

**Felelős ezért:**

- Kamera-kép és/vagy képernyő-tartalom capture-je.
- Mikrofon (és képernyőmegosztásnál rendszerhang, ahol az OS engedi) capture-je.
- Videó/audió kódolás (H.264 / Opus), bitrate- és felbontás-kezelés.
- WHIP publish a fix, publikus ingest URL-re, streamkulccsal.
- Minimális UI: **Kezdés** / **Szünet** / **Befejezés** gomb, kapcsolat-állapot
  kijelzés, lencse-választó (Előlapi / Fő / Tele / Nagylátószögű), kamera↔képernyő
  váltás, felbontás-, fps-, bitrate- és hangminőség-választó.
- Kényelmi funkciók, amik nem érintik a stream folytonosságát: vaku,
  aktuális képkocka mentése a galériába, párhuzamos helyi MP4-rögzítés.
- Háttérfutás: Foreground Service + wakelock + akkumulátor-optimalizálás
  kizárás + gyártói (Samsung) háttérkorlátozás-instrukció; PIP mint kiegészítő.
- Újracsatlakozási logika hálózatvesztés esetén (exponenciális backoff).
- A szervertől kapott állapot **megjelenítése** (pl. „adásban”, „szüneteltetve”).
- A vezérlő szervertől kapott **parancsok végrehajtása** (a web UI-ról indított
  kamera-váltás, minőség-állítás, Befejezés) — ugyanazokkal a belső kezelőkkel,
  mint a saját gombjai.

Megvalósítás és a technikai döntések indoklása:
**[`docs/ANDROID.md`](docs/ANDROID.md)** (2. szegmens), forrás: [`android/`](android).

**Kifejezetten NEM felelős ezért (tudatos döntés — ne kerüljön bele):**

- ❌ Overlay, logó, alsó csík, chat-megjelenítés.
- ❌ Intro / outro / „megszakadt az adás” állókép vagy videó.
- ❌ Kompozíció, jelenetváltás, képvágás.
- ❌ Felvétel-kezelés, archiválás.
- ❌ Bármilyen üzleti/állapotgép-logika azon túl, hogy „küldök vagy nem küldök”.

**Alkalmazásnév:** az app label (`strings.xml` → `app_name`) értéke **`OnLIVE`**.

### 2.2 Media ingest réteg (MediaMTX)

**Technológia:** MediaMTX (self-hosted, a vezérlő szerverrel azonos gépen).

**Felelős ezért:**

- WHIP végpont kiszolgálása (a telefon ide publikál).
- A bejövő stream továbbszolgáltatása több protokollon:
  WebRTC (WHEP) a web UI-nak, RTMP/HLS az OBS-nek és tartalék útvonalnak.
- Stream-állapot közzététele a saját HTTP API-ján keresztül (van-e aktív
  publisher, hány olvasó van) — ezt a vezérlő szerver kérdezi le.
- Ingest-hitelesítés (streamkulcs / útvonal-szintű jogosultság).

Megvalósítás és a figyelési szerződés (webhook + API-poll, „megállt vs.
megszakadt" megkülönböztetés): **[`docs/INGEST.md`](docs/INGEST.md)**
(3. szegmens), konfiguráció: [`infra/mediamtx/`](infra/mediamtx/).

**Kifejezetten NEM felelős ezért:**

- ❌ Overlay-kompozíció, grafika, transzkódolás üzleti célból.
- ❌ Állapotgép (intro/outro/megszakadás) — ez a vezérlő szerver dolga.
- ❌ Felhasználói felület.

### 2.3 Vezérlő szerver (Node.js + Express + Socket.io)

**Technológia:** Node.js, Express, Socket.io, fájl-alapú tárolás
(JSON / lowdb) — külön adatbázis-szerver nélkül.

**Felelős ezért:**

- **Állapotgép:** `OFFLINE → INTRO → LIVE → INTERRUPTED → LIVE → OUTRO → OFFLINE`,
  továbbá `LIVE ↔ PAUSED` (szándékos, felhasználó által kért szünet).
  Az állapotátmenetek egyetlen forrása; mind a telefon, mind a web UI ebből él.
  A `PAUSED` vizuálisan ugyanaz, mint az `INTERRUPTED` („Megszakadt” képernyő),
  de nem indít visszatérés-várakozást — csak a „Folytatás” gomb hozza vissza
  (lásd [`docs/ANDROID.md`](docs/ANDROID.md) 6.1).
  Megvalósítás és diagram: **[`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md)**.
- **Session-API a telefonnak:** `POST /api/session/start | pause | resume | end |
  config | stats`, streamkulcsos Bearer hitelesítéssel. Az app ezeken keresztül
  csak jelez; hogy ebből intro, outro vagy „Megszakadt” képernyő lesz-e, azt
  kizárólag ez az állapotgép dönti el.
- **Adás-felügyelet:** a MediaMTX állapotának figyelése, a publisher elvesztésének
  detektálása → automatikus `INTERRUPTED` állapot, visszatéréskor `LIVE`.
- **Overlay-kompozíció leírása:** melyik widget (logó, beágyazás, szöveg,
  értesítés) látszik, hol, milyen tartalommal. A szerver ezt **állapotként**
  adja ki; a tényleges renderelés a `/live` oldalon, böngészőben történik.
  A third-party beágyazások sandboxolt iframe-ben futnak, saját kulccsal —
  soha nem látják a szülő oldal DOM-ját és a tokeneket
  (**[`docs/WIDGETS.md`](docs/WIDGETS.md)**, 7. szegmens).
- **Médiatár:** az intro/outro/megszakadt kép vagy videó tárolása, tartalom-alapú
  típus-validációval, és az outro hosszának kezelése
  (**[`docs/OVERLAY-MEDIA.md`](docs/OVERLAY-MEDIA.md)**, 5. szegmens).
- **Admin API:** start/stop, intro/outro indítás, widgetek kapcsolása,
  szövegek/értesítések küldése, beállítások mentése.
- **Eszköz-parancscsatorna:** a web UI-ról indított műveletek (kamera-váltás,
  minőség, Befejezés) eljuttatása a telefonhoz a telemetria válaszában
  (**[`docs/ADMIN-UI.md`](docs/ADMIN-UI.md)**, 8. szegmens). Enélkül az app
  tovább publikálna egy weben lezárt adás alatt.
- **WebSocket állapot-szinkron:** minden csatlakozott kliens (telefon, admin UI,
  `/live` oldal) valós időben megkapja az aktuális állapotot.
- **Hitelesítés és jogosultság:** három elkülönített szint — admin
  (munkamenet-süti, CSRF, sebességkorlát), telefon (streamkulcs), néző
  (opcionális, **csak megtekintésre** jó lejátszási token).
  Részletek: **[`docs/SECURITY.md`](docs/SECURITY.md)** (10. szegmens).
- **Naplózás és jelentés:** minden állapotátmenet és 3 másodpercenként a
  telemetria fájlba írása, ebből időszakos (élő/kiesés) jelentés és letölthető
  CSV (**[`docs/MONITORING.md`](docs/MONITORING.md)**, 9. szegmens).
- **Statikus kiszolgálás:** az admin UI, a `/live` oldal és a `/links`
  link-gyűjtő kiszolgálása.
- **Lejátszás-proxy:** WHEP és HLS továbbítása a MediaMTX felé, hogy a
  böngésző egyetlen originnel beszéljen, és a MediaMTX olvasási joga
  localhostra szorítva maradhasson (6. szegmens).
- **Indítási visszajelzés:** a `start.bat`-tal indított konzolban keretezett
  „OnLIVE szerver elindult” üzenet az elérhető URL-ekkel, és **minden esemény
  egyetlen, strukturált naplóba** kerül — forrással (telefon / web UI / OBS /
  ingest) és kliens-azonosítóval együtt
  (**[`docs/OPERATIONS.md`](docs/OPERATIONS.md)**, 11. szegmens).

**Kifejezetten NEM felelős ezért:**

- ❌ Média-transzkódolás, videófolyam-manipuláció (ezt a MediaMTX / a böngésző végzi).
- ❌ Pixel-szintű renderelés — a szerver csak leírja, mit kell rajzolni.

### 2.4 Web UI

Két, egymástól élesen elváló felület, azonos szerverről kiszolgálva:

#### a) Admin / vezérlő felület — `admin.galandras.com`

- Jelszóval védett.
- Aktuális állapot, előnézet, kapcsolat- és minőség-metrikák (bitrate, FPS,
  csomagvesztés, késleltetés).
- Vezérlés: intro/outro indítás, adás leállítása, widget-elrendezés szerkesztése,
  értesítések küldése.
- HTML `<title>`: **`OnLIVE — Admin`**.

#### b) Kompozit lejátszó — `live.galandras.com/live`

- **Ez az egyetlen hely, ahol a végleges kép összeáll:** élő videó + overlay
  rétegek + intro/outro/megszakadás-képernyő.
- Úgy van megtervezve, hogy **OBS Browser Source-ként** is működjön
  (átlátszó háttér opció, nincs benne interaktív vezérlőelem, nincs görgetősáv),
  és önálló weblejátszóként is megnyitható legyen.
- Az állapotot WebSocketen kapja; nem kérdezget, nem dönt — csak renderel.
- Fix **1920×1080-as vászon**, a Browser Source ablakához skálázva; a háttér
  alapból átlátszó. Az élő videó WHEP-en (HLS tartalékkal), a vezérlő szerver
  proxyján keresztül érkezik (**[`docs/OBS.md`](docs/OBS.md)**, 6. szegmens).
- HTML `<title>`: **`OnLIVE`** (vagy `OnLIVE — Live`).

## 3. Névhasználat (kötelező minden felületen)

| Hely | Elvárt érték |
|---|---|
| Android app label (`strings.xml` → `app_name`) | `OnLIVE` |
| Admin oldal `<title>` | `OnLIVE — Admin` |
| `/live` oldal `<title>` | `OnLIVE` |
| Szerver konzol indító üzenet | keretezett / ASCII-art `OnLIVE` + URL-lista |
| Windows service-ek, mappanevek, log-fájlok | `onlive-*` előtag |

## 4. Adatáramlás — kritikus útvonalak

1. **Média:** Telefon → (WHIP) → MediaMTX → (WHEP/HLS) → `/live` oldal → (Browser
   Source) → OBS.
2. **Vezérlés:** Admin UI → (HTTP POST) → vezérlő szerver → (WebSocket) →
   `/live` oldal + telefon.
3. **Állapot-visszajelzés:** MediaMTX API → vezérlő szerver (poll/hook) →
   (WebSocket) → minden kliens.

A média- és a vezérlési út **szándékosan külön** fut: ha a vezérlő szerver
újraindul, a média nem szakad meg; ha a média szakad meg, a vezérlő szerver
ettől még tudja megjeleníteni a „megszakadt az adás” képernyőt.

## 5. Hálózati elérhetőség (röviden)

A szerver otthoni gépen, NAT mögött fut; a telefon soha nincs ugyanazon a
hálózaton. Ezért **kifelé induló alagút** (Cloudflare Tunnel) ad fix, publikus
HTTPS/WSS URL-eket, port-forwarding és dinamikus DNS nélkül:

| Subdomain | Cél | Védelem |
|---|---|---|
| `admin.galandras.com` | admin/vezérlő UI | jelszó |
| `live.galandras.com` | `/live` kompozit lejátszó | nyilvános / opcionális token |
| `ingest.galandras.com` | WHIP ingest | streamkulcs |

Részletek, konfiguráció, watchdog és a WebRTC-médiaút buktatói:
**[`docs/NETWORKING.md`](docs/NETWORKING.md)** (1. szegmens).

## 6. Könyvtárszerkezet (célállapot)

```
OnLIVE/
├── ARCHITECTURE.md            # ez a fájl (0. szegmens)
├── docs/
│   ├── NETWORKING.md          # 1. szegmens — hálózat, tunnel, watchdog
│   ├── ANDROID.md             # 2. szegmens — capture, publish, háttérfutás
│   ├── INGEST.md              # 3. szegmens — MediaMTX, kimenetek, figyelés
│   ├── STATE-MACHINE.md       # 4. szegmens — állapotgép, események, API
│   ├── OVERLAY-MEDIA.md       # 5. szegmens — intro/outro/megszakadt média
│   ├── OBS.md                 # 6. szegmens — Browser Source, WHEP/HLS lejátszás
│   ├── WIDGETS.md             # 7. szegmens — widgetek, szerkesztő, sandbox
│   ├── ADMIN-UI.md            # 8. szegmens — admin felület, parancscsatorna
│   ├── MONITORING.md          # 9. szegmens — monitor, napló, link-gyűjtő
│   ├── SECURITY.md            # 10. szegmens — jogosultságok, bejelentkezés
│   └── OPERATIONS.md          # 11. szegmens — telepítés, indítás, napló, tesztterv
├── infra/
│   ├── cloudflared/
│   │   ├── config.example.yml # tunnel konfiguráció sablon
│   │   └── README.md          # telepítési gyorstalpaló
│   └── mediamtx/
│       ├── mediamtx.example.yml   # ingest konfiguráció sablon
│       ├── install-mediamtx.ps1   # telepítő + indítási ütemezett feladat
│       ├── ingest-probe.ps1       # health-check / állapot-lekérdezés
│       └── hooks/                 # runOnReady / runOnNotReady webhookok
├── scripts/
│   ├── tunnel-watchdog.ps1        # alagút-figyelő + automatikus restart
│   └── install-tunnel-watchdog.ps1# ütemezett feladat regisztrálása
├── start.bat                  # egy kattintás: tunnel → MediaMTX → szerver (11. szegmens)
├── logs/                      # startup.log — a .bat indítási/leállási sorai
├── server/                    # vezérlő szerver (4. szegmens)
│   ├── src/state/             # ★ machine.js (tiszta), controller.js, store.js
│   ├── src/ingest/            # monitor.js (poll, debounce) + control.js (kick)
│   ├── src/media/             # média-tár és tartalom-alapú validáció
│   ├── src/overlay/           # widgetek: pozíció, láthatóság, beágyazás-kulcsok
│   ├── src/device/            # web UI → telefon parancssor és jelenlét
│   ├── src/log/               # ★ logger.js (egységes JSON napló) + metrika és CSV
│   ├── src/links/             # chat-link gyűjtő
│   ├── src/security/          # jelszó-hash, munkamenetek, sebességkorlát
│   ├── src/api/               # session / ingest / admin végpontok, hitelesítés
│   ├── src/realtime/socket.js # Socket.io — állapot-szinkron minden klienshez
│   ├── src/web/               # /live kompozit oldal + média-admin oldal
│   ├── tools/start.js         # az `npm start` indítója (függő folyamatok ellenőrzése)
│   ├── logs/                  # YYYY-MM-DD.log — soronként egy JSON esemény
│   └── test/                  # egységtesztek + a 4 kötelező forgatókönyv
└── android/                   # OnLIVE Android app (2. szegmens)
    └── app/src/main/java/com/galandras/onlive/
        ├── MainActivity.kt    # CSAK UI + engedélyek + PIP
        ├── stream/            # StreamService (FGS), capture-források, állapotbusz
        ├── webrtc/            # RtcEngine, WhipClient, SdpUtils
        ├── net/               # ControlApi (session-jelzések)
        ├── settings/          # DataStore + minőségi enumok
        ├── ui/                # Compose felület
        └── util/              # notification, háttér-engedélyek, torch
```

## 7. Szegmens-térkép

A teljes, előre rögzített szegmens-lista. A `Verzió` oszlop a kiadás-jelölés:
az *N*. szegmens a **0.N** verzió, a lezáró kiadás pedig az **1.0.000**
(lásd [`CHANGELOG.hu.md`](CHANGELOG.hu.md)).

| # | Verzió | Szegmens | Elsődleges komponens | Állapot |
|---|---|---|---|---|
| 0 | 0.1 | Architektúra és komponens-felelősségek | — (ez a dokumentum) | ✅ kész |
| 1 | 0.1 | Hálózati réteg és elérhetőség | infra | ✅ kész |
| 2 | 0.2 | Android alkalmazás: capture és publish | Android | ✅ kész |
| 3 | 0.3 | Media ingest réteg beállítása | ingest | ✅ kész |
| 4 | 0.4 | Vezérlő szerver: állapotgép | szerver | ✅ kész |
| 5 | 0.5 | Overlay- és médiakezelés (intro/outro/megszakadt) | szerver / web | ✅ kész |
| 6 | 0.6 | OBS integráció (Browser Source) | web | ✅ kész |
| 7 | 0.7 | Widget rendszer (logó / chat / értesítés, drag-and-drop) | web | ✅ kész |
| 8 | 0.8 | Web UI: admin/vezérlő felület | web | ✅ kész |
| 9 | 0.9 | Stream-monitor, letölthető napló és link-gyűjtő | szerver / web | ✅ kész |
| 10 | 0.10 | Biztonság és hitelesítés | szerver | ✅ kész |
| 11 | 0.11 | Telepítés, üzemeltetés, tesztelési terv | szerver / infra | ✅ kész |

A tizenegy szegmenssel az alap szakasz lezárult: a kiadás az **1.0.000**
([`versions.onlive`](versions.onlive)).
