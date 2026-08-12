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
| [`infra/cloudflared/`](infra/cloudflared/) | tunnel `config.yml` sablon + telepítési gyorstalpaló |
| [`scripts/`](scripts/) | tunnel watchdog és annak ütemezett feladatként való regisztrálása |

## Komponensek

1. **Android app** (Kotlin, CameraX + MediaProjection) — capture, kódolás, WHIP publish.
2. **Media ingest** (MediaMTX) — WHIP be, WebRTC/RTMP/HLS ki.
3. **Vezérlő szerver** (Node.js + Express + Socket.io, fájl-alapú JSON/lowdb) — állapotgép, overlay-kompozíció, admin API.
4. **Web UI** — `/admin` vezérlőfelület és `/live` kompozit lejátszó (OBS Browser Source).

## Publikus végpontok

```
Admin UI     : https://admin.galandras.com
Live / OBS   : https://live.galandras.com/live
WHIP ingest  : https://ingest.galandras.com/<stream>/whip
```

Mindhárom egyetlen Cloudflare Tunnelen keresztül érhető el — nincs
port-forwarding, nincs dinamikus DNS, és a címek IP-váltás vagy újraindítás
után sem változnak.

## Első lépések

```powershell
copy .env.example .env          # töltsd ki a titkokat és a portokat
# majd kövesd: docs/NETWORKING.md → 4. fejezet (cloudflared telepítése)
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
| 3 | Media ingest réteg beállítása | ⬜ hátravan |
| 4 | Vezérlő szerver: állapotgép | ⬜ hátravan |
| 5 | Overlay- és médiakezelés (intro/outro/megszakadt) | ⬜ hátravan |
| 6 | OBS integráció (Browser Source) | ⬜ hátravan |
| 7 | Widget rendszer (logó / chat / értesítés, drag-and-drop) | ⬜ hátravan |
| 8 | Web UI: admin/vezérlő felület | ⬜ hátravan |
| 9 | Stream-monitor, letölthető napló és link-gyűjtő | ⬜ hátravan |
| 10 | Biztonság és hitelesítés | ⬜ hátravan |
| 11 | Telepítés, üzemeltetés, tesztelési terv | ⬜ hátravan |

### Ami a következő szegmensekre marad

Ezekre a kész szegmensek dokumentációja már hivatkozik, tehát nem elfelejtett
munka, hanem szándékosan későbbre ütemezett:

- **3.** MediaMTX WHIP végpont, streamkulcsos ingest-hitelesítés, és a **TURN
  relay** beállítása — enélkül a WebRTC médiaút nem áll össze NAT mögül
  ([`docs/NETWORKING.md`](docs/NETWORKING.md) 3. fejezet).
- **4.** Az állapotgép: `OFFLINE → INTRO → LIVE → INTERRUPTED → OUTRO`, plusz a
  külön `PAUSED` állapot, amit a telefon Szünet gombja vált ki
  ([`docs/ANDROID.md`](docs/ANDROID.md) 6.1), és a
  `/api/session/start|pause|resume|end|config|stats` végpontok kiszolgálása.
- **10.** Az admin jelszó, az ingest streamkulcs és a subdomainek jogosultsági
  szintjei — a `admin` / `live` / `ingest` felosztás már ehhez igazodik.
- **11.** `start.bat`, keretezett „OnLIVE szerver elindult" konzol üzenet az
  URL-ekkel, a `cloudflared` Windows service és a watchdog ütemezett feladat
  telepítése.
