# Changelog

[In English](CHANGELOG.md)

Az OnLIVE előre rögzített, **tizenegy szegmensből** álló terv szerint épült.
Minden szegmens egy önálló, működő réteget adott hozzá, és a felelősségi körök
sosem csúszhattak át egymásba (lásd [`ARCHITECTURE.md`](ARCHITECTURE.md)).

Az *N*. szegmens a **0.N** verzióként jelenik meg, az **1.0.000** pedig lezárja
az alap szakaszt. A belső dokumentumok továbbra is „szegmenseket" emlegetnek —
ez a fájl a kettő közti megfeleltetés.

---

## 1.0.000 — Az alap szakasz lezárása

*2026-08-16*

A tervezett tizenegy szegmens elkészült: a rendszer végponttól végpontig
működik, a telefonon megnyomott „Kezdés"-től a kompozit kép OBS-ben való
megjelenéséig.

Amit a `0.11`-en felül még tartalmaz, a teljes kódbázis auditjából:

- **A `/live?preview=`** a paramétert `innerHTML`-be tette. Mivel a `/live`
  minden hoston kiszolgálódik, egy preparált `admin…/live?preview=…` link a
  belépett admin originjén futtatott kódot — a CSRF token a `sessionStorage`-ban
  van, tehát ez a munkamenet átvételét jelentette. A képernyőnév mostantól
  fehérlistás.
- **A `/admin/login?next=`** elfogadott `javascript:` URL-t és külső címet is,
  amit a `location.replace()` lefuttatott, illetve odairányított. Csak saját,
  abszolút útvonal fogadható el.
- **Az admin felület `innerHTML`-lel jelenítette meg a telefon telemetriáját** —
  a streamkulcs birtokosa (alacsonyabb jogosultsági szint) kódot futtathatott az
  admin oldalán.
- **`trust proxy: true` → `'loopback'`.** Korábban a kliens által küldött
  `X-Forwarded-For` első eleme lett a `req.ip`, tehát a támadó minden
  próbálkozáshoz friss IP-t hazudhatott, és a bejelentkezés sebességkorlátozása
  sosem lépett életbe.
- **`new URL(...).pathname` → `fileURLToPath`.** Windowson — ez a célplatform —
  az előbbi `/C:/…` alakot ad és a szóközöket százalékkódolja, vagyis egy
  `C:\Program Files\OnLIVE` telepítés alatt az adat- és naplókönyvtár létre sem
  jött volna.
- **A hibásan kódolt süti** (`onlive_session=%`) kivételt dobott az
  értelmezőben, ami a hitelesítő middleware-ben fut: egy elrontott süti minden
  kérésre HTTP 500-at adott.
- **A naplófolyam pufferelt volt**, így a `process.exit` eldobta a még ki nem írt
  sorokat — pont a leállásról szólókat.
- Kisebb javítások: a metrika-rögzítő `.toFixed()`-et hívott a telefontól kapott
  értékre (nem szám esetén a minta némán elveszett); a felbontás két alakban
  szerepelt a naplóban (`P720` vs `720p`), így minden állítás kétszer látszott
  változásnak; a teljes overlay-elrendezést cserélő végpont nem naplózott; a
  `start.bat` tisztán ASCII lett (a Windows konzol kódlapja nem UTF-8).

**118 teszt, mind zöld.** A két injekciós hibát valódi, fejetlen böngészőben
ellenőriztük a javítás előtt és után is; a sebességkorlátot és a napló ürítését
élő szerveren.

---

## 0.11 — Telepítés, üzemeltetés, tesztelési terv

*2026-08-15* · 11. szegmens

- **Egyetlen belépési pont.** Az `npm start` (`server/tools/start.js`) ellenőrzi
  a cloudflared service-t, ellenőrzi a MediaMTX-et (API-próba, szükség esetén
  indítás), majd **ugyanabban a folyamatban** indítja a vezérlő szervert — egy
  ablak, egy napló, egy Ctrl+C. A hiányzó függőség figyelmeztetés, nem végzetes.
- **`start.bat`** a projekt gyökerében: a tunnel-ellenőrzés még a Node *előtt*
  fut (ott derül ki, ha rendszergazdai jog kell), első indításkor `npm install`,
  nyitva maradó konzolablak, és időbélyeges sorok a `logs/startup.log`-ba.
- **Egységes, strukturált naplózó** (`server/src/log/logger.js`), amit minden
  komponens használ. A konzolra színes sor, a `logs/YYYY-MM-DD.log`-ba soronként
  egy JSON objektum, dátum szerint forogva.
- Amit a napló rögzít: a WHIP ingest létrejöttét/megszakadását (a „megállt" és a
  „megszakadt" esetet megkülönböztetve), a Socket.io fel- és lecsatlakozást az
  **OBS Browser Source-t külön jelölve** a User-Agent alapján, minden
  állapotgép-átmenetet, és **minden beállítás-változást régi és új értékkel**
  (minőség, lencse, forrás, widget, média, outro hossz, chat-linkek). Minden
  bejegyzés viszi a forrást (telefon / web UI / OBS / ingest / időzítő) és a
  kliens-azonosítót — a munkamenet-tokenből csak 6 karakteres ujjlenyomatot,
  soha nem a teljeset.
- **A négy előírt tesztforgatókönyv** futtatható tesztként
  (`server/test/scenarios.test.js`): első indítás → intro, amíg a stream be nem
  fut; 2 percnél hosszabb adás megszakadása → magától folytatódik; szünet
  reconnect-időzítő nélkül; „Befejezés" a web UI-ról → outro → időzítve `ended`.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): telepítési sorrend, indítás és
  leállítás, naplóformátum és kiolvasás, a négy forgatókönyv kézi lépéssora
  elvárt eredményekkel, hibaelhárítási táblázat.

---

## 0.10 — Biztonság és hitelesítés

*2026-08-15* · 10. szegmens

- **Három, szigorúan elkülönített jogosultsági szint:** admin (munkamenet-süti),
  telefon (streamkulcs), néző/OBS (opcionális lejátszási token). A lejátszási
  token **csak megtekintésre** jogosít — sem a sessiont nem vezérelheti, sem a
  telemetriát nem látja, és ezt teszt is védi.
- Admin bejelentkezés **scrypt-tel hash-elt** jelszóval, HttpOnly +
  SameSite=Strict munkamenet-sütivel és **double-submit CSRF tokennel**, amit a
  JavaScript külön tart (a süti önmagában nem elég egy állapotváltoztató
  kéréshez).
- **Sebességkorlátozás** IP-nként, exponenciálisan növekvő zárlattal: 5
  sikertelen próbálkozás → 30 mp, duplázódva max. 15 percig. A sikeres belépés
  nullázza a számlálót.
- A WHIP ingestet egyedi, nehezen kitalálható streamkulcs védi — ugyanaz az
  érték a MediaMTX konfigurációjában is.
- Biztonsági fejlécek (CSP, `nosniff`, `frame-ancestors`), és egy biztonsági
  helyzetkép, ami induláskor és az admin felületen is jelzi a gyenge vagy
  hiányzó titkokat.

---

## 0.9 — Stream-monitor, napló és linkek

*2026-08-15* · 9. szegmens

- **Stream-monitor:** élő technikai adatok (pillanatnyi bitráta, felbontás,
  képfrissítés, RTT, jitter, csomagvesztés) és egy kis előnézet a **nyers bejövő
  streamről** — szándékosan elkülönítve a `/live` kompozittól, csak adminnak
  szóló diagnosztikaként.
- **Letölthető napló:** minden állapotátmenet időtartamokkal, időszakonként
  átlag / min / max bitrátával, session vagy dátumtartomány szerint szűrve. CSV
  BOM-mal és pontosvesszővel a magyar Excelhez, vesszős változat a Google
  Sheetshez.
- Beágyazott grafikon a bitráta-idősorról, a megszakadások pirossal jelölve.
- **Chat-link gyűjtő:** elnevezett linkek, amik a telefonon egy koppintással új
  lapon nyílnak — kifejezetten *nem* a `0.7` beágyazott widgetjei. Csak
  `http`/`https` séma fogadható el.

---

## 0.8 — Admin web felület

*2026-08-15* · 8. szegmens

- A teljes vezérlőfelület az `/admin` címen: élő állapot, Kezdés/Befejezés
  (bármelyik felületről), kameraválasztó, felbontás / bitráta / képfrissítés /
  hang csúszkák, widget-szerkesztő, overlay-média feltöltő előnézettel, plusz a
  `0.9` monitorja és link-gyűjtője külön fülekként.
- **A web→telefon parancscsatorna.** Enélkül a két felület kicsúszik egymásból:
  miután az admin megnyomja a „Befejezés"-t, a telefon tovább publikálna és
  továbbra is „ÉLŐ"-t mutatna. A parancsok a telefon telemetria-kérésének
  válaszában utaznak — nulla plusz kérés, legfeljebb 3 másodperc késés.
- Kétirányú, valós idejű szinkron Socket.io-n, és minimalista sötét design közös
  tokenekkel (`admin.css`).

---

## 0.7 — Widget rendszer

*2026-08-14* · 7. szegmens

- Szabadon mozgatható és átméretezhető widgetek a fix 1920×1080-as vásznon,
  drag-and-drop szerkesztővel: logó (feltöltött kép), third-party beágyazás
  (chat, értesítés), szöveg és értesítés.
- A pozíció, méret, láthatóság és réteg perzisztens, tehát egy elrendezés
  **túléli a szerver újraindítását**.
- **A beágyazás-sandbox ennek a szegmensnek a lényege:** a third-party kód saját
  dokumentumban, `allow-scripts` iframe-ben fut, `allow-same-origin` **nélkül**,
  és csak widgetenkénti véletlen kulccsal érhető el. Így a beágyazott szkript
  átlátszatlan origint kap — nem éri el a szülő DOM-ját, a sütiket, és a saját
  címsorából sem tudja kiolvasni a lejátszási tokent.
- A megjelenítés inkrementális: egy chat iframe nem épül újra állapotváltáskor,
  tehát nem csatlakozik újra és nem veszti el az előzményt.

---

## 0.6 — OBS integráció

*2026-08-14* · 6. szegmens

- A `/live` kompozit oldal: egyetlen vászon, rajta az állapot-képernyő és az
  aktív overlay widgetek, átlátszó háttérrel ott, ahol nincs tartalom. Az
  OBS-ben egyetlen Browser Source, 1920×1080-ban.
- Videó **WHEP**-en (WebRTC, ~0,2–0,5 s késleltetés), automatikus HLS
  tartalékkal.
- **Lejátszás-proxy**, hogy a böngésző egyetlen originnel beszéljen, és a
  MediaMTX olvasási joga localhostra szorítva maradhasson. A proxy átírja a WHEP
  `Location` fejlécét: enélkül egy OBS-újraindítás halott olvasókat hagyna a
  MediaMTX-ben.
- A Socket.io újratöltés nélkül tartja lépésben az oldalt az
  állapotváltozásokkal és az overlay mozgatásával.

---

## 0.5 — Overlay- és médiakezelés

*2026-08-14* · 5. szegmens

- Adminként feltölthető intro / megszakadt / outro média (jpg, png, webp, mp4,
  webm), állítható outro hosszal, helyi fájltárolással és előnézettel.
- **A validáció a fájl TARTALMÁT nézi (magic bytes)**, nem a kiterjesztést és nem
  a kliens által küldött `Content-Type`-ot. Egy `.mp4`-nek nevezett HTML fájl a
  `/live` oldalba ágyazva egyébként tetszőleges szkriptet futtatna.
- Az outro lejártakor az állapotgép `ended`-be lép: a publisher-kapcsolatot
  aktívan bontjuk, így egy ottragadt telefon miatt a következő session nem
  ugorhat azonnal `live`-ba egy régi stream alapján.
- Az outro hossza futásidőben állítható — a controller függvényként kéri le, nem
  fix értékként.

---

## 0.4 — Vezérlő szerver: az állapotgép

*2026-08-12* · 4. szegmens

- Az `idle → intro → live → reconnecting / paused → outro → ended` gép **tiszta
  modulként**, injektálható órával és visszaadott mellékhatásokkal, tehát I/O
  nélkül is teljesen tesztelhető.
- **A 2 perces szabály egyetlen döntést befolyásol:** hogy egy megszakadás a
  „Megszakadt" képernyőt hozza (≥ 2 perc élő adás) vagy a „Hamarosan kezdünk"-et
  (alatta). Semmi mást.
- A `paused` független a küszöbtől, és nincs backoff-időzítője: a stream
  visszatérése **nem** szünteti meg, csak az explicit „Folytatás".
- Minden átmenethez Socket.io esemény tartozik, így a web UI és a Browser Source
  valós időben követi.
- **Az ingest-jelzés szintvezérelt, nem élvezérelt.** A hibát egy végponttól
  végpontig teszt fogta meg: ha a „Kezdés"-t akkor nyomták meg, amikor a telefon
  már publikált, nem keletkezett felfutó él, és a szerver `intro`-ban ragadt egy
  élő stream mellett. Mostantól minden mintavételnél az aktuális helyzet megy át,
  a gép pedig idempotens.

---

## 0.3 — Media ingest réteg

*2026-08-12* · 3. szegmens

- MediaMTX konfiguráció: WHIP be; WebRTC, RTMP és alacsony látenciájú HLS ki.
- **Ingest-figyelés két csatornán.** A pull (másodpercenként pollozott API) az
  igazság forrása; a push (a `runOnReady` / `runOnNotReady` hookok) csak azonnali
  mintavételt kér. Így egy hook siettetheti a döntést, de sosem hazudhat.
- A `ready: true` önmagában nem elég — a publisher csatlakozva maradhat úgy is,
  hogy közben megállt az adatfolyam, ezért a `bytesReceived` mozgása számít. Ez
  különbözteti meg a „megállt"-at a „megszakadt"-tól.
- A megszakadás jelentése debounce-olt (alapból 3 mp), hogy egy pillanatnyi
  hálózati zökkenő ne villogtassa a `/live` oldalt; a helyreállás viszont
  azonnali.
- Health-check végpont, valamint telepítő és ingest-próba szkript.

---

## 0.2 — Android alkalmazás: capture és publish

*2026-08-12* · 2. szegmens

- Kamerakép CameraX-szel, élő lencseváltás (elő / fő / tele / nagylátószögű) egy
  másodpercen belül, vaku, fotómentés és párhuzamos helyi felvétel.
- **Képernyő mód** MediaProjectionnel, és egygombos kamera↔képernyő váltás.
- Mikrofon-felvétel minőségválasztókkal; a felbontás, bitráta és képfrissítés
  felmegy a szervernek, így az admin felületen látszik, mivel megy az adás.
- **WHIP publish** (RFC 9725) WebRTC-n, automatikus újracsatlakozással,
  exponenciális backoff-fal.
- **Háttérfutás**, ami ezt a gyakorlatban használhatóvá teszi: a teljes capture
  lánc Foreground Service-ben fut (nem az Activityben), az Android 14-es FGS
  típusokkal (`camera|microphone|mediaProjection`), wake lockkal, az
  akkumulátor-optimalizálás alóli felmentés kérésével és állandó értesítéssel,
  amin Szünet/Leállítás gomb van. A PIP ráadás, nem a mechanizmus.
- Az app semmit nem tud az intróról, az outróról vagy az overlay-ről. Csak azt
  jelenti, mit nyomott meg a felhasználó: `POST /session/start`, `/pause`,
  `/resume`, `/end`.

---

## 0.1 — Architektúra és hálózati réteg

*2026-08-12* · 0–1. szegmens

- [`ARCHITECTURE.md`](ARCHITECTURE.md): a négy komponens és szigorúan
  elkülönített felelősségi köreik, azzal együtt, hogy melyik komponens miért
  **nem** felelős. Minden későbbi szegmens erre hivatkozik vissza.
- **Cloudflare Tunnel** port-forwarding és dinamikus DNS helyett: kifelé indított
  kapcsolat, tehát NAT és CGNAT mögül is működik, és a címek IP-váltás vagy
  újraindítás után sem változnak. Három subdomain — admin, live, ingest.
- Windows service-ként telepítve, watchdoggal, ami három szinten ellenőriz
  (folyamat, konnektor, publikus végpont) és automatikusan újraindítja az
  alagutat. Ha maga a Node szerver áll, az nem az alagút hibája — a watchdog
  ilyenkor nem nyúl hozzá.
- Őszintén dokumentálva: **a WHIP jelzés átmegy az alagúton, a WebRTC média
  nem** — ahhoz TURN vagy Tailscale kell. Azzal együtt, hogy mi történik, ha az
  alagút szakad meg, és mi, ha csak a telefon hálózata.
