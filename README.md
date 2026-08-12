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

## Fejlesztési állapot

- [x] 0. szegmens — architektúra és felelősségi körök
- [x] 1. szegmens — hálózati réteg, Cloudflare Tunnel, watchdog
- [ ] 2. szegmens — media ingest (MediaMTX)
- [ ] 3. szegmens — Android app (capture, WHIP, reconnect)
- [ ] 4+ szegmens — vezérlő szerver, állapotgép, overlay, web UI
