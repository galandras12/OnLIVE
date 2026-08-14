# OnLIVE

Élő közvetítő rendszer: Android telefonról (kamera/képernyő + hang) induló
adás, amit egy self-hosted szerver fogad, intro/outro/megszakadás-logikával és
overlay-jel (logó, chat, értesítés) lát el, majd OBS Browser Source-ként és
közvetlen weblejátszóként is kiszolgál.

**Alapelv:** a telefon kizárólag adatfolyam-forrás — minden vezérlési logika a
szerveren és a web UI-n van.

## Dokumentáció

| Dokumentum | Tartalom |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **0. szegmens** — a 4 komponens és szigorúan elkülönített felelősségi köreik |
| [`docs/NETWORKING.md`](docs/NETWORKING.md) | **1. szegmens** — Cloudflare Tunnel, subdomainek, watchdog, WebRTC-médiaút |
| [`docs/ANDROID.md`](docs/ANDROID.md) | **2. szegmens** — capture, WHIP publish, háttérfutás, reconnect |
| [`android/`](android/) | az OnLIVE Android app forrása (Kotlin, CameraX + MediaProjection + WebRTC) |
| [`docs/INGEST.md`](docs/INGEST.md) | **3. szegmens** — MediaMTX, kimeneti formátumok, ingest-figyelés, health-check |
| [`infra/mediamtx/`](infra/mediamtx/) | MediaMTX konfiguráció, hookok, telepítő és ingest-próba |
| [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md) | **4. szegmens** — állapotgép, a 2 perces szabály, Socket.io események, API |
| [`server/`](server/) | a vezérlő szerver forrása (Node.js + Express + Socket.io) |
| [`docs/OVERLAY-MEDIA.md`](docs/OVERLAY-MEDIA.md) | **5. szegmens** — intro/outro/megszakadt média, validáció, előnézet |
| [`docs/OBS.md`](docs/OBS.md) | **6. szegmens** — Browser Source beállítás, átlátszó vászon, WHEP/HLS lejátszás |
| [`docs/WIDGETS.md`](docs/WIDGETS.md) | **7. szegmens** — widgetek, drag-and-drop szerkesztő, sandboxolt beágyazások |
| [`docs/ADMIN-UI.md`](docs/ADMIN-UI.md) | **8. szegmens** — admin felület, design tokenek, web→telefon parancscsatorna |
| [`infra/cloudflared/`](infra/cloudflared/) | tunnel `config.yml` sablon + telepítési gyorstalpaló |
| [`scripts/`](scripts/) | tunnel watchdog és annak ütemezett feladatként való regisztrálása |

## Komponensek

1. **Android app** (Kotlin, CameraX + MediaProjection) — capture, kódolás, WHIP publish.
2. **Media ingest** (MediaMTX) — WHIP be, WebRTC/RTMP/HLS ki.
3. **Vezérlő szerver** (Node.js + Express + Socket.io, fájl-alapú JSON/lowdb) — állapotgép, overlay-kompozíció, admin API.
4. **Web UI** — `/admin` vezérlőfelület és `/live` kompozit lejátszó (OBS Browser Source).

## Publikus végpontok

```
Admin UI     : https://admin.galandras.com/admin    (fülek: vezérlés, overlay, média, OBS, monitor)
Live / OBS   : https://live.galandras.com/live      (Browser Source, 1920x1080)
WHIP ingest  : https://ingest.galandras.com/<stream>/whip
```

Mindhárom egyetlen Cloudflare Tunnelen keresztül érhető el — nincs
port-forwarding, nincs dinamikus DNS, és a címek IP-váltás vagy újraindítás
után sem változnak.

## Első lépések

```powershell
copy .env.example .env          # töltsd ki a titkokat és a portokat

# 1) hálózat: fix, publikus URL-ek NAT mögül
#    docs/NETWORKING.md → 4. fejezet (cloudflared telepítése)

# 2) media ingest: a telefon ide publikál
#    docs/INGEST.md → 6. fejezet
cd infra\mediamtx
powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1 -StreamKey "<streamkulcs>"

# 3) vezérlő szerver
cd ..\..\server
npm install
npm test
npm start
```

## Fejlesztési állapot — szegmensek

A rendszer előre rögzített, 12 szegmensből álló terv szerint épül. Minden
szegmens egy önálló, működő réteget ad hozzá, és a felelősségi körök nem
csúsznak át egymásba (lásd [`ARCHITECTURE.md`](ARCHITECTURE.md)).

| # | Szegmens | Állapot |
|---|---|---|
| 0 | Architektúra és komponens-felelősségek | ✅ kész |
| 1 | Hálózati réteg és elérhetőség | ✅ kész |
| 2 | Android alkalmazás: capture és publish | ✅ kész |
| 3 | Media ingest réteg beállítása | ✅ kész |
| 4 | Vezérlő szerver: állapotgép | ✅ kész |
| 5 | Overlay- és médiakezelés (intro/outro/megszakadt) | ✅ kész |
| 6 | OBS integráció (Browser Source) | ✅ kész |
| 7 | Widget rendszer (logó / chat / értesítés, drag-and-drop) | ✅ kész |
| 8 | Web UI: admin/vezérlő felület | ✅ kész |
| 9 | Stream-monitor, letölthető napló és link-gyűjtő | ⬜ hátravan |
| 10 | Biztonság és hitelesítés | ⬜ hátravan |
| 11 | Telepítés, üzemeltetés, tesztelési terv | ⬜ hátravan |

### Ami a következő szegmensekre marad

Ezekre a kész szegmensek dokumentációja már hivatkozik, tehát nem elfelejtett
munka, hanem szándékosan későbbre ütemezett:

- **9.** Részletes stream-monitor és **letölthető napló** — az admin felületen
  a fül és a link-gyűjtő már megvan, az átmenet-napló pedig gyűlik
  (`data/transitions.jsonl`).
- **10.** Az admin jelszó, az ingest streamkulcs és a subdomainek jogosultsági
  szintjei — a `admin` / `live` / `ingest` felosztás már ehhez igazodik.
- **11.** `start.bat`, keretezett „OnLIVE szerver elindult" konzol üzenet az
  URL-ekkel, a `cloudflared` Windows service és a watchdog ütemezett feladat
  telepítése.
