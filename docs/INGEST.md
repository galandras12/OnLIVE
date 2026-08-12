# OnLIVE — 3. szegmens: Media ingest réteg

> A media ingest réteg felelőssége szigorúan: **fogadja a telefon WHIP
> stream-jét, és több protokollon szolgáltassa tovább.** Nem tud az adás
> állapotgépéről, nem csinál overlay-t, nem dönt intróról vagy outróról —
> csak tényeket közöl arról, hogy van-e bejövő adás
> ([`ARCHITECTURE.md`](../ARCHITECTURE.md) 2.2).

Konfiguráció: [`infra/mediamtx/`](../infra/mediamtx/).

---

## 1. Miért MediaMTX

| Követelmény | Miért teljesíti |
|---|---|
| WHIP ingest | natív, külön modul nélkül |
| Több kimeneti protokoll ugyanabból a forrásból | WebRTC/WHEP, RTMP, HLS egyszerre, transzkódolás nélkül |
| Állapot-lekérdezés | beépített HTTP API (`/v3/paths/...`) és Prometheus metrikák |
| Push értesítés | `runOnReady` / `runOnNotReady` hookok |
| Self-hosted, egy bináris | nincs függőség, nincs konténer-kényszer |

Célverzió: **MediaMTX v1.9+**. Telepítés: [`install-mediamtx.ps1`](../infra/mediamtx/install-mediamtx.ps1).

### Portkiosztás

| Port | Protokoll | Ki éri el | Alagúton kimegy? |
|---|---|---|---|
| `8889` | WebRTC / WHIP / WHEP | telefon (publish), vezérlő szerver (proxy) | ✅ `ingest.galandras.com` |
| `8189/udp` | WebRTC média (ICE) | — | ❌ (TURN-on keresztül, lásd 5. fejezet) |
| `1935` | RTMP | helyi OBS / restream | ❌ csak LAN |
| `8888` | HLS | vezérlő szerver (tartalék lejátszás) | ❌ csak localhost |
| `9997` | HTTP API | **csak** a vezérlő szerver | ❌ soha |
| `9998` | Prometheus metrikák | vezérlő szerver / monitoring | ❌ soha |

Az API és a metrikák `127.0.0.1`-re vannak kötve — ezek sosem mennek ki
publikusra, a cloudflared csak a `8889`-et teszi elérhetővé.

---

## 2. WHIP ingest és hitelesítés

A telefon publish URL-je:

```
https://ingest.galandras.com/onlive/whip
```

**Hitelesítés: HTTP Basic**, `publisher` felhasználóval, jelszóként a
streamkulccsal. A MediaMTX belső (`internal`) auth módja Basic fejlécet és
query paramétert fogad el; Bearer tokent nem (az a `jwt` módhoz tartozik).
Ezért az Android app a WHIP kérésen Basic fejlécet küld:

```
Authorization: Basic base64("publisher:<streamkulcs>")
```

> A **vezérlő szerver** felé az app továbbra is `Bearer <streamkulcs>`
> fejlécet küld — az a saját API-nk, ott mi döntjük el a formátumot.
> Két különböző rendszer, két különböző konvenció.

Tartalék forma (ha valamiért nem megy a fejléc), a MediaMTX ezt is elfogadja:

```
https://ingest.galandras.com/onlive/whip?user=publisher&pass=<streamkulcs>
```

Jogosultságok (`authInternalUsers`):

| Ki | Mit | Honnan |
|---|---|---|
| `publisher` + streamkulcs | `publish` az `onlive` útvonalra | bárhonnan |
| bárki jelszó nélkül | `read` az `onlive` útvonalról | **csak** `127.0.0.1` |
| bárki jelszó nélkül | `api`, `metrics` | **csak** `127.0.0.1` |

Az olvasás szándékosan localhostra van szorítva: a böngésző felé a vezérlő
szerver proxyzik (4. fejezet), így egy helyen dől el, ki nézheti az adást —
ez a 10. szegmens (biztonság) dolga lesz.

---

## 3. Hogyan tudja a vezérlő szerver, hogy megszakadt-e a telefon oldali forrás

Ez a szegmens legfontosabb kérdése, mert ez táplálja a 4. szegmens
állapotgépét. **Két, egymást kiegészítő csatorna van** — szándékosan, mert
külön-külön mindkettő hibázhat:

| | Push (webhook) | Pull (API-poll) |
|---|---|---|
| Mi | `runOnReady` / `runOnNotReady` hook | `GET /v3/paths/get/onlive` 1 mp-enként |
| Erőssége | azonnali (~ms) | megbízható, állapot-alapú |
| Gyengéje | elveszhet (szerver újraindul, hook hibázik) | 1 mp késés |
| Szerepe | gyors reakció | **az igazság forrása** |

Ha a kettő ellentmond, **a poll nyer**. A hook csak siettet.

### 3.1 Push: webhookok

A `mediamtx.yml` a két hookot hívja, azok pedig POST-olnak a vezérlő szervernek:

```
POST http://127.0.0.1:3000/api/ingest/ready
POST http://127.0.0.1:3000/api/ingest/notready
Content-Type: application/json
X-OnLIVE-Hook-Secret: <közös titok>

{ "path": "onlive", "sourceType": "webRTCSession", "sourceId": "...", "event": "ready" }
```

- A hívás **helyi** (`127.0.0.1`) — nem megy ki a Cloudflare alagútra, hogy a
  szomszéd folyamatnak szóljon.
- A közös titok (`X-OnLIVE-Hook-Secret`) megakadályozza, hogy más beküldjön
  hamis ingest-eseményt. A vezérlő szervernek ezt ellenőriznie kell.
- A hook 3-szor próbálkozik (1 s, 2 s, 4 s), majd feladja és naplóz. Soha nem
  blokkolja a MediaMTX-et: ha nem ér célba, a poll pár másodpercen belül
  úgyis rendezi az állapotot.

Fájlok: [`hooks/on-ready.bat`](../infra/mediamtx/hooks/on-ready.bat),
[`hooks/on-not-ready.bat`](../infra/mediamtx/hooks/on-not-ready.bat),
[`hooks/post-hook.bat`](../infra/mediamtx/hooks/post-hook.bat).
A titkokat a `hooks/hook-env.bat` tartalmazza (sablonból másolva, gitignore-olva).

### 3.2 Pull: API-poll — és amit a `ready` mező NEM árul el

```
GET http://127.0.0.1:9997/v3/paths/get/onlive
```

Válasz (kivonat):

```json
{
  "name": "onlive",
  "ready": true,
  "readyTime": "2026-08-12T10:00:00Z",
  "source": { "type": "webRTCSession", "id": "..." },
  "tracks": ["H264", "Opus"],
  "bytesReceived": 154829312,
  "readers": [ { "type": "webRTCSession", "id": "..." } ]
}
```

**Egy `ready: true` nem jelenti azt, hogy tényleg jön kép.** A publisher
maradhat csatlakozva úgy is, hogy közben megállt az adatfolyam — befagyott
telefon, félig élő mobilhálózat, elakadt enkóder. Ezt kizárólag a
`bytesReceived` mozgásából lehet észrevenni:

```js
// A 4. szegmens állapotgépéhez, közvetlenül átemelhető logika:
const s = await fetch('http://127.0.0.1:9997/v3/paths/get/onlive')
                .then(r => r.ok ? r.json() : null);

const live    = s?.ready === true && s.bytesReceived > lastBytes;
const stalled = s?.ready === true && s.bytesReceived === lastBytes;
const gone    = !s || s.ready !== true;

lastBytes = s?.bytesReceived ?? lastBytes;
```

Ajánlott paraméterek:

| Paraméter | Érték | Miért |
|---|---|---|
| Poll gyakoriság | 1 s | elég sűrű a gyors reakcióhoz, elhanyagolható terhelés |
| „Megszakadt" küszöb | **3 s** egymás utáni `gone` vagy `stalled` | kiszűri a pillanatnyi hálózati zökkenőket, nem villog a `/live` oldal |
| Visszatérés `LIVE`-ba | 1 mérés, amin nő a `bytesReceived` | a visszatérésnél nem kell türelmi idő |
| MediaMTX `readTimeout` | 10 s | ennyi adat nélküli idő után a MediaMTX maga bontja a publishert |

### 3.3 Az ingest réteg jelzései és az állapotgép — a szerződés

Az ingest réteg **nem** dönti el, hogy „megszakadt" vagy „vége az adásnak".
Csak tényt közöl; a jelentést a 4. szegmens adja neki:

| Ingest jelzés | Volt `session/end`? | Szerver állapot |
|---|---|---|
| `ready` + nő a bájtszám | — | `LIVE` |
| `not ready` / `stalled` 3 mp-en át | nem | `INTERRUPTED` („Megszakadt" képernyő) |
| `not ready` | igen (felhasználó Befejezést nyomott) | `OUTRO` → `OFFLINE` |
| `not ready` | nem, de volt `session/pause` | `PAUSED` (nincs visszatérés-várakozás) |
| API nem elérhető | — | `INGEST_DOWN` — hibaállapot, a MediaMTX nem fut |

Az utolsó sor fontos: ha a MediaMTX maga áll le, az **nem** ugyanaz, mint ha a
telefon szakad meg. A `/live` oldalon más üzenetet érdemel, és az admin UI-n
riasztást.

---

## 4. Kimeneti formátumok

| Formátum | URL (helyi) | Kinek | Késleltetés |
|---|---|---|---|
| **WebRTC (WHEP)** | `http://127.0.0.1:8889/onlive/whep` | a `/live` kompozit oldal | ~0,2–0,5 s |
| **RTMP** | `rtmp://127.0.0.1:1935/onlive` | helyi OBS „Media Source", restream | ~1–3 s |
| **HLS** | `http://127.0.0.1:8888/onlive/index.m3u8` | tartalék, kompatibilitás | ~2–6 s (LL-HLS) |

Mindhárom **ugyanabból a bejövő stream-ből** megy, transzkódolás nélkül — a
MediaMTX csak újracsomagol, tehát nincs extra CPU-terhelés és nincs
minőségromlás.

### 4.1 Miért nem a böngésző beszél közvetlenül a MediaMTX-szel

A `/live` oldalt a `live.galandras.com` szolgálja ki, ami a cloudflared
konfigurációban a Node szerverre (`:3000`) mutat. A cloudflared **nem ír át
útvonalat**, ezért nem lehet egy al-útvonalat egyszerűen a MediaMTX-re
irányítani.

A választott megoldás: **a vezérlő szerver proxyzza a lejátszást.**

```
Böngésző → POST https://live.galandras.com/api/whep/onlive   (Node)
                     └→ POST http://127.0.0.1:8889/onlive/whep  (MediaMTX)
```

Előnyök: egyetlen origin (nincs CORS-tánc), a hozzáférés egy helyen
szabályozható (10. szegmens), és a MediaMTX olvasási joga localhostra
szorítható maradhat. A proxy megvalósítása a **6. és 8. szegmens** feladata;
ez a dokumentum csak a szerződést rögzíti.

Ugyanez érvényes a HLS tartalékra (`/api/hls/onlive/...`).

---

## 5. A médiaút — TURN nélkül nincs kép

A 1. szegmensben rögzített döntés itt válik konkrét konfigurációvá. A WHIP
**jelzés** átmegy a Cloudflare Tunnelen, a WebRTC **média** nem. A MediaMTX
alapból a saját, NAT mögötti privát IP-jét hirdetné ICE-jelöltként, amit a
telefon mobilhálózatról nem ér el.

Ezért a `mediamtx.yml`-ben:

```yaml
webrtcICEServers2:
  - url: stun:stun.cloudflare.com:3478
  - url: turn:turn.cloudflare.com:3478?transport=udp
    username: <turn-user>
    password: <turn-credential>
```

Amíg a TURN sorok kommentben vannak, a rendszer **csak azonos LAN-on
működik** — a WHIP `201`-et ad, de kép nem érkezik. Ez a leggyakoribb
„minden zöld, mégsincs adás" hibakép; a hibakeresési tábla is erre mutat rá.

Ugyanez a TURN kell a **nézői oldalra** is (WHEP), ha a nézők nem a helyi
hálózatról jönnek.

Alternatíva, ha nem akarsz TURN-t: a telefon és a szerver közös tailnetre
tétele (Tailscale) — részletek: [`NETWORKING.md`](NETWORKING.md) 3.B és 8.

---

## 6. Telepítés

```powershell
# rendszergazdai PowerShell, a repó gyökeréből
cd infra\mediamtx

# 1) MediaMTX letöltése, konfiguráció a sablonból, ütemezett feladat indításra
powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1 -StreamKey "<streamkulcs>"

# 2) A hookok környezete (titkok)
copy hooks\hook-env.example.bat hooks\hook-env.bat
notepad hooks\hook-env.bat

# 3) TURN adatok beírása
notepad C:\OnLIVE\mediamtx\mediamtx.yml

# 4) Újraindítás és ellenőrzés
Restart-ScheduledTask -TaskName 'OnLIVE MediaMTX'
powershell -ExecutionPolicy Bypass -File .\ingest-probe.ps1
```

A `install-mediamtx.ps1` nem írja felül a meglévő `mediamtx.yml`-t, tehát
frissítésnél a konfiguráció megmarad.

---

## 7. Health-check és hibakeresés

Az operátori health-check: [`ingest-probe.ps1`](../infra/mediamtx/ingest-probe.ps1).
Ugyanazt kérdezi le, amit a vezérlő szerver, csak emberi kimenettel, és
megkülönbözteti a „megállt" esetet az „élő"-től.

```powershell
.\ingest-probe.ps1              # egyszeri állapot (kilépési kód: 0 = él és mozog)
.\ingest-probe.ps1 -Watch       # folyamatos figyelés
.\ingest-probe.ps1 -Json        # gépi feldolgozásra
```

| Tünet | Valószínű ok | Teendő |
|---|---|---|
| WHIP `401` / `403` | rossz streamkulcs, vagy nem Basic fejléc megy | `mediamtx.yml` → `authInternalUsers`, app beállítások |
| WHIP `201`, de nincs kép | **nincs TURN** — a média nem talál utat | 5. fejezet |
| `ready: true`, de nem nő a `bytesReceived` | a telefon él, de nem küld (befagyott enkóder, félholt hálózat) | app újraindítás; a szerver `INTERRUPTED`-be megy 3 mp után |
| API nem elérhető | nem fut a MediaMTX | `Get-ScheduledTask 'OnLIVE MediaMTX'`, `C:\OnLIVE\logs\mediamtx.log` |
| A hookok nem érnek célba | hiányzó `hook-env.bat`, vagy nem fut a Node szerver | `C:\OnLIVE\logs\mediamtx-hooks.log` |
| Publisher azonnal lecsatlakozik | `readTimeout` letelt adat nélkül | a médiaút hibája → 5. fejezet |

Hasznos parancsok:

```powershell
curl.exe http://127.0.0.1:9997/v3/paths/list
curl.exe http://127.0.0.1:9997/v3/paths/get/onlive
curl.exe http://127.0.0.1:9998/metrics
Get-Content C:\OnLIVE\logs\mediamtx.log -Tail 50 -Wait
```

---

## 8. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Hova tartozik |
|---|---|
| Az `/api/ingest/ready|notready` végpontok megvalósítása | 4. szegmens (vezérlő szerver) |
| A poll-logika és a 3 mp-es debounce kódja | 4. szegmens |
| A WHEP/HLS proxy megvalósítása | 6. és 8. szegmens |
| Nézői hozzáférés szabályozása | 10. szegmens |
| Felvétel/archiválás a szerveren | nincs benne a tervben (a telefon helyben rögzít, 2. szegmens) |
