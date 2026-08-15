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

## 3. WHIP ingest — a streamkulcs

**Ez az egyetlen védelme az ingestnek**: aki kitalálja, idegen streamet
publikálhat a nevedben, és a te OBS-edben az fog megjelenni.

```powershell
npm run keygen
# → ONLIVE_STREAM_KEY=... (192 bit véletlen, base64url)
```

A kulcsot két helyre kell beírni:

1. `.env` → `ONLIVE_STREAM_KEY` (a vezérlő szerver ezzel ellenőrzi a telefont),
2. `infra/mediamtx/mediamtx.yml` → `authInternalUsers` → `publisher` jelszava
   (a MediaMTX ezzel ellenőrzi a WHIP publish-t).

A telefon HTTP Basic fejléccel küldi (`publisher` + kulcs) — a MediaMTX belső
auth módja ezt fogadja el ([`INGEST.md`](INGEST.md) 2.).

A szerver **induláskor kiértékeli** a titkokat, és szól, ha rövid,
alapértelmezett („valtoztasd-meg") vagy egyveretű értéket talál. Ne akkor
derüljön ki, amikor már baj van.

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
