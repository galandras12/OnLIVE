# Changelog

[In English](CHANGELOG.md)

Az OnLIVE előre rögzített, **tizenegy szegmensből** álló terv szerint épült.
Minden szegmens egy önálló, működő réteget adott hozzá, és a felelősségi körök
sosem csúszhattak át egymásba (lásd [`ARCHITECTURE.md`](ARCHITECTURE.md)).

Az *N*. szegmens a **0.N** verzióként jelenik meg, az **1.0.000** pedig lezárja
az alap szakaszt. A belső dokumentumok továbbra is „szegmenseket" emlegetnek —
ez a fájl a kettő közti megfeleltetés.

---

## 1.0.014 — 16 KB-os lapméret, rögzített eszközlánc

*2026-08-16*

A Galaxy S26 Ultra *„Az alkalmazás nem kompatibilis a 16 kB-os mérettel — az
ELF-igazítási ellenőrzés sikertelen"* párbeszéddel fogadta az appot, négy natív
könyvtárat felsorolva. Az új eszközök 16 KB-os memórialapokkal futnak, és minden
`.so`-nak ehhez igazítva kell lennie.

Az igazítás **a könyvtárak dolga**, ezért a megoldás verziófrissítés — az
alábbiak már igazított kiadások:

| Könyvtár | Volt | Lett | Melyik `.so`-t javítja |
|---|---|---|---|
| CameraX | 1.3.4 | 1.6.1 | `libimage_processing_util_jni.so` |
| DataStore | 1.1.1 | 1.2.1 | `libdatastore_shared_counter.so` |
| Compose BOM | 2024.09.02 | 2026.06.01 | `libandroidx.graphics.path.so` |
| WebRTC | 125.6422.07 | 144.7559.12 | `libjingle_peerconnection_so.so` |

A mi oldalunkon csak a csomagolás számít: a `jniLibs { useLegacyPackaging = false }`
mostantól ki van mondva, tehát a natív fájlok tömörítetlenül, laphatárra
igazítva kerülnek az APK-ba (az AGP minSdk 23 felett alapból is így csinálja).

### Eszközlánc

- **AGP 8.5.2 → 8.13.2.** Ez szünteti meg a *„tested up to compileSdk = 34"*
  figyelmeztetést — a projekt 35-tel fordít.
- **A Gradle verziója rögzítve** a `gradle/wrapper/gradle-wrapper.properties`-ben
  (9.3.0, a mellé bekerült wrapperrel együtt). Eddig egyáltalán nem volt
  wrapper-beállítás, ezért az Android Studio azt használta, ami épp nála volt, és
  a build gépről gépre más lett. A minimumot az AGP maga ellenőrzi — magukból az
  AGP jarokból kiolvasva: **AGP 8.13.x → Gradle ≥ 8.13, AGP 9.x → ≥ 9.5**. A
  8.13.2 tehát elégedett a 9.3.0-val, és a 9.7.0-ra lépéshez sem kell AGP-t
  váltani.
- **Kotlin 2.0.20 → 2.3.21**, a `kotlinOptions` helyett a mai
  `kotlin { compilerOptions { … } }` blokkal, plusz frissült a core-ktx, a
  lifecycle, az activity-compose és a coroutines.

> Minden verzió a tényleges Maven-metaadatból lett ellenőrizve, de ebben a
> környezetben nincs Android SDK: **magát a fordítást nem tudtam kipróbálni**.
> Ha a Gradle sync elakad, ez a commit önmagában visszavonható — az 1.0.013-as
> kamerajavítások nem függenek tőle.

---

## 1.0.013 — Végre van kamerakép, és a lencseváltás is működik

*2026-08-16*

Három tünet egy Galaxy S26 Ultrán, egy közös gyökérrel — plusz egy külön hiba.
Mindkettő az appban volt.

### Fekete előnézet, néma lencsegombok

A capture a Service-ben él, hogy az adás túlélje az appváltást. A kamerát
viszont **kizárólag a „Kezdés"** indította el, tehát az app megnyitásakor
egyáltalán nem volt bekötött kamera: a kép fekete maradt, és mivel a
`cameraSource` addig `null` volt, a lencsegombok, a vaku és a fotó gomb sem
csinált semmit.

Mostantól van előnézeti mód: a Service elindítja a kamerát, amikor az Activity
láthatóvá válik (`ACTION_PREVIEW`), és elengedi, amikor eltűnik — kivéve, ha
megy az adás, olyankor érintetlenül streamel tovább. A „Kezdés" már csak a WHIP
kapcsolatot építi fel a **már futó** kamera mellé.

Előnézet közben a képkocka-konverzió ritkított (~2 fps): a WebRTC oldali fogadó
ilyenkor `null`, tehát az 1080p30-as YUV → I420 átalakítás eredményét úgyis
eldobnánk — csak a CPU-t és az akkumulátort enné. A ritkított képkockára a
„kép mentése" gombnak van szüksége.

### Nem lehetett optikát váltani

A lencse-felderítés a `cameraIdList`-et járta be, majd a CameraX kameráit
`Camera2CameraInfo.cameraId` szerint szűrte. Modern telefonokon viszont a
hátlapi optikák **egyetlen logikai kamera** mögött vannak: a `cameraIdList` csak
azt az egyet adja vissza, a tele és a nagylátószögű pedig *fizikai* alkamera,
amelyek azonosítóját a CameraX sosem jelenti. A szűrő így mindig üresre futott,
a tartalék ág ugyanazt a kamerát adta vissza, a váltás pedig némán elmaradt.

Mostantól a fizikai alkamerák a `getPhysicalCameraIds()`-ből jönnek (API 28+),
fókusztávolság szerint besorolva, a váltás pedig **zoom-aránnyal** történik
(fókusz ÷ fő fókusz, a kamera valós zoom-tartományára vágva) — így választ a
rendszer fizikai optikát. Az elő ↔ hátlapi váltás maradt `CameraSelector`, mert
az tényleg külön kamera.

Kellemes mellékhatás: a hátlapi optikák közti váltás már nem jár újrakötéssel,
tehát azonnali — nem esik ki 300–800 ms kép.

### Fordítási figyelmeztetések

`Icons.Filled.ArrowBack` / `ScreenShare` → az `AutoMirrored` változatokra, és
kikerült az `@OptIn(ExperimentalCamera2Interop::class)`, amit a mai CameraX már
nem kér (a fordító is jelezte, hogy nincs hatása).

> Csak olvasással és statikus ellenőrzéssel igazolva — ebben a környezetben
> nincs Android SDK, tehát a fordítást és az eszközön mutatott viselkedést a te
> gépeden kell kipróbálni.

---

## 1.0.012 — start.bat: az eltűnő ablak javítása, lépésenkénti kiírás

*2026-08-16*

### Javítva: az ablak felvillant és eltűnt

A `start.bat` megnyílt és azonnal bezárult, anélkül hogy bármit mutatott volna.
Az okozó egyetlen escape-eletlen karakter volt:

```bat
if errorlevel 1 (
    echo   [!] A(z) "%TUNNEL_SERVICE%" service nincs telepitve.
```

Zárójeles blokkon belül az `A(z)` escape-eletlen `)` jele **lezárja a blokkot**,
így a későbbi `) else (` szintaktikai hibává vált, a cmd pedig megszakította az
egész fájlt — még mielőtt bármi hasznosat csinált volna.

A javítás nem a gondosabb escape-elés, hanem a veszély megszüntetése: a szkript
mostantól `goto`-val ágazik el, és **egyetlen zárójeles blokkot sem tartalmaz**,
így ez a hibaosztály nem térhet vissza. A `server/test/start-script.test.js`
őrzi ezt, azzal együtt, hogy a fájl tisztán ASCII, CRLF sorvégű, minden `goto`
célja létezik, és minden hibaút a közös `:end`-en, `pause`-zal ér véget. A régi
fájlon ellenőrizve: ott bukik.

### Új: látszik, hol tart az indulás

```
   [1/5] Cloudflare Tunnel ellenorzese
         OK   A tunnel service mar fut.
   [2/5] Node.js ellenorzese
         OK   Node.js v22.11.0
   [3/5] Port ellenorzese
         OK   A szerver a 8080-es porton fog indulni.
         Helyi cim:  http://localhost:8080/admin
```

- A **port és a helyi cím még az indítás előtt kiíródik**, és a szkript szól, ha
  a portot már használja valami („ha most EADDRINUSE hibával áll meg, ez az
  oka"). A port a szerver saját konfigurációjából jön az új
  `server/tools/port.js`-en keresztül, tehát azt mutatja, amit a Szerver fülön
  beállítottál.
- Az `npm` meglétét a `node`-tól külön ellenőrzi, a sikertelen `npm install`
  pedig magyarázattal áll meg, nem később, értelmezhetetlen hibával.
- Leállás után kiírja a **napló utolsó 20 sorát**, a JSON rekordokból
  formázva — így egy gyors összeomlás oka akkor is látszik, ha a konzol már
  elgörgött.
- Minden út — a hibásak is — nyitva hagyott ablakkal és érthető üzenettel ér
  véget. Minden lépés bekerül a `logs/startup.log`-ba is, tehát egy kemény
  értelmezési hiba után is látszik, meddig jutott.

**172 teszt, mind zöld.**

---

## 1.0.011 — Állítható szerver-port, új alapértelmezés: 8080

*2026-08-16*

- **A port a webes felületről állítható** — új **Szerver** fül. A módosítás a
  **következő indításkor** lép életbe: futó szervernek nem cserélhető a portja
  anélkül, hogy minden nyitott kapcsolat (Socket.io, lejátszás-proxy, éppen
  zajló adás) el ne szakadna, ezért a beállítás eltárolódik, és induláskor
  érvényesül.
- **Az alapértelmezett port 8080** (eddig 3000). A sablon-konfigurációk, a
  telepítő, a watchdog és a dokumentáció is átállt vele.
- Sorrend, ha több helyen is meg van adva: a felületen beállított érték, utána
  az `ONLIVE_SERVER_PORT`, végül a 8080. A felületi érték szándékosan erősebb —
  a `.env` egyszer, telepítéskor íródik, a felületen viszont az üzemeltető most
  állít; fordítva a gomb néma maradna mindenkinél, aki a sablon `.env`-et
  használja.
- **A port három másik fájlban is szerepel**, és ha azok a régin maradnak, a
  rendszer némán romlik el: a publikus címek 502-t adnak, a telefon pedig
  401-et kap a WHIP-en. Ezért a Szerver fül kiírja a pontos sorokat, a szerver
  pedig **induláskor összeveti ezeket a fájlokat a saját portjával**, és jelzi
  az eltérést:

  ```
  HIBA  MediaMTX hitelesítés: a(z) C:\OnLIVE\mediamtx\mediamtx.yml még a 3000
        portra mutat, a szerver viszont a 8080-on hallgat.
  ```

- Az 1024 alatti és a tipikusan foglalt portokat (3306, 8888, 9997 …)
  elfogadjuk, de figyelmeztetünk rájuk — ez mérlegelés kérdése, nem hiba.

**164 teszt, mind zöld.** A teljes életciklus élő szerveren ellenőrizve:
beállítás a felületen → újraindítás → az új porton jön fel, a régin pedig már
nem válaszol senki.

---

## 1.0.010 — Streamkulcs a webes felületen, kapcsolat-beállítás a telefonon

*2026-08-16*

Eddig a streamkulcs a `.env`-ben állt nyers szövegként, és ugyanazt az értéket
kézzel kellett a MediaMTX konfigurációjába is bemásolni. Ettől a verziótól a
webes felületen jön létre, és **kizárólag a hash-e tárolódik**.

### Streamkulcs-kezelés (webes felület)

- Új **Streamkulcs** fül az admin felületen: generálható kulcs (32 karakter,
  kriptográfiai véletlenből), vagy megadható saját.
- Követelmények, mindkét oldalon kikényszerítve: **legalább 16 karakter**,
  kisbetűvel, nagybetűvel, számmal és speciális karakterrel. Az űrlap gépelés
  közben jelzi, melyik feltétel teljesül; mentéskor a szerver újra ellenőriz,
  tehát a felület megkerülése nem enged át gyenge kulcsot.
- A nyers kulcs **pontosan egyszer** hagyja el a szervert: a létrehozás
  válaszában, amit az oldal egyszer megmutat, másolás gombbal. Utána sehonnan
  nem olvasható vissza.
- A tárolás **scrypt hash** (`data/stream-key.json`), ugyanaz az eljárás, mint
  az admin jelszónál. Ujjlenyomatot vagy „emlékeztetőt" sem tárolunk a
  kulcsból: egy gyors hash a fájl mellett kioltaná a scrypt lassúságát, vagyis
  épp azt a védelmet, amiért választottuk.
- Új kulcs létrehozása a régit azonnal érvényteleníti. Az állapot-panel mutatja,
  mikor jött létre és mikor használták utoljára — az értékét soha.

### A MediaMTX már nem tárol jelszót

Ettől igaz a „csak hash-elve" végponttól végpontig: a MediaMTX minden
hitelesítési kérdést a vezérlő szerverhez továbbít (`authMethod: http` →
`POST /api/ingest/auth`), az pedig a hash ellen ellenőriz. A `mediamtx.yml`-be
így semmilyen titok nem kerül.

A végpont csak localhostról hívható, a sikertelen publish-kísérletek pedig
ugyanabba az IP-nkénti zárlatba futnak, mint a bejelentkezés. Egy üzemeltetési
következmény, dokumentálva: ha a vezérlő szerver áll, a MediaMTX minden
publikálást elutasít — a „401 a WHIP-en" tehát előbb jelent álló Node szervert,
mint rossz kulcsot.

### Android: a fogaskerék mögött végre valódi beállítások

- A fogaskerék teljes képernyős beállítás-oldalra visz a korábbi szűk minőség-
  párbeszéd helyett.
- **Kapcsolat** szekció: streamkulcs (rejtve, szem ikonnal megmutatható) és a
  Cloudflare Tunnel címei — vezérlő szerver, ingest, stream útvonal, ingest
  felhasználó.
- **Kapcsolat tesztelése** gomb: egyetlen `GET /api/session/ping` megmondja,
  jó-e a cím és a kulcs, anélkül hogy adást kellene indítani. A hibaüzenetek
  konkrétak — rossz kulcsnál a webes felületre irányít.
- Mellette **TURN** és **Minőség** szekció; a rendszer vissza-gombja a
  beállításokat zárja, nem az appot.

### Javítva

- **Az admin oldal teljes JavaScriptje halott volt a böngészőben.** Még a 10.
  szegmensben egy sortörés csúszott egy aposztrófos szöveg közepébe az
  `admin.html`-ben (`join('` … `')`), amitől az egész beágyazott szkript
  értelmezhetetlenné vált: a fülek, a Kezdés/Befejezés gombok, az élő állapot és
  a védelem-jelző sem csinált semmit. Ennek a kiadásnak a tesztelése közben
  derült ki, valódi fejetlen böngészővel.
- Új tesztfájl (`test/web-pages.test.js`) minden kiszolgált oldal minden
  beágyazott szkriptjét elemzi, így szintaktikai hiba többé nem juthat át
  észrevétlenül. A régi, hibás fájlon ellenőrizve: ott bukik.

**146 teszt, mind zöld.**

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
