# OnLIVE — 2. szegmens: Android alkalmazás (capture és publish)

> A telefon **kizárólag adatfolyam-forrás**. Nincs benne overlay, intro, outro,
> logó vagy bármilyen kompozíciós logika — ez tudatos döntés
> (lásd [`ARCHITECTURE.md`](../ARCHITECTURE.md) 2.1). Az app annyit tesz, hogy
> képet és hangot küld, és jelzi a szervernek, hogy a felhasználó mit nyomott meg.

Forrás: [`android/`](../android). Csomag: `com.galandras.onlive`.

---

## 1. Miért Foreground Service, és miért nem az Activity

Ez a szegmens legkritikusabb pontja. Ha a capture/kódolás/publish az Activity
életciklusához kötődik, appváltáskor az `onStop()` leállítja a kamerát, és az
adás megszakad. Ezért:

| Réteg | Osztály | Felelősség |
|---|---|---|
| UI | `MainActivity`, `ui/OnLiveScreen.kt` | csak megjelenítés és gombok |
| Motor | `stream/StreamService.kt` | capture, kódolás, publish, állapot, reconnect |

Az Activity bármikor megállhat, elforgatható, PIP-be tehető, vagy a rendszer
meg is ölheti — a Service él tovább, és streamel.

A kettő között **nincs binder/AIDL**: a kommunikáció egy processz-szintű
állapotbuszon megy (`stream/StreamState.kt` → `StreamBus`). Az Activity
`StateFlow`-t figyel, és `Intent`-akciókat küld a Service-nek. Így az Activity
újraéledésekor azonnal a valós állapotot látja, kötés-újraépítés nélkül.

### 1.1 CameraX a Service lifecycle-jához kötve

```kotlin
class StreamService : LifecycleService() { … }

// és a kamera kötése:
cameraProvider.bindToLifecycle(
    lifecycleOwner,   // ← a StreamService, NEM az Activity
    selector, preview, imageAnalysis, videoCapture,
)
```

A `LifecycleService` (androidx.lifecycle:lifecycle-service) saját, a Service
élettartamához kötött `Lifecycle`-t ad. Ha itt az Activity lenne a
`LifecycleOwner`, az `onStop()` leállítaná a kamerát appváltáskor.

A preview felületét az Activity „kölcsönadja”:

```kotlin
// Activity oldal (Compose):
PreviewView(context).apply { StreamBus.attachPreview(surfaceProvider) }

// Service oldal:
StreamBus.surfaceProvider.collect { cameraSource?.setSurfaceProvider(it) }
```

Ha nincs UI, a `SurfaceProvider` `null` — a kamera-session ettől érintetlen marad.

### 1.2 Foreground service típusok (Android 14 / API 34)

A manifest deklarálja mindhárom típust, mert mindhármat használjuk:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />

<service
    android:name=".stream.StreamService"
    android:exported="false"
    android:stopWithTask="false"
    android:foregroundServiceType="camera|microphone|mediaProjection" />
```

Futásidőben viszont **csak az éppen aktív típusokat** adjuk át:

```kotlin
val types = when (source) {
    CaptureSource.CAMERA -> FOREGROUND_SERVICE_TYPE_CAMERA or FOREGROUND_SERVICE_TYPE_MICROPHONE
    CaptureSource.SCREEN -> FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or FOREGROUND_SERVICE_TYPE_MICROPHONE
}
ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types)
```

**Két buktató, amit a kód kezel:**

1. A `startForegroundService()` után **5 másodpercen belül** kötelező a
   `startForeground()` — ezért az `onStartCommand()` legelső dolga ez, minden
   suspend munka előtt. Különben `ForegroundServiceDidNotStartInTimeException`.
2. Android 14-től a `mediaProjection` típusú foreground service-nek **már
   futnia kell**, mielőtt a `MediaProjectionManager.getMediaProjection()`
   meghívódik. A `StreamService.startScreenCapture()` ezt a sorrendet tartja:
   előbb `promoteToForeground(SCREEN)`, csak utána `ScreenSource.start(...)`.

### 1.3 WakeLock

```kotlin
wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OnLIVE::StreamWakeLock")
wakeLock.acquire(6 * 60 * 60 * 1000L)   // 6 órás biztonsági plafon
```

A `PARTIAL_WAKE_LOCK` a CPU-t tartja ébren kikapcsolt képernyőnél is. A
felszabadítás a `Befejezés`-nél és a Service `onDestroy()`-ában történik; a
timeout csak biztonsági háló, ha valami elakadna.

### 1.4 Akkumulátor-optimalizálás és a Samsung „alvó appok"

**A helyes Foreground Service implementáció önmagában nem elég.** Két további
réteg tud leállítani egy órákig futó adást:

| Réteg | Kezelés | Kód |
|---|---|---|
| Rendszerszintű Doze | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent, első indításkor felajánlva | `util/BackgroundPermissions.requestIgnoreBatteryOptimizations()` |
| Samsung One UI „Alvó alkalmazások” | nincs API — a felhasználót visszük el a beállításokhoz, egyszeri, elvethető instrukcióval | `util/BackgroundPermissions.openOemBatterySettings()` |

A Samsung-instrukció szövege konkrét útvonalat ad: **Beállítások → Akkumulátor →
Háttérhasználat-korlátozások**, és az OnLIVE felvétele a „Sosem alszik” listára.
A „Ne kérdezd újra” választás a DataStore-ban tárolódik.

### 1.5 Kitartó notification gyors műveletekkel

`util/Notifications.kt` — mutatja az aktuális állapotot (`ÉLŐ`, `Újracsatlakozás…`,
`Szüneteltetve`, `Hiba`), a bitrátát/fps-t/RTT-t, a helyi felvétel tényét, és
tartalmaz akciógombokat: **Szünet / Folytatás** és **Befejezés**. Így nem kell
visszaváltani az appra. A csatorna `IMPORTANCE_LOW` (csendes, de mindig látható).

### 1.6 Picture-in-Picture

`MainActivity.onUserLeaveHint()` → `enterPictureInPictureMode()`, API 31+
esetén `setAutoEnterEnabled(true)`. PIP-ben a Compose UI elrejti a vezérlőket,
csak a kép látszik.

**A PIP kiegészítő, nem a védelem.** Az adatfolyam folytonosságát a Foreground
Service + wakelock + akku-kizárás adja; a PIP csak vizuális visszajelzés.

---

## 2. Capture-források

### 2.1 Kamera (CameraX)

- `Preview` — a UI-nak (opcionális felület).
- `ImageAnalysis` (`YUV_420_888`, `KEEP_ONLY_LATEST`) — innen jön a WebRTC képe.
- `VideoCapture<Recorder>` — a párhuzamos helyi MP4-hez.

A képkockák útja: `ImageAnalysis` → `ImageProxyConverter.toI420()` →
`VideoFrame` → `FrameFanout` → WebRTC `VideoSource`.

**Lencse-választás (1.0.013-tól zoom-aránnyal).**

A korábbi megoldás a `cameraIdList`-ből próbálta kigyűjteni a fizikai lencséket,
és `Camera2CameraInfo.cameraId` szerint szűrt. Ez modern telefonokon **nem
működik**: a hátlapi optikák egyetlen *logikai* kamera mögött vannak, a
`cameraIdList` csak azt az egyet adja vissza, a tele és a nagylátószögű pedig
fizikai alkamera. Az azonosítós szűrő így mindig üresre futott, a tartalék ág
ugyanazt a kamerát adta vissza, és a váltás **némán elmaradt** — Galaxy S26
Ultrán is pontosan ez történt.

A mostani megoldás (`stream/CameraSource.enumerateLenses()`):

| Lépés | Hogyan |
|---|---|
| Felderítés | a hátlapi logikai kamera `getPhysicalCameraIds()` listája (API 28+), és mindegyik fókusztávolsága |
| Besorolás | a fő optikához képest rövidebb fókusz → nagylátószögű, hosszabb → tele |
| Váltás | **zoom-arány** (`fókusz / fő fókusz`, pl. 17 mm / 6,4 mm ≈ 2,7×), a kamera tényleges `zoomState` tartományára vágva |
| Elő ↔ hátlapi | `CameraSelector.DEFAULT_FRONT_CAMERA` / `DEFAULT_BACK_CAMERA` — ez tényleg külön kamera |

Csak a ténylegesen létező lencsék jelennek meg chipként az UI-n.

**Élő lencseváltás.** Azonos oldalon belül (fő ↔ tele ↔ nagylátószögű) **nincs
újrakötés**: csak a zoom-arány áll át, amitől a rendszer maga vált fizikai
optikát — a váltás azonnali, egyetlen képkocka sem esik ki. Oldalváltásnál
(elő ↔ hátlapi) új Camera2 session kell, ott marad a **300–800 ms kép-kiesés**.
A WebRTC session egyik esetben sem szakad meg: ugyanaz a `VideoSource` és
`PeerConnection` marad, a szerver oldali állapot végig `live`.

### 2.2 Képernyő (MediaProjection)

`stream/ScreenSource.kt` **saját `MediaProjection` példányt** kezel, nem a
WebRTC `ScreenCapturerAndroid`-ját. Ok: a `ScreenCapturerAndroid` belül hozza
létre és nem adja ki a projekciót, egy hozzájárulási tokenből viszont csak
egy projekció nyerhető — így nem maradna mód a párhuzamos helyi felvételre.

Saját kezelésben két `VirtualDisplay` készül ugyanabból a projekcióból:

1. `SurfaceTextureHelper` felületére → WebRTC textúra-frame-ek (**zero-copy**),
2. `MediaRecorder` felületére → helyi MP4.

Android 14+ követelmény: `MediaProjection.registerCallback()` **kötelező** a
`createVirtualDisplay()` előtt — a kód ezt megteszi, és a rendszer általi
leállítást (`onStop`) is kezeli (automatikus visszaváltás kamerára).

### 2.3 Kamera ↔ képernyő váltás egy gombbal

A forrásváltó chip ikonja 1.0.101 óta **Chromecast** a képernyő-módhoz — ez az,
amit a felhasználók a „másik kijelzőre küldöm a képet" jelentéssel azonosítanak.
A lencseválasztó pedig **csúszka** lett: a ténylegesen elérhető optikák egy
tengelyen állnak (nagylátószögű → fő → tele, a végén az arcképes), tehát végig
lehet húzni rajtuk ahelyett, hogy minden váltás külön koppintás lenne. A lista
eszközfüggő — a `CameraSource` a fizikai kamerákból állítja össze —, ezért a
csúszka lépésszáma is abból jön, nem fix számból.

A váltás **nem igényel WebRTC újratárgyalást**: egyetlen `VideoSource` van, és
csak az változik, melyik capturer tolja bele a képet. A `PeerConnection`, az
SDP és a WHIP session érintetlen — a szerver oldalon nincs szakadás.

---

## 3. Hang

- Capture: a WebRTC `JavaAudioDeviceModule` (mikrofon).
- Feldolgozás kikapcsolva (`AEC`, `AGC`, `NS`, highpass) — élő közvetítésnél ez
  a kívánatos, különben a zene és a háttérhang torzul.
- **Mintavétel** (16 / 44,1 / 48 kHz): az `AudioDeviceModule` a
  `PeerConnectionFactory`-hoz kötődik, ezért a változtatás új motort igényel.
  A `StreamService.ensureEngine()` ezt kezeli — session közben nem fordulhat elő.
- **Bitráta** (32/64/96/128 kbps): SDP-szinten, az Opus `maxaveragebitrate`
  paraméterén keresztül (`webrtc/SdpUtils.setOpusBitrate`).

---

## 3.1 Kamera-előnézet (1.0.013)

A capture a Service-ben él, hogy az adás túlélje az appváltást — ez viszont
sokáig azt is jelentette, hogy a kamera **csak a „Kezdés"-re indult el**.
Következmény: az app megnyitásakor fekete kép, és mivel a `cameraSource` addig
`null` volt, a lencseváltás, a vaku és a fotó gomb sem csinált semmit.

Mostantól külön előnézeti mód van:

| Mikor | Mi történik |
|---|---|
| az Activity láthatóvá válik (`onStart`) | `ACTION_PREVIEW` → a Service elindítja a kamerát, adás **nélkül** |
| a felhasználó „Kezdés"-t nyom | a meglévő kamera mellé felépül a WHIP kapcsolat |
| az Activity eltűnik (`onStop`) | `ACTION_PREVIEW_STOP` → ha **nem** megy adás, a kamera elengedve; adás közben figyelmen kívül hagyva |

Előnézet közben a képkocka-konverzió **ritkított** (~2 fps): a WebRTC oldali
fogadó ilyenkor `null`, tehát a YUV → I420 átalakítás eredményét úgyis eldobnánk
— 1080p30-nál ez folyamatos, felesleges CPU- és akkumulátor-terhelés lenne. A
ritkított képkockára a „kép mentése" gombnak van szüksége.

---

## 4. Beállítás-képernyő (fogaskerék)

A jobb felső **fogaskerék** teljes képernyős beállításokra visz (1.0.010) —
korábban egy szűk párbeszédablak volt, amiben csak a minőség fért el. Három
szekció:

**Kapcsolat.** A streamkulcs és a Cloudflare Tunnel címei:

| Mező | Mi ez |
|---|---|
| Streamkulcs | a **webes felületen** létrehozott kulcs (Admin → Streamkulcs). Rejtett mező, szem ikonnal megmutatható |
| Vezérlő szerver | ide mennek a gombnyomások (`admin.galandras.com`) |
| Ingest (WHIP) | ide megy a kép (`ingest.galandras.com`) |
| Stream útvonal / Ingest felhasználó | a publish cím és a Basic név |

A **Kapcsolat tesztelése** gomb `GET /api/session/ping` hívást küld a mentett
adatokkal, és megmondja, jó-e a cím és a kulcs — nem kell adást indítani
ahhoz, hogy kiderüljön egy elgépelés. A hibaüzenet konkrét: rossz kulcsnál a
felületre irányít, 404-nél azt írja, hogy nem OnLIVE szerver válaszol.

> A kulcsot azért kell kézzel átmásolni, mert a szerver **csak a hash-ét
> tárolja** ([`SECURITY.md`](SECURITY.md) 3.): visszaolvasni sehonnan nem
> lehet. Ha elveszett, a felületen kell újat generálni.

**TURN relay.** A WHIP jelzés átmegy a Tunnelen, a média nem — mobilhálózatról
ehhez TURN kell ([`NETWORKING.md`](NETWORKING.md) 3.).

**Minőség.** Felbontás, képfrissítés, bitráta, hang — lásd alább.

A rendszer vissza-gombja a beállításokat zárja, nem az appot: adás közben egy
véletlen kilépés a közvetítést szakítaná meg.

---

## 4.1 Minőségi beállítások és visszajelentés a szervernek

| Beállítás | Hatás | Újratárgyalás? |
|---|---|---|
| Felbontás | `VideoSource.adaptOutputFormat()` + CameraX újrakötés | nem |
| Képfrissítés | Camera2 `CONTROL_AE_TARGET_FPS_RANGE` + `adaptOutputFormat()` | nem |
| Videó bitráta | `RtpSender.parameters.encodings.maxBitrateBps` | nem |
| Hang bitráta | Opus `maxaveragebitrate` (SDP) | igen, új session-nél |
| Hang mintavétel | új `PeerConnectionFactory` | igen, új session-nél |

Minden változás felmegy a vezérlő szervernek (`POST /api/session/config`), és
3 másodpercenként telemetria is (`POST /api/session/stats`: bitráta, fps, RTT,
csomagvesztés, uptime) — **így látszik az admin web UI-n, épp mivel megy az adás**.

---

## 4.2 Kép-irány: 16:9 fekvő és 9:16 álló (1.0.101)

A főképernyőn a forgatás-ikonos gomb, a beállításokban a **Kép-irány** chipek,
a web felületen az **Admin → Vezérlés → Kép-irány** — mind ugyanazt az egy
értéket állítják.

Amit fontos érteni: az irányt **nem az dönti el, ahogy a telefont tartod**. A
capture use case-ek `targetRotation`-jét állítjuk be fixen
(`StreamOrientation.surfaceRotation`), tehát a kép aránya akkor sem billen át,
ha a készülék megmozdul a kézben. Enélkül az OBS jelenet és az overlay-ek — amik
egyetlen arányra vannak szabva — menet közben elcsúsznának.

- A felbontás-választás a **szenzor koordinátáiban** történik, ami mindig
  fekvő; a 9:16-os kimenetet a forgatás adja. Ezért marad a `ResolutionSelector`
  bemenete a fekvő méret.
- A WebRTC felé viszont a **cserélt** méret megy
  (`Settings.captureWidth/captureHeight`), különben a kódoló 16:9-re skálázná a
  9:16-os képet, és fekete sávok kerülnének rá.
- **Élő adás közben nem vált**: a telefon ilyenkor elmenti az értéket, kiírja,
  hogy a következő indításnál lép életbe, és a főképernyőn a gomb is inaktív.
  A szerver ugyanezt jelzi vissza a web felületen.
- A **képernyő-megosztásra nem vonatkozik**: ott a képernyő aránya adott, azt
  nem mi választjuk meg.

Az előnézet ugyanebben az arányban áll (`Modifier.aspectRatio`), `FIT_CENTER`
skálázással — vagyis pontosan azt mutatja, ami az adásba kerül. Korábban
kitöltötte a kijelzőt, tehát a szélén olyan is látszott, ami a streambe már nem
fért bele.

## 4.3 Helyi elérés: LAN és Tailscale (1.0.101)

A *Helyi elérés* szekcióban a szerver helyi címe adható meg, a **Kapcsolat mód**
pedig eldönti, mikor használjuk. A döntés tiszta függvény
(`settings/Endpoints.kt`), a hálózati próbát a `ControlApi` végzi:

- `AUTO` módban egy **1,5 másodperces** próba fut a helyi `/api/session/ping`-re
  (külön, rövid időzítésű OkHttp kliens — a rendes 8 másodperc itt azt
  jelentené, hogy mobilneten ennyit áll a „Kezdés" gomb), és az eredmény
  30 másodpercig érvényes;
- bármilyen HTTP válasz „elérhető"-nek számít: a 401 kulcs-probléma, nem
  útvonal-probléma, azon az alagút sem segítene;
- a választás **indoka** felkerül a főképernyőre és a kapcsolat-teszt
  eredményébe is — a néma útvonalválasztás pont olyan nehezen kereshető hiba
  lenne, mint amilyeneket eddig javítottunk.

Miért éri meg: a Cloudflare Tunnelen a WHIP jelzés átmegy, a **média nem**
(lásd [`NETWORKING.md`](NETWORKING.md) 3. fejezet). Helyi úton viszont a kép a
hálózaton belül marad — TURN nélkül is van adás, és kisebb a késleltetés.

## 4.4 Névjegy (1.0.101)

A beállítások alján az alkalmazás neve és verziója áll, a `BuildConfig`-ból
(`versionName` / `versionCode`), nem a felületre írt szövegként — így a kiadás
verziószáma egyetlen helyen él, a `app/build.gradle.kts`-ben.

---

## 5. WHIP publish

`webrtc/WhipClient.kt` — RFC 9725:

1. `POST <ingest>/<stream>/whip`, törzs: SDP offer, `Content-Type: application/sdp`,
   `Authorization: Basic base64("publisher:<streamKey>")`
2. válasz `201 Created` + SDP answer + `Location:` a session erőforrás URL-je
3. leállításkor `DELETE <resourceUrl>`

**Nem trickle ICE:** megvárjuk az ICE gathering végét (max 5 s), és egyetlen,
teljes offert küldünk. Nincs szükség `PATCH`-re, és az alagúton is egyetlen
kérés megy át.

**H.264 preferálás** SDP-szinten — ez a hardveres enkóder és az OBS/böngésző
kompatibilitás miatt fontos.

**Kétféle hitelesítés, szándékosan:** az ingest felé HTTP Basic megy, mert a
MediaMTX belső auth módja ezt fogadja el (a Bearer token nála a `jwt` módhoz
tartozik); a vezérlő szerver felé viszont `Bearer <streamKey>`, mert az a saját
API-nk. Részletek: [`INGEST.md`](INGEST.md) 2. fejezet.

> ⚠️ **A médiaút.** A WHIP jelzés átmegy a Cloudflare Tunnelen, a tényleges
> WebRTC média (SRTP/ICE) **nem**. TURN nélkül NAT mögül jellemzően nem jön
> létre médiaút. A TURN adatai az app beállításai közt konfigurálhatók
> (`turnUrl` / `turnUsername` / `turnCredential`).
> Részletek: [`NETWORKING.md`](NETWORKING.md) 3. fejezet.

---

## 6. Session-vezérlés — mit tud az app, és mit nem

Az app **semmit nem tud** az intróról, az outróról és az overlay-ről. Csak
ennyit jelez:

| Gomb | App | Szerver (4. szegmens) |
|---|---|---|
| **Kezdés** | publish indul | `POST /api/session/start` → `INTRO` állapot |
| **Szünet** | publish leáll (WHIP DELETE), capture MEGY tovább | `POST /api/session/pause` → `PAUSED` |
| **Folytatás** | új publish | `POST /api/session/resume` → `LIVE` |
| **Befejezés** | publish leáll | `POST /api/session/end` → `OUTRO` → `OFFLINE` |

A vezérlő szerver elérhetetlensége **nem állítja meg a publish-t**: a média a
MediaMTX felé megy, attól függetlenül, hogy a Node szerver válaszol-e.

### 6.1 A `paused` állapot — felvenni a 4. szegmens állapotgépébe

`paused` **külön állapot**, nem azonos a `reconnecting`-gal:

| | `reconnecting` | `paused` |
|---|---|---|
| Kiváltó | nem szándékos szakadás | felhasználói gomb |
| Megjelenés a `/live` oldalon | „Megszakadt” képernyő | **ugyanaz** a képernyő |
| Backoff-timer | van (1→2→4→…→30 s) | **nincs** |
| Visszatérés | automatikus, ha a kapcsolat helyreáll | csak a „Folytatás” gombra |
| Outro | nem indul | nem indul |

### 6.2 Automatikus újracsatlakozás

`StreamService.connectWithRetry()`:

- Backoff: **1 s → 2 s → 4 s → 8 s → 16 s → 30 s (plafon)**, ±20% jitterrel.
- Addig próbálkozik, amíg vagy helyreáll a kapcsolat, vagy a felhasználó
  **explicit „Befejezés”-t** nyom. Szünet közben nem fut.
- Kivétel: ha a szerver a streamkulcsot utasítja el (HTTP 401/403), a hiba
  `FatalWhipException` → nincs értelme újrapróbálni, `ERROR` állapot.
- A szakadást két forrásból vesszük észre: a WHIP kérés hibája, illetve a
  `PeerConnection.PeerConnectionState` (`FAILED` / `DISCONNECTED` / `CLOSED`).
- A UI és a notification mutatja a következő próbálkozásig hátralévő időt és a
  próbálkozás sorszámát.

---

## 7. Kiegészítő funkciók

### 7.1 Vaku

- Ha fut a CameraX kamera: `CameraControl.enableTorch()`.
- Ha nincs bekötött kamera (képernyő mód, vagy nincs adás):
  `CameraManager.setTorchMode()` (`util/TorchController.kt`).

Így a vaku a streamtől függetlenül, mindig elérhető.

### 7.2 Fényképezőgép — aktuális képkocka mentése

A `FrameFanout` mindig tárolja az utolsó képkockát; a gomb ezt menti JPEG-ként
a galériába (`Pictures/OnLIVE`), a forgatás korrekciójával.

Miért nem külön `ImageCapture` use case: az második capture-kérés lenne a
kamerának (kép-kiesés, esetleg vaku-villanás), és képernyő módban egyáltalán
nem működne. Így viszont **nulla hatással van a stream folytonosságára**, és
kamera/képernyő módban egyaránt működik.

### 7.3 Filmtekercs — párhuzamos helyi MP4

| Mód | Megvalósítás | Kimenet |
|---|---|---|
| Kamera | CameraX `VideoCapture<Recorder>` | `Movies/OnLIVE/OnLIVE_*.mp4` |
| Képernyő | `MediaRecorder` + második `VirtualDisplay` | `Movies/OnLIVE/OnLIVE_screen_*.mp4` |

Külön enkóder, külön fájl: **ha a hálózat megszakad, a felvétel akkor is megy**,
és fordítva. A gomb akkor is használható, ha nincs élő adás.

**Két őszinte korlát:**

1. **Élő adás közben a helyi felvétel kép-only.** A mikrofont ilyenkor a WebRTC
   `AudioDeviceModule` tartja, és Android alatt egyszerre egy capture-kliens
   birtokolhatja a mikrofont — a második vagy hibára fut, vagy elveszi a hangot
   az adástól. Adás nélkül a felvétel hanggal készül.
2. **A prompt „külön MediaRecorder instance"-t kért** — kamera módban ez
   szó szerint nem lehetséges: a kamerát egyszerre egy kliens nyithatja meg, egy
   második `MediaRecorder` nem tudna önállóan ugyanahhoz a kamerához férni.
   A megvalósítás ezért egy kameraszesszió, két független enkóder-ág — ami a
   kérés lényegét (a felvétel független a publish-tól) megtartja.

---

## 8. Fájlszerkezet

```
android/app/src/main/java/com/galandras/onlive/
├── MainActivity.kt              # csak UI + engedélyek + PIP
├── OnLiveApp.kt
├── stream/
│   ├── StreamService.kt         # ★ a motor: FGS, állapot, reconnect, vezérlés
│   ├── StreamState.kt           # ConnectionState, StreamBus (állapotbusz)
│   ├── CameraSource.kt          # CameraX: lencsék, torch, helyi felvétel
│   ├── ScreenSource.kt          # MediaProjection: 2 VirtualDisplay
│   ├── FrameFanout.kt           # egy belépési pont a képkockáknak
│   ├── ImageProxyConverter.kt   # CameraX YUV → WebRTC I420
│   └── PhotoSaver.kt            # képkocka → JPEG → galéria
├── webrtc/
│   ├── RtcEngine.kt             # PeerConnection, tracks, stats
│   ├── WhipClient.kt            # WHIP POST/DELETE
│   └── SdpUtils.kt              # Opus bitráta, H.264 preferálás
├── net/ControlApi.kt            # /api/session/start|pause|resume|end|config|stats|ping
├── settings/                    # DataStore + minőségi enumok
├── ui/
│   ├── OnLiveScreen.kt          # Compose felület (kamera, vezérlők)
│   ├── SettingsScreen.kt        # ★ fogaskerék: kapcsolat, TURN, minőség
│   └── Colors.kt                # közös jelentés-színek
└── util/                        # Notifications, BackgroundPermissions, Torch
```

---

## 9. Build

A Gradle **verziója rögzített** (`gradle/wrapper/gradle-wrapper.properties`), és
a wrapper (`gradlew`, `gradlew.bat`, `gradle-wrapper.jar`) is a repóban van:

```bash
cd android
./gradlew assembleDebug
```

Telepítés: `./gradlew installDebug`, vagy `adb install app/build/outputs/apk/debug/app-debug.apk`.

### Verziók — mi mivel mozog együtt

| Mi | Hol | Megjegyzés |
|---|---|---|
| Gradle | `gradle/wrapper/gradle-wrapper.properties` | az AGP-hez igazodik |
| AGP, Kotlin, könyvtárak | `gradle/libs.versions.toml` | egy helyen, verzió-katalógusban |

Az AGP és a Gradle **együtt mozog**. Az AGP maga ellenőrzi a minimumot
(`VersionCheckPlugin`), a jelenlegi állás:

| AGP | Minimum Gradle |
|---|---|
| 8.13.x | 8.13 |
| 9.x | 9.5 |

A projekt AGP 8.13.2-t használ, a wrapper Gradle 9.3.0-t — ez bőven megfelel, és
a 9.7.0-ra lépés is mehet, ha az Android Studio azt ajánlja (AGP-t ahhoz nem
kell váltani). Amit viszont **ne** tegyél: AGP 9-re lépni Gradle 9.5 alatt — az
AGP a sync legelején leáll.

Ha az Android Studio azt írja, hogy *„Gradle X is not the latest minor version"*,
az csak IDE-figyelmeztetés: a rögzített, működő verzió a fontos, nem a legfrissebb.

### 16 KB-os lapméret (Android 15+)

Az új eszközök (pl. Galaxy S26) 16 KB-os memórialapokkal futnak. A telefon
`Az alkalmazás nem kompatibilis a 16 kB-os mérettel` párbeszéddel jelzi, ha egy
natív `.so` nincs laphatárra igazítva, és fel is sorolja, melyik:

| Könyvtár | Honnan jön |
|---|---|
| `libimage_processing_util_jni.so` | CameraX |
| `libdatastore_shared_counter.so` | DataStore |
| `libandroidx.graphics.path.so` | Compose (graphics-path) |
| `libjingle_peerconnection_so.so` | WebRTC |

Az igazítás **a könyvtárak dolga**, nem a miénk: a megoldás a függőségek
frissítése olyan kiadásra, ami már igazítva van (`libs.versions.toml`). A mi
oldalunkon annyi kell, hogy a natív fájlok tömörítetlenül kerüljenek az APK-ba
— ezt az `app/build.gradle.kts` `packaging { jniLibs { useLegacyPackaging = false } }`
mondja ki (az AGP alapból is így csinálja minSdk 23 felett).

Ellenőrzés a lefordított APK-n:

```bash
unzip -p app/build/outputs/apk/debug/app-debug.apk "lib/arm64-v8a/*.so" > /dev/null
# vagy a hivatalos szkript:
# https://developer.android.com/guide/practices/page-sizes#alignment-use-script
```

### compileSdk 36, targetSdk 34 — miért különbözik

A kettő **külön dolog**, és szándékosan nem egyezik:

| Beállítás | Érték | Mit jelent |
|---|---|---|
| `compileSdk` | **36** | milyen API-k ellen fordítunk. A CameraX 1.6, az androidx.core 1.18 és az activity 1.13 `minCompileSdk = 36`-tal jön — enélkül a build a `checkDebugAarMetadata` lépésnél áll meg |
| `targetSdk` | **34** | milyen futásidejű viselkedésre iratkozunk fel. Ez a 2. szegmens döntése, lásd lentebb |
| `minSdk` | **26** | mely eszközökre telepíthető |

A `compileSdk` emelése önmagában **nem** változtat futásidejű viselkedést —
csak újabb API-k válnak elérhetővé fordításkor. A `targetSdk` emelése az, ami
új rendszerviselkedést kapcsol be.

### TargetSdk 34 → 35

A `targetSdk` a szegmens explicit kérése szerint **34** (Android 14). API 35-re
lépés előtt két dolgot kell átnézni:

- a `MediaProjection` hozzájárulás Android 15-ben **munkamenetenként** kérendő
  (nem őrizhető meg korábbi tokenből),
- a foreground service időkorlátok szigorodtak — a `mediaProjection` típusra
  külön figyelmeztetés vonatkozik.

A `MediaProjection.Callback` regisztrációja már most is megtörténik, tehát az
a követelmény teljesül.

---

## 10. Ismert korlátok / továbbfejlesztési pontok

| Téma | Jelen állapot | Lehetséges javítás |
|---|---|---|
| CameraX → WebRTC képút | `ImageAnalysis` YUV → I420 CPU-másolás (1080p30-nál ~93 MB/s) | textúra-út: a CameraX `Preview` felületét a `SurfaceTextureHelper`-nek adjuk, zero-copy frame-ek |
| Képernyő mód `isScreencast` | `false` (egy közös `VideoSource`) | külön forrás vagy renegotiation, ha a szöveg élessége fontos |
| Helyi felvétel hangja élő adás közben | nincs (mikrofon-ütközés) | a WebRTC audio-frame-ek kimentése és keverése a helyi fájlba |
| Fordítás/tesztelés | a kód ebben a környezetben **nem lett lefordítva** (nincs Android SDK) | első build Android Studióban |
