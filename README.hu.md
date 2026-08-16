# OnLIVE

**1.0.011 verzió** · [Changelog](CHANGELOG.hu.md) · [In English](README.md)

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
következő indításkor lép életbe —, és az alapértelmezést **8080**-ra viszi.

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
npm run keygen                              # live token, hook titok
npm run hash-password -- "hosszú jelszó"    # admin jelszó hash
npm test
npm start
```

Ezután hozd létre a streamkulcsot a webes felületen — **Admin → Streamkulcs** —,
és írd be a telefonon a fogaskerék mögötti **Kapcsolat** szekcióba. A szerver
csak a hash-ét tárolja, ezért másold ki, amíg látszik.

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
