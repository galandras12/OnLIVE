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
- Minimális UI: **Kezdés** / **Befejezés** gomb, kapcsolat-állapot kijelzés,
  kamera-választó (elő/hátsó/képernyő), felbontás- és bitrate-választó.
- Újracsatlakozási logika hálózatvesztés esetén (részletek: 3. szegmens).
- A szervertől WebSocketen kapott állapot **megjelenítése** (pl. „adásban”,
  „intro megy”, „a vezérlő leállította”).

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

**Kifejezetten NEM felelős ezért:**

- ❌ Overlay-kompozíció, grafika, transzkódolás üzleti célból.
- ❌ Állapotgép (intro/outro/megszakadás) — ez a vezérlő szerver dolga.
- ❌ Felhasználói felület.

### 2.3 Vezérlő szerver (Node.js + Express + Socket.io)

**Technológia:** Node.js, Express, Socket.io, fájl-alapú tárolás
(JSON / lowdb) — külön adatbázis-szerver nélkül.

**Felelős ezért:**

- **Állapotgép:** `OFFLINE → INTRO → LIVE → INTERRUPTED → LIVE → OUTRO → OFFLINE`.
  Az állapotátmenetek egyetlen forrása; mind a telefon, mind a web UI ebből él.
- **Adás-felügyelet:** a MediaMTX állapotának figyelése, a publisher elvesztésének
  detektálása → automatikus `INTERRUPTED` állapot, visszatéréskor `LIVE`.
- **Overlay-kompozíció leírása:** melyik widget (logó, chat, értesítés, alsó csík)
  látszik, hol, milyen tartalommal. A szerver ezt **állapotként** adja ki; a
  tényleges renderelés a `/live` oldalon, böngészőben történik.
- **Admin API:** start/stop, intro/outro indítás, widgetek kapcsolása,
  szövegek/értesítések küldése, beállítások mentése.
- **WebSocket állapot-szinkron:** minden csatlakozott kliens (telefon, admin UI,
  `/live` oldal) valós időben megkapja az aktuális állapotot.
- **Hitelesítés és jogosultság:** admin jelszó, ingest streamkulcs kiadása/ellenőrzése
  (részletek: 9. szegmens).
- **Statikus kiszolgálás:** az admin UI és a `/live` oldal kiszolgálása.
- **Indítási visszajelzés:** a `start.bat`-tal indított konzolban keretezett
  „OnLIVE szerver elindult” üzenet az elérhető URL-ekkel (11. szegmens).

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
│   └── NETWORKING.md          # 1. szegmens — hálózat, tunnel, watchdog
├── infra/
│   └── cloudflared/
│       ├── config.example.yml # tunnel konfiguráció sablon
│       └── README.md          # telepítési gyorstalpaló
├── scripts/
│   ├── tunnel-watchdog.ps1        # alagút-figyelő + automatikus restart
│   └── install-tunnel-watchdog.ps1# ütemezett feladat regisztrálása
├── server/                    # vezérlő szerver (későbbi szegmens)
├── web/                       # admin UI + /live oldal (későbbi szegmens)
└── android/                   # OnLIVE Android app (későbbi szegmens)
```

## 7. Szegmens-térkép

| Szegmens | Tartalom | Elsődleges komponens |
|---|---|---|
| 0 | Architektúra, felelősségi körök | — (ez a dokumentum) |
| 1 | Hálózati réteg, Cloudflare Tunnel, watchdog | infra |
| 2 | Media ingest (MediaMTX) beállítás | ingest |
| 3 | Android app, capture + WHIP + reconnect | Android |
| 4+ | Vezérlő szerver, állapotgép, overlay, admin UI | szerver / web |
| 9 | Jogosultsági szintek, hitelesítés | szerver |
| 11 | Telepítés, `start.bat`, konzol üdvözlő üzenet | szerver / infra |
