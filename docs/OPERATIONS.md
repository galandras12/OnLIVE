# Telepítés, üzemeltetés és tesztelési terv — 11. szegmens

> Ez a dokumentum a **11. szegmens** kimenete: hogyan áll fel a rendszer egy
> gépen, mi indul mivel, hol keresd a naplót, és milyen próbákon kell
> átmennie egy adásnak, mielőtt élesben használod.
>
> A korábbi szegmensek dokumentációi a *miért*-et írják le; ez a *hogyan
> üzemeltesd* dokumentum.

---

## 1. Áttekintés — mi fut a gépen

Négy folyamat, ebből hármat az OnLIVE indít vagy ellenőriz:

| # | Folyamat | Mi indítja | Nélküle |
|---|---|---|---|
| 1 | `cloudflared` (Windows service) | a Windows induláskor; a `start.bat` és az `npm start` ellenőrzi | a rendszer csak helyi hálózaton érhető el |
| 2 | `mediamtx.exe` (media ingest) | `npm start`, ha nem fut | a telefon nem tud publikálni |
| 3 | OnLIVE vezérlő szerver (Node.js) | `npm start` | nincs se admin felület, se `/live` |
| 4 | OBS (opcionális) | kézzel | a Browser Source-os kompozíció marad el, a `/live` böngészőben így is megy |

A telefon nem folyamat a gépen — az az adás **forrása**, semmi több
(lásd [`ARCHITECTURE.md`](../ARCHITECTURE.md)).

```
start.bat  ──►  cloudflared service ellenőrzés
                     │
                     ▼
              npm start  (server/tools/start.js)
                     ├──► MediaMTX ellenőrzés / indítás
                     └──► vezérlő szerver ugyanabban a folyamatban
                              │
                              ├──► logs/YYYY-MM-DD.log   (JSON sorok)
                              └──► konzol                (színes, élő)
```

Miért egy folyamatban fut a szerver az indítóval: így **egy ablak, egy napló,
egy Ctrl+C** — nem marad árva Node process a háttérben.

---

## 2. Telepítés — sorrendben

A sorrend nem szabadon választható: mindegyik lépés az előzőre épül.

### 2.1 Előfeltételek

- Windows 10/11 (a szerver Linuxon/macOS-en is fut, csak a service-kezelés
  Windows-specifikus — ott a tunnelt és a MediaMTX-et kézzel indítsd)
- **Node.js 20 vagy újabb** (`node -v`)
- Cloudflare fiók + a saját domain a Cloudflare DNS-én

### 2.2 A repó és a titkok

```powershell
git clone <repo> C:\OnLIVE
cd C:\OnLIVE
copy .env.example .env

cd server
npm install
npm run keygen                              # live token, hook titok
#   (a streamkulcs 1.0.010 óta a webes felületen jön létre — lásd 2.6)
npm run hash-password -- "hosszú jelszó"    # az admin jelszó scrypt hash-e
```

A `keygen` kimenetét másold a `.env`-be. A `.env` **soha nem kerül a repóba**
(`.gitignore`), lásd [`docs/SECURITY.md`](SECURITY.md).

### 2.3 Cloudflare Tunnel (1. szegmens)

```powershell
cloudflared tunnel login
cloudflared tunnel create livestream
# a config.yml-t az infra/cloudflared/config.example.yml alapján töltsd ki
cloudflared tunnel route dns livestream admin.galandras.com
cloudflared tunnel route dns livestream live.galandras.com
cloudflared tunnel route dns livestream ingest.galandras.com
cloudflared service install
```

Részletek és a `config.yml` sablon: [`docs/NETWORKING.md`](NETWORKING.md) 4. fejezet.

**Ellenőrzés:** `sc query cloudflared` → `RUNNING`.

### 2.4 Media ingest (3. szegmens)

```powershell
cd C:\OnLIVE\infra\mediamtx
powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1
```

**Ellenőrzés:** `curl http://127.0.0.1:9997/v3/paths/list` → JSON válasz.

### 2.5 Watchdog (opcionális, de ajánlott)

```powershell
cd C:\OnLIVE\scripts
powershell -ExecutionPolicy Bypass -File .\install-tunnel-watchdog.ps1
```

Az alagút kiesését figyeli és újraindítja a service-t
([`docs/NETWORKING.md`](NETWORKING.md) 6. fejezet).

### 2.6 Streamkulcs a webes felületen

Ez az első dolog, amit a szerver elindítása után csinálj — enélkül a telefon
nem tud publikálni:

1. `https://admin.galandras.com/admin` → **Streamkulcs** fül,
2. **Kulcs generálása** (vagy saját megadása: legalább 16 karakter, kis- és
   nagybetűvel, számmal, speciális karakterrel),
3. a megjelenő kulcsot **azonnal másold ki** — csak egyszer látszik, mert a
   szerver kizárólag a hash-ét tárolja.

**Ellenőrzés:** a fül állapot-táblájában „Forrás: webes felület" áll.

### 2.7 Az Android app

`android/` — Android Studióból telepítve. A **fogaskerék → Kapcsolat**
szekcióba írd be az előző pontban létrehozott streamkulcsot és a Tunnel címeit,
majd nyomj **Kapcsolat tesztelése** gombot: ha zöld, a cím és a kulcs is jó
([`docs/ANDROID.md`](ANDROID.md)). Ne felejtsd el az
akkumulátor-optimalizálás alóli felmentést és Samsungon a „Sosem alszik"
beállítást, különben a rendszer háttérben megöli a capture-t.

---

## 3. Indítás és leállítás

### 3.1 Indítás — `start.bat`

A projekt gyökerében lévő **`start.bat` dupla kattintással** indítja a teljes
rendszert, és **lépésenként kiírja, hol tart**:

```
   ============================================================
      OnLIVE - inditas
   ============================================================

   [1/5] Cloudflare Tunnel ellenorzese
         OK   A tunnel service mar fut.

   [2/5] Node.js ellenorzese
         OK   Node.js v22.11.0
         OK   Fuggosegek rendben.

   [3/5] Port ellenorzese
         OK   A szerver a 8080-es porton fog indulni.
         Helyi cim:  http://localhost:8080/admin

   [4/5] MediaMTX ingest ellenorzese - az inditot koveti
   [5/5] Vezerlo szerver inditasa

   ------------------------------------------------------------
    Innentol a szerver naploja latszik. Leallitas: Ctrl+C
   ------------------------------------------------------------
```

Ezután a szerver naplója **élőben, ebben az ablakban** fut tovább. Leállítás:
`Ctrl+C`, majd egy billentyű.

Amit még csinál:

- ellenőrzi a Node meglétét és az `npm`-et, első indításkor lefuttatja az
  `npm install`-t,
- kiírja, **melyik porton** fog indulni és mi a helyi cím — még az indítás
  előtt —, és szól, ha a portot már használja valami,
- leállás után kiírja a **napló utolsó 20 sorát**, hogy egy gyors összeomlás
  oka is látszódjon, ha a konzol már elgörgött,
- minden lépésről időbélyeges sort ír a `logs\startup.log`-ba,
- **minden hiba esetén is nyitva marad**, és megmondja, mi a teendő.

> **Ha az ablak mégis felvillan és eltűnik**, az a `.bat` értelmezési hibája.
> Nyiss egy `cmd` ablakot, és onnan indítsd (`cd C:\OnLIVE` majd `start.bat`) —
> ott a hibaüzenet olvasható marad. A `logs\startup.log` utolsó sora is
> megmutatja, meddig jutott.
>
> Az 1.0.011-ig ez rendszeresen előfordult: egy escape-eletlen zárójel egy
> `echo` sorban lezárta a `(`-blokkot, amitől a cmd azonnal megszakította a
> fájlt. A `start.bat` azóta blokkok helyett `goto`-val ágazik el, és a
> `server/test/start-script.test.js` őrzi, hogy ez ne térjen vissza.

### 3.2 Indítás — parancssorból

```powershell
cd C:\OnLIVE\server
npm start           # tunnel + MediaMTX ellenőrzés, majd a szerver
npm run start:server  # CSAK a szerver, ellenőrzés nélkül (fejlesztéshez)
```

Sikeres induláskor a keretezett banner jön a konzolra:

```
┌──────────────────────────────────────────────────────────┐
│  OnLIVE vezérlő szerver elindult                         │
├──────────────────────────────────────────────────────────┤
│  Helyi:   http://localhost:8080                          │
│  Admin:   https://admin.galandras.com                    │
│  Live:    https://live.galandras.com/live                │
│  Vezérlés:https://admin.galandras.com/admin              │
│  Ingest:  https://ingest.galandras.com/onlive/whip       │
└──────────────────────────────────────────────────────────┘
```

**Hiányzó függőség nem végzetes.** Ha nincs cloudflared vagy MediaMTX, az
indító figyelmeztet, de a szerver elindul — így fejlesztői gépen is
használható. A figyelmeztetés a naplóban is ott lesz.

### 3.3 A szerver portja

Alapértelmezés: **8080**. Átállítható az admin felület **Szerver** fülén, és a
**következő indításkor** lép életbe — futó szervernek nem cserélhető a portja
anélkül, hogy a nyitott kapcsolatok (Socket.io, lejátszás-proxy, éppen zajló
adás) el ne szakadnának.

A sorrend, ha több helyen is meg van adva:

1. a felületen beállított érték (`data/server.json`),
2. `ONLIVE_SERVER_PORT`,
3. 8080.

> **A port három másik helyen is szerepel.** Ha ezek a régin maradnak, a
> rendszer némán romlik el: a publikus címek 502-t adnak, a telefon pedig 401-et
> kap a WHIP-en. A Szerver fül kiírja a pontos sorokat, és a szerver
> **induláskor összeveti** a fájlokat a saját portjával:
>
> | Hol | Mit kell átírni |
> |---|---|
> | cloudflared `config.yml` | `service: http://localhost:<port>` (mindkét hostname alatt) |
> | MediaMTX konfiguráció | `authHTTPAddress: http://127.0.0.1:<port>/api/ingest/auth` |
> | `scripts/tunnel-watchdog.ps1` | `-OriginPort <port>` |

### 3.4 Automatikus indulás bekapcsoláskor

A `cloudflared` service és a MediaMTX ütemezett feladata magától indul. Az
OnLIVE szerverhez tedd a `start.bat` parancsikonját a
`shell:startup` mappába, vagy regisztráld ütemezett feladatként.

### 3.5 Leállítás

| Mit | Hogyan |
|---|---|
| vezérlő szerver | `Ctrl+C` a konzolablakban |
| MediaMTX (ha az `npm start` indította) | a `Ctrl+C`-vel együtt leáll |
| cloudflared | `net stop cloudflared` (a service futva maradhat, nem zavar) |

Az **adás** lezárása külön dolog a folyamat leállításától: a „Befejezés" az
`ended` állapotba viszi a rendszert, de a szerver fut tovább, készen a
következő adásra ([`docs/STATE-MACHINE.md`](STATE-MACHINE.md) 8.1).

---

## 4. Naplózás

### 4.1 Hol keresd

| Fájl | Mi van benne |
|---|---|
| `server/logs/YYYY-MM-DD.log` | **minden esemény**, soronként egy JSON objektum; dátumváltáskor új fájl |
| `logs/startup.log` | a `start.bat` lépésenkénti sorai (mikor, meddig jutott) |
| `server/data/server.json` | a felületen beállított port (1.0.011) |
| `server/data/transitions.jsonl` | csak az állapotátmenetek (a letölthető CSV alapja, 9. szegmens) |
| `server/data/metrics.jsonl` | bitráta/felbontás minták a monitor-grafikonhoz |

A könyvtár a `ONLIVE_LOG_DIR`-rel áthelyezhető. A `logs/` a `.gitignore`-ban
van — a napló sosem kerül a repóba.

### 4.2 A formátum

Egy sor = egy esemény. A közös mezők:

```json
{
  "ts": "2026-08-15T17:37:40.912Z",
  "level": "state",
  "type": "state.transition",
  "source": "web-ui",
  "client": "192.168.0.31/BTUaPy",
  "message": "live → outro   (session/end)",
  "from": "live", "to": "outro", "trigger": "session/end",
  "sessionId": "s1-1786815218913", "liveElapsedMs": 421703
}
```

- **`source`** — melyik felületről jött: `telefon`, `web-ui`, `obs`,
  `ingest`, `időzítő`, `rendszer`.
- **`client`** — ki csinálta: IP, admin munkamenetnél `IP/ujjlenyomat`. A
  **teljes munkamenet-token sosem kerül naplóba**, csak az első 6 karaktere —
  így két böngésző megkülönböztethető, de a napló nem szivárogtat hitelesítőt.

### 4.3 Eseménytípusok

| `type` | Mikor keletkezik |
|---|---|
| `system` | indulás, leállás, konfigurációs figyelmeztetés |
| `auth` | bejelentkezés, sikertelen próbálkozás, zárlat |
| `state.transition` | **minden** állapotgép-átmenet (`from`, `to`, `trigger`, `sessionId`) |
| `ingest` | a WHIP ingest létrejötte/megszakadása — megkülönböztetve a „megállt" és a „megszakadt" esetet |
| `client` | Socket.io fel- és lecsatlakozás: admin felület, néző, **és külön az OBS Browser Source** (User-Agent alapján) |
| `settings.change` | bármilyen beállítás-változás, **régi és új értékkel** |
| `device.command` | a web UI-ról a telefonnak küldött parancs |

### 4.4 Beállítás-változások

Minden beállítás-változás naplózódik, `area` szerint csoportosítva, a régi és
az új értékkel együtt — enélkül adás után nem lehetne megmondani, *mitől* lett
rossz a kép:

```json
{"type":"settings.change","source":"web-ui","client":"192.168.0.31/KpuZnn",
 "area":"minoseg","message":"Minőség módosítás — resolution: 1920x1080 → P720, fps: 30 → 60",
 "changes":{"resolution":{"regi":"1920x1080","uj":"P720"},"fps":{"regi":30,"uj":60}}}
```

Lefedett területek: `minoseg` (felbontás, bitráta, képfrissítés, hangminőség),
`kamera` (lencseváltás, kamera↔képernyő), `capture` (a telefon saját
jelentése), `widget` (pozíció, méret, láthatóság, beágyazás), `media`
(intro/megszakadt/outro csere és opciók), `outro` (hossz), `links`
(chat-link lista).

### 4.5 Kiolvasás

```powershell
# az utolsó 20 esemény, olvashatóan
Get-Content server\logs\2026-08-15.log -Tail 20 | ForEach-Object { ($_ | ConvertFrom-Json).message }

# csak a megszakadások
Select-String -Path server\logs\*.log -Pattern '"type":"ingest"'

# ki és mit állított
Select-String -Path server\logs\*.log -Pattern '"type":"settings.change"'
```

Idővonal, időtartamok és bitráta-statisztika Excelbe: az admin felület
**Monitor** fülén a „Napló letöltése" gomb ([`docs/MONITORING.md`](MONITORING.md)).

---

## 5. Tesztelési terv

A négy forgatókönyv **automatizálva is fut**:

```powershell
cd server
npm test                      # a teljes tesztkészlet
node --test test/scenarios.test.js   # csak a négy forgatókönyv
```

Éles üzembe helyezés előtt viszont **kézzel is végig kell menni rajtuk**,
valódi telefonnal és valódi hálózattal — az automatizált teszt a logikát
igazolja, a kézi próba a rendszert.

Mindegyikhez tartsd nyitva az admin felület Monitor fülét és a szerver
konzolablakát.

### 5.1 Forgatókönyv — első indítás óta nem volt élő adás

| Lépés | Elvárt eredmény |
|---|---|
| 1. Indítsd a rendszert (`start.bat`), ne indíts adást | `/live` üres (átlátszó), állapot: `idle` |
| 2. Nyomd meg a **Kezdés**t (telefonon vagy a web UI-n) | állapot: `intro`, a `/live` az intro médiát játssza |
| 3. **Ne** indítsd még a streamet, várj 1-2 percet | továbbra is `intro` — az intro ismétlődik, nem vált magától |
| 4. Indítsd a publikálást a telefonon | 1-3 mp-en belül `live`, a kép megjelenik a `/live`-on |

Naplóban: `idle → intro (session/start)` `source: telefon`, majd
`Bejövő stream megérkezett` és `intro → live (ingest/up)`.

### 5.2 Forgatókönyv — élő adás, majd megszakad a telefon net-je

| Lépés | Elvárt eredmény |
|---|---|
| 1. Legyen élő adás **legalább 3 percig** | állapot: `live` |
| 2. Kapcsold ki a telefonon a wifit/mobilnetet | ~3 mp múlva `reconnecting`, a `/live` a „Megszakadt" képernyőt mutatja, visszaszámlálóval |
| 3. Kapcsold vissza a netet | az app magától újracsatlakozik (exponenciális backoff), a stream visszaáll |
| 4. Ne nyúlj semmihez | **magától** visszaáll `live`-ra — külön Kezdés nem kell |

> A 2 perces szabály **csak** azt dönti el, hogy a megszakadáskor „Megszakadt"
> (≥ 2 perc élő adás) vagy „Hamarosan kezdünk" (< 2 perc) képernyő jön. Semmi
> mást nem befolyásol. Ha rövidebb adás után szakad meg, a 4. lépés `intro`-t
> ad `reconnecting` helyett — ez így helyes.

Naplóban: `A bejövő stream megszakadt`, `live → reconnecting (ingest/down)`,
majd `reconnecting → live (ingest/up)`.

### 5.3 Forgatókönyv — Szünet a telefonon

| Lépés | Elvárt eredmény |
|---|---|
| 1. Élő adás közben nyomj **Szünet**et a telefonon | állapot: `paused`, a `/live` a megszakadáshoz hasonló képernyőt mutat |
| 2. Figyeld a képernyőt | **nincs** újracsatlakozási visszaszámláló — a szünet nem hiba, hanem szándék |
| 3. Várj 1-2 percet | semmi nem történik magától; a stream visszatérése sem oldja fel |
| 4. Nyomj **Folytatás**t | azonnal vissza `live`-ra |

Naplóban: `live → paused (session/pause)` `source: telefon`, majd
`paused → live (session/resume)`. A közben érkező ingest-események
állapotváltozás nélkül maradnak — ez a szünet lényege.

### 5.4 Forgatókönyv — Befejezés a web UI-ról élő adás közben

| Lépés | Elvárt eredmény |
|---|---|
| 1. Élő adás közben nyomj **Befejezés**t a web felületen | állapot: `outro`, a `/live` az outro médiát játssza |
| 2. Nézd a telefont | az app a következő telemetria-körben (max. 3 mp) megkapja a `stop` parancsot és leállítja a publikálást |
| 3. Várd ki az outro hosszát (alapból 15 mp) | állapot: `ended`, a `/live` üres/átlátszó lesz |
| 4. Nézd meg a szerver konzolját | fut tovább — a **session** zárult le, nem a folyamat; jöhet a következő adás |

Naplóban: `live → outro (session/end)` `source: web-ui` a kliens
ujjlenyomatával, majd `outro → ended (outro/done)` `source: időzítő`.

### 5.5 Kiegészítő próbák élesítés előtt

- **OBS**: a Browser Source-ban jelenik-e meg a kép és az overlay, átlátszó-e
  a háttér `idle` állapotban ([`docs/OBS.md`](OBS.md)).
- **Widget**: mozgatás/átméretezés a szerkesztőben → a `/live`-on azonnal
  látszik-e, és **túléli-e a szerver újraindítását**.
- **Jogosultság**: a lejátszási tokennel nyitott `/live` **ne** tudjon
  vezérelni ([`docs/SECURITY.md`](SECURITY.md)).
- **Újraindítás**: állítsd le és indítsd újra a szervert élő stream mellett —
  a szintvezérelt ingest-figyelés miatt a „Kezdés" után azonnal `live`-ba kell
  jutnia, nem `intro`-ban ragadnia.

---

## 6. Hibaelhárítás

| Tünet | Valószínű ok | Mit tegyél |
|---|---|---|
| Minden publikus cím 502-t ad, pedig fut a szerver | átállt a port, de a cloudflared még a régire mutat | Admin → Szerver fül: kiírja, mit kell átírni; a szerver indulási naplója is jelzi |
| `admin.galandras.com` nem jön be | a tunnel nem fut | `sc query cloudflared`, `net start cloudflared`; napló: `logs/startup.log` |
| A tunnel fut, de „502 Bad Gateway" | a Node szerver nem fut vagy más porton van | `npm start`, ellenőrizd az `ONLIVE_SERVER_PORT`-ot és a `config.yml`-t |
| A telefon 401-et kap a WHIP-en | nincs streamkulcs, elgépelt kulcs — vagy a vezérlő szerver áll | a MediaMTX a Node szervertől kérdez: előbb `curl http://127.0.0.1:8080/healthz`, utána a kulcs |
| A telefon „csatlakozva", de nincs kép | a WHIP jelzés átment, a **média nem** — a Cloudflare Tunnel nem visz WebRTC médiát | TURN szerver kell, vagy Tailscale ([`docs/NETWORKING.md`](NETWORKING.md) 3. fejezet) |
| A szerver `intro`-ban ragad, pedig megy a stream | a MediaMTX API nem elérhető | `curl http://127.0.0.1:9997/v3/paths/list`; a napló `A MediaMTX API nem elérhető` sorai |
| Villog a „Megszakadt" képernyő | ingadozó mobilnet, túl rövid debounce | `ONLIVE_INGEST_INTERRUPT_AFTER_MS` növelése (alap 3000) |
| Az adás pár perc után megáll a telefonon | a rendszer megölte a háttérfolyamatot | akkumulátor-optimalizálás alóli felmentés, Samsungon „Sosem alszik" ([`docs/ANDROID.md`](ANDROID.md)) |
| „Túl sok sikertelen próbálkozás" | a bejelentkezés zárlat alatt | várd ki a `Retry-After` időt; a zárlat IP-nként külön számol |
| Az OBS-ben fekete a Browser Source | gyorsítótárazott oldal | jobb gomb → *Refresh cache of current page*; a napló `client`/`obs` sorai mutatják, csatlakozott-e egyáltalán |
| Nem nő a naplófájl | rossz `ONLIVE_LOG_DIR` vagy jogosultság | nézd meg, létezik-e a könyvtár; írási jog kell rá |

### 6.1 Amit hiba esetén küldj/ments el

1. `server/logs/<a nap>.log` — az esemény ideje körüli szakasz,
2. `logs/startup.log` — mikor és mivel indult a rendszer,
3. az admin felület Monitor fülén letöltött CSV a session időszakára,
4. a szerver konzoljának utolsó képernyője.

Ezekből az adás teljes menete rekonstruálható: mikor mit nyomtak, melyik
felületről, mi változott a beállításokon és mikor szakadt meg a stream.

---

## 7. Környezeti változók — üzemeltetési vonatkozásúak

| Változó | Alap | Mire jó |
|---|---|---|
| `ONLIVE_SERVER_PORT` | `8080` | a szerver portja — a felületen beállított érték **erősebb** ennél |
| `ONLIVE_TUNNEL_CONFIG` | – | a cloudflared `config.yml` útvonala, ha nem a szokásos helyen van (a port-ellenőrzéshez) |
| `ONLIVE_LOG_DIR` | `server/logs/` | a JSON napló helye |
| `ONLIVE_AUTOSTART_MEDIAMTX` | `true` | az `npm start` indítsa-e a MediaMTX-et, ha nem fut |
| `ONLIVE_AUTOSTART_TUNNEL` | `true` | az `npm start` indítsa-e az álló tunnel service-t |
| `ONLIVE_MEDIAMTX_PATH` | `C:\OnLIVE\mediamtx\mediamtx.exe` | a MediaMTX futtatható fájlja |
| `ONLIVE_MEDIAMTX_CONFIG` | `C:\OnLIVE\mediamtx\mediamtx.yml` | a MediaMTX konfigurációja |
| `ONLIVE_TUNNEL_SERVICE` | `cloudflared` | a tunnel Windows service neve |
| `ONLIVE_OUTRO_DURATION_MS` | `15000` | az outro **kezdő** hossza; utána az admin felületen állítható |
| `ONLIVE_SHUTDOWN_ON_ENDED` | `false` | `ended` állapotban a folyamat is álljon-e le |
| `ONLIVE_STREAM_KEY` | – | **elavult**: csak tartalék a régi telepítéseknek. A kulcs a webes felületen jön létre, hash-elve tárolva |
| `ONLIVE_INGEST_USER` | `publisher` | a WHIP publish felhasználóneve (a MediaMTX ezt ellenőrzi a kulccsal együtt) |

A teljes lista: [`.env.example`](../.env.example).
