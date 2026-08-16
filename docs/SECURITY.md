# OnLIVE — 10. szegmens: Biztonság és hitelesítés

> A rendszer publikus címeken érhető el (Cloudflare Tunnel), tehát minden
> védelem valódi támadási felületen áll. Ez a dokumentum rögzíti, **mit mi véd**,
> és hol vannak a határok.

Forrás: [`server/src/security/`](../server/src/security),
[`server/src/api/auth.js`](../server/src/api/auth.js),
[`server/src/api/auth-routes.js`](../server/src/api/auth-routes.js).

---

## 1. Három jogosultsági szint

A felosztás pontosan a subdomain-eket követi ([`NETWORKING.md`](NETWORKING.md) 2.):

| Ki | Mivel igazolja magát | Mit tehet |
|---|---|---|
| **admin** | munkamenet-süti (belépés jelszóval) vagy fejléces jelszó | mindent |
| **telefon** | streamkulcs (`Authorization: Bearer`) | session-jelzés, telemetria, WHIP publish |
| **néző / OBS** | lejátszási token (opcionális) | **kizárólag megtekintés** |

**A lejátszási token szándékosan nem ad vezérlési jogot.** A `/live`, a média,
az overlay-leírás és a lejátszás-proxy elérhető vele, de sem az admin API-hoz,
sem a session indításához/leállításához nem nyúlhat — és Socket.io-n sem kap
admin szerepet (nem látja a telemetriát, az ingest-részleteket és a
session-azonosítót). Ezt tesztek védik, és élesben is ellenőrizve lett:

```
/live, /api/state, /api/media, /api/overlay  →  200   (megtekintés)
/api/admin/*                                  →  401   (vezérlés)
/api/session/start a live tokennel            →  401
```

Ugyanígy: a **streamkulcs sem admin**. A telefon indíthat és zárhat sessiont,
de az admin API-t nem éri el.

## 2. Admin bejelentkezés

### Ami a 8. szegmensben ideiglenes volt

A jelszó a böngésző `localStorage`-ában várakozott, és **minden kérésben**
elment egy fejlécben. Ez most lecserélődött:

- a jelszó **egyszer** utazik, a bejelentkezéskor,
- utána egy véletlen munkamenet-token dolgozik **HttpOnly** sütiben, amit a
  JavaScript nem tud kiolvasni (így egy XSS sem viszi el),
- a süti `SameSite=Strict`, és HTTPS mögött `Secure`,
- a munkamenet 12 óra után lejár, de minden használatnál csúszik előre.

### Jelszó tárolása

Ajánlott a **hash-elt** forma:

```powershell
npm run hash-password -- "a-te-hosszu-jelszavad"
# → ONLIVE_ADMIN_PASSWORD_HASH=scrypt$16384$8$1$...
```

A `.env`-ből ilyenkor törölhető az `ONLIVE_ADMIN_PASSWORD`. A sima szöveges
jelszó továbbra is működik (kényelmi okból), de a szerver induláskor
figyelmeztet rá. A hash miatt a `.env` kiszivárgása nem ad azonnal használható
jelszót, és a nyers érték nem kerülhet naplóba.

Az algoritmus **scrypt** (N=16384, r=8, p=1), véletlen sóval — ugyanaz a
jelszó két különböző hash-t ad.

### CSRF

A süti minden kéréssel automatikusan megy — ez az ereje és a gyengéje is.
Ezért minden **állapotváltoztató** kérésnek (POST/PATCH/DELETE) vinnie kell egy
`X-OnLIVE-CSRF` fejlécet is, amit csak a mi oldalunk JavaScriptje ismer
(a bejelentkezés válaszában érkezik, `sessionStorage`-ba kerül).

Egy idegen oldalról indított kérés a sütit viszi, a CSRF tokent nem → **403**.

### Fejléces hitelesítés (szkriptekhez)

`X-OnLIVE-Admin-Password` továbbra is elfogadott — `curl`-höz és
automatizáláshoz kell. Ha csak böngészőből vezérelsz, kapcsold ki:

```
ONLIVE_ALLOW_HEADER_AUTH=false
```

Ekkor **kizárólag** munkamenettel lehet adminkodni (élesben ellenőrizve).

### Sebességkorlátozás

A bejelentkezés és a streamkulcs-ellenőrzés IP-nként korlátozott: **5**
sikertelen próbálkozás után zárlat, ami ismétlődésnél duplázódik
(30 mp → 1 perc → 2 perc … max 15 perc). A sikeres belépés nullázza a
számlálót, tehát a saját elgépeléseid nem halmozódnak.

Enélkül a publikus admin címen egy szótáras támadás percek alatt lefutna.

**A kliens IP-je csak a loopbacktől fogadható el** (`trust proxy: 'loopback'`).
A cloudflared helyben csatlakozik, és a valódi klienst az
`X-Forwarded-For` lánc VÉGÉRE fűzi — az express ezért a lánc utolsó, nem
megbízható elemét veszi. Ha minden továbbítót megbíznánk (`trust proxy: true`),
a kliens által küldött ELSŐ elem számítana: a támadó minden próbálkozáshoz más
IP-t hazudhatna, és a zárlat sosem lépne életbe.

## 3. WHIP ingest — a streamkulcs

**Ez az egyetlen védelme az ingestnek**: aki kitalálja, idegen streamet
publikálhat a nevedben, és a te OBS-edben az fog megjelenni.

### Létrehozás a webes felületen (1.0.010)

A kulcs az admin felület **Streamkulcs** fülén jön létre — nem fájlban, nem
parancssorban:

- **Generálás:** 32 karakter, kriptográfiai véletlenből, garantáltan minden
  követelménnyel.
- **Saját kulcs:** kézzel is megadható, ha a szabályok teljesülnek.

| Követelmény | Miért |
|---|---|
| legalább **16 karakter** | ennél rövidebbet érdemes végigpróbálni |
| **kisbetű** | … |
| **nagybetű** | … a négy karakterosztály együtt adja a keresési teret |
| **számjegy** | … |
| **speciális karakter** | … |
| nincs szóköz | a kulcs HTTP fejlécben utazik |

A felület gépelés közben jelzi, melyik feltétel teljesül, de a mentést a
szerver is ellenőrzi (`security/stream-key.js`) — a felület megkerülése nem
enged át gyenge kulcsot.

### Tárolás: csak a hash

A szerver a kulcsot **scrypt hash-ként** tárolja (`data/stream-key.json`),
ugyanúgy, ahogy az admin jelszót. A nyers érték **egyetlen egyszer** hagyja el
a szervert: a létrehozás válaszában, amit a felület egyszer megmutat. Utána
sehonnan nem kérdezhető vissza — sem API-n, sem fájlból.

Amit szándékosan **nem** tárolunk: ujjlenyomatot vagy „emlékeztetőt" a
kulcsból. Egy gyors hash (sha256) a fájl mellett kioltaná a scrypt lassúságát,
vagyis épp azt a védelmet, amiért a scryptet választottuk.

### Hogyan hitelesít ezek után a MediaMTX

Korábban ugyanaz a nyers kulcs szerepelt a `mediamtx.yml`-ben is. Ez most
megszűnt: a MediaMTX **nem tárol jelszót**, hanem minden hitelesítési kérdést
a vezérlő szerverhez továbbít, az pedig a hash ellen ellenőriz.

```yaml
authMethod: http
authHTTPAddress: http://127.0.0.1:3000/api/ingest/auth
```

```
telefon ──WHIP publish──> MediaMTX ──POST /api/ingest/auth──> vezérlő szerver
                                                                    │
                                              scrypt hash ellenőrzés ┘
                             200 = mehet · 401 = tilos
```

A végpont **csak localhostról** hívható (a MediaMTX ugyanazon a gépen fut), és
a sikertelen publish-kísérleteket IP-nként számolja: a szótáras próbálkozás
ugyanabba a zárlatba fut, mint a bejelentkezés.

> **Üzemeltetési következmény:** ha a vezérlő szerver nem fut, a MediaMTX minden
> publish-t elutasít. Ez szándékos — adás nélkül úgysincs mit vezérelni —, de
> hibakeresésnél érdemes tudni: a „401 a WHIP-en" előbb jelent álló Node
> szervert, mint rossz kulcsot.

### A telefon oldala

Az appban a **fogaskerék → Kapcsolat** szekcióba kell beírni ugyanezt a kulcsot
és a Tunnel címeit. A **Kapcsolat tesztelése** gomb `GET /api/session/ping`
hívással azonnal megmondja, jó-e a cím és a kulcs — nem kell adást indítani
hozzá.

A telefon HTTP Basic fejléccel publikál (`publisher` + kulcs), a vezérlő
szerver felé pedig `Authorization: Bearer <kulcs>` fejléccel jelez.

### Csere és visszavonás

Új kulcs létrehozása a régit **azonnal** érvényteleníti (a memóriabeli
gyorsítótár is ürül). A visszavonás után a telefon nem tud publikálni, amíg
nincs új kulcs. A `.env`-ben maradt `ONLIVE_STREAM_KEY` csak tartalék a régi
telepítésekhez: amint a felületen létrejön egy kulcs, az élvez elsőbbséget, és
a `.env`-sor törölhető.

A szerver **induláskor kiértékeli** a titkokat, és szól, ha a streamkulcs
hiányzik vagy még a `.env`-ből jön. Ne akkor derüljön ki, amikor már baj van.

## 4. `/live` — opcionális, korlátozott jogú token

Alapból nyilvános, mert így elég a puszta URL az OBS-be. Tokenes védelemhez:

```
ONLIVE_LIVE_TOKEN=...   (npm run keygen)
```

Ekkor token kell ezekhez: `/live`, `/api/state`, `/api/media`, `/media/:slot`,
`/api/overlay`, `/overlay/asset/:id`, `/api/whep/*`, `/api/hls/*`, **és a
Socket.io kapcsolathoz is** — különben az állapot-folyam token nélkül is
olvasható maradna.

Az admin munkamenet is elfogadott token helyett, hogy az admin felület
beágyazott előnézete külön token nélkül működjön.

## 5. További rétegek

| Réteg | Mit véd |
|---|---|
| **Biztonsági fejlécek** | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, és egy CSP, ami külső forrásból nem enged szkriptet betölteni |
| **Beágyazás-sandbox** | a third-party widgetek `allow-scripts` sandboxban, `allow-same-origin` nélkül, saját kulccsal ([`WIDGETS.md`](WIDGETS.md) 4.) |
| **Média-validáció** | a feltöltés tartalom (magic bytes) alapján ([`OVERLAY-MEDIA.md`](OVERLAY-MEDIA.md) 3.) |
| **Link-séma szűrés** | csak `http`/`https` ([`MONITORING.md`](MONITORING.md) 3.) |
| **Hook titok** | a MediaMTX webhookjai közös titokkal ([`INGEST.md`](INGEST.md) 3.1) |
| **MediaMTX API** | `127.0.0.1`-re kötve, kifelé sosem publikálva |
| **URL-paraméterek** | a `/live?preview=` csak a felsorolt képernyőneveket fogadja el, a `/admin/login?next=` csak saját, abszolút útvonalat |
| **Idegen eredetű adat a felületen** | a telefon telemetriája és a linkek `textContent`/escape-elve kerülnek a DOM-ba, nem nyers HTML-ként |

### Miért kap külön sort az URL-paraméter

A `?preview=` érték megjelenik az oldalon, a `?next=` pedig egy
`location.replace()` célja. Ha bármelyik szabad szöveg lehetne, egy preparált
link a MI originünkön futtatna kódot: bejelentkezett adminnál ez a
munkamenet átvételét jelenti (a CSRF token a `sessionStorage`-ban van, tehát
az oldalon futó kód eléri). Ezért mindkettő **fehérlistás**: ismeretlen érték
esetén az alapértelmezés lép életbe, nem a kapott szöveg.

Ugyanez a logika a telemetriára: az a **telefontól** jön, ami a streamkulccsal
hitelesít — alacsonyabb szint, mint az admin felület. Ezért nem kerülhet
HTML-ként a vezérlőfelület DOM-jába.

### A CSP kompromisszuma

A `script-src` tartalmaz `'unsafe-inline'`-t, mert az admin oldalak
szándékosan build-lépés nélküliek (egy fájl = egy oldal, inline szkripttel).
Ez gyengébb, mint egy nonce-alapú CSP — cserébe a **külső forrásból** betöltött
szkriptet így is blokkolja, és a `frame-ancestors 'self'` miatt idegen oldal
nem ágyazhatja be a felületet. Ha ez kevés, a következő lépés az inline
szkriptek külön fájlba mozgatása és nonce bevezetése.

## 6. Biztonsági helyzetkép a felületen

Az admin fejlécében egy jelző mutatja, van-e gyenge pont, és a
`GET /api/admin/security` végpont részletezi:

```json
{
  "admin":  { "hashed": true, "activeSessions": 2, "assessment": { "level": "strong" } },
  "ingest": { "streamKeyConfigured": true, "assessment": { "level": "strong" } },
  "live":   { "tokenConfigured": false, "assessment": { "level": "open" } },
  "hooks":  { "secretConfigured": true, "assessment": { "level": "strong" } }
}
```

Titkot **sosem** ad vissza — csak azt, hogy be van-e állítva és mennyire erős.
A `POST /api/admin/security/logout-all` minden munkamenetet megszüntet (ha
elveszett egy eszköz).

## 7. Beállítási sorrend éles indulás előtt

```powershell
cd server
npm run keygen                              # streamkulcs, live token, hook titok
npm run hash-password -- "hosszú jelszó"    # admin jelszó hash
notepad ..\.env                             # mindet bemásolni
notepad C:\OnLIVE\mediamtx\mediamtx.yml     # a streamkulcs ide is kell
npm start                                   # az induló üzenet jelzi, ha valami gyenge
```

Ellenőrzés: az admin felület fejlécében a **„védelem: rendben"** jelzés.

## 8. Amit ez a szegmens szándékosan NEM tartalmaz

| Téma | Miért |
|---|---|
| Több felhasználó, szerepkörök | egygépes, egyfelhasználós rendszer — nincs kinek |
| Kétfaktoros hitelesítés | a Cloudflare Access elé tehető, ha kell (`admin.galandras.com`) |
| Munkamenetek lemezre mentése | újraindítás után újra belépés — nincs mit ellopni a lemezről |
| Naplózott biztonsági audit-nyom | a sikertelen belépések a szerver naplójában látszanak |
| `start.bat`, üzemeltetés | 11. szegmens |
