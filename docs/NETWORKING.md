# OnLIVE — 1. szegmens: Hálózati réteg és elérhetőség

> A rendszer legkritikusabb pontja. A szerver otthoni gépen, NAT mögött fut,
> a telefon viszont 4G/5G-ről vagy idegen Wi-Fi-ről csatlakozik — **soha nincsenek
> egy hálózaton**. Ez a dokumentum írja le, hogyan lesz a szerver mégis fix,
> publikus címen elérhető, és mi történik, ha bármelyik láncszem elszakad.

---

## 1. Alapelv: kifelé induló alagút, nem port-forwarding

**Nem ezt csináljuk:**

- ❌ Router port-forwarding — otthoni netnél gyakran CGNAT van (nincs saját
  publikus IP), a szolgáltató blokkolhat portokat, és minden router-csere
  újrakonfigurálást igényel.
- ❌ Dinamikus DNS — az IP-változás és a DNS TTL miatt percekre elérhetetlen
  lehet a rendszer pont adás közben.
- ❌ Közvetlen IP-cím beégetése a telefon appba vagy a web UI-ba.

**Ezt csináljuk:**

- ✅ A szerverről **kifelé induló** alagút (`cloudflared`), ami kimenő HTTPS
  kapcsolatot tart fenn a Cloudflare felé. Így nem kell semmilyen bejövő portot
  nyitni, és a NAT/CGNAT sem számít.
- ✅ Fix, publikus HTTPS/WSS URL-ek a saját domainen (`galandras.com`),
  ami már a Cloudflare-nél van kezelve — nincs szükség új beszerzésre.
- ✅ A telefon app és a web UI **kizárólag ezeket a fix URL-eket** használja.
  Gépindítás, IP-változás, router-csere után sem kell semmit módosítani bennük.

### Alternatíva: Tailscale Funnel

A Tailscale Funnel ugyanezt a „kimenő alagút → fix publikus URL” mintát adja.
Az OnLIVE elsődleges megoldása a **Cloudflare Tunnel**, mert a `galandras.com`
már Cloudflare-nél van. A Tailscale viszont **egy konkrét esetben jobb**: ha a
telefont felvesszük a tailnetbe, akkor a WebRTC média is közvetlen (WireGuard)
úton megy — lásd a [3. fejezetet](#3-fontos-a-whip-jelzés-és-a-webrtc-média-két-külön-út).

---

## 2. Subdomain-felosztás felelősségi kör szerint

A felosztás egybevág a 10. szegmens jogosultsági szintjeivel: minden subdomainnek
más a közönsége és más a védelme.

| Subdomain | Cél (helyi service) | Ki használja | Védelem |
|---|---|---|---|
| `admin.galandras.com` | `http://localhost:8080` | csak az üzemeltető | admin jelszó (+ opcionálisan Cloudflare Access) |
| `live.galandras.com` | `http://localhost:8080` (`/live` útvonal) | OBS Browser Source, nézők | nyilvános, opcionális token |
| `ingest.galandras.com` | `http://localhost:8889` (MediaMTX WHIP) | **csak** az OnLIVE Android app | streamkulcs |

Mindhárom subdomain **ugyanazon az egy tunnelen** megy át — egyetlen
`cloudflared` folyamat, egyetlen `config.yml`.

---

## 3. FONTOS: a WHIP jelzés és a WebRTC média két külön út

Ezt a pontot félreérteni a leggyakoribb hiba, ezért külön kiemeljük.

- A **WHIP jelzés** (SDP offer/answer HTTP POST-tal) tiszta HTTPS — ez
  **hibátlanul átmegy** a Cloudflare Tunnelen.
- A tényleges **WebRTC média** viszont nem HTTP: SRTP folyam ICE-szel
  egyeztetett cím/port páron, alapesetben **UDP-n**. Ez **nem megy át** a
  Cloudflare Tunnel HTTP-proxyján. A MediaMTX a saját, NAT mögötti privát
  IP-jét hirdetné ICE-jelöltként, amit a telefon a mobilhálózatról nem ér el.

Vagyis: az alagút önmagában megoldja az **elérhetőséget és a jelzést**, de a
médiaútnak külön megoldás kell. Három működő lehetőség, az OnLIVE-hoz javasolt
sorrendben:

### A) Ajánlott: Cloudflare Tunnel + TURN relay a médiának

A jelzés az alagúton megy, a média pedig egy publikusan elérhető **TURN
szerveren** keresztül relézik. Mivel a domain már Cloudflare-nél van, kézenfekvő
a Cloudflare Realtime (Calls) TURN szolgáltatása; alternatíva egy olcsó VPS-en
futó `coturn`.

- Előny: nem kell portot nyitni, a fix subdomain-séma marad, minden hálózatról működik.
- Hátrány: a médiaforgalom egy relén megy át (némi többletkésleltetés, sávszélesség-költség).
- Konfiguráció: a MediaMTX `webrtcICEServers2` beállításába kerül a TURN szerver
  és a hitelesítő adatai; a MediaMTX így TURN-jelöltet hirdet, amit a telefon el
  tud érni. A sablon készen áll (`infra/mediamtx/mediamtx.example.yml`), csak a
  TURN sorokat kell kikommentezni — lásd [`INGEST.md`](INGEST.md) 5. fejezet.

### B) Legegyszerűbb médiaút: Tailscale a telefonon

A telefonra is felkerül a Tailscale, és a tailnetbe kerül. Ekkor a telefon és a
szerver között közvetlen (vagy DERP-en relézett) WireGuard kapcsolat van, amin a
WHIP jelzés és a média is gond nélkül átmegy, portnyitás nélkül.

- Előny: a legkevesebb mozgó alkatrész a médiaút szempontjából, alacsony késleltetés.
- Hátrány: a telefonnak be kell lépnie a tailnetbe (egyszeri beállítás), és a
  publikus `/live` oldalhoz így is kell a Cloudflare Tunnel.
- **1.0.101 óta ez az app beállításaiban is szerepel**: a *Helyi elérés — LAN /
  Tailscale* szekcióba a szerver Tailscale- vagy LAN-címe kerül
  (`http://100.x.y.z:8080` és `:8889`), a **Kapcsolat mód** pedig eldönti,
  mikor melyiket használjuk:

  | Mód | Mit csinál |
  |---|---|
  | Automatikus | megnézi, válaszol-e a helyi cím (1,5 mp), és ha igen, azon megy — különben az alagúton |
  | Csak helyi | kizárólag LAN / Tailscale |
  | Csak Tunnel | kizárólag a publikus címek |

  A címeket nem kell kitalálni: a szerver kiírja őket az **admin → Streamkulcs**
  fülön (a Tailscale-cím megy előre, mert az útközben is működik). Az app a
  próba eredményét 30 másodpercig jegyzi meg, tehát egy hálózatváltás után
  magától helyreáll.
- Gyakorlati javaslat: **ingest Tailscale-en, admin + live Cloudflare Tunnelen** —
  ez a két világ legjobb kombinációja, ha a telefon a sajátunk.

### C) Ha a médiaút prioritás: MediaMTX publikus VPS-en

A MediaMTX egy olcsó, publikus IP-vel rendelkező VPS-re kerül; a telefon
közvetlenül oda publikál, az otthoni vezérlő szerver pedig onnan olvassa a
streamet.

- Előny: tiszta, relé nélküli WebRTC-út, nincs NAT-probléma.
- Hátrány: havidíj, és a média kikerül az otthoni gépről.

> **Döntés:** az alapkonfiguráció az **(A)** út — Cloudflare Tunnel mindenre,
> TURN a médiához. A `config.example.yml` és a lenti lépések ezt írják le.
> A (B) opció beállítási vázlatát a 8. fejezet tartalmazza.

---

## 4. Telepítés lépésről lépésre (Windows)

### 4.1 `cloudflared` telepítése

```powershell
# Windows csomagkezelővel
winget install --id Cloudflare.cloudflared

# ellenőrzés
cloudflared --version
```

### 4.2 Bejelentkezés a Cloudflare fiókba

```powershell
cloudflared tunnel login
```

Megnyílik a böngésző; válaszd ki a **`galandras.com`** zónát. Sikeres
bejelentkezés után létrejön a `%USERPROFILE%\.cloudflared\cert.pem`.

### 4.3 Named tunnel létrehozása

```powershell
cloudflared tunnel create livestream
```

Kimenet (példa):

```
Tunnel credentials written to C:\Users\<user>\.cloudflared\6f1a2b3c-....json
Created tunnel livestream with id 6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8
```

> **Jegyezd fel a tunnel ID-t és a credentials fájl elérési útját** — mindkettő
> kell a `config.yml`-be. A credentials JSON **titok**, soha ne kerüljön a
> git repóba (a `.gitignore` tiltja).

Létező tunnelek listázása:

```powershell
cloudflared tunnel list
```

### 4.4 DNS route-ok hozzárendelése (mindhárom subdomain)

```powershell
cloudflared tunnel route dns livestream admin.galandras.com
cloudflared tunnel route dns livestream live.galandras.com
cloudflared tunnel route dns livestream ingest.galandras.com
```

Ez a Cloudflare DNS-ben létrehoz egy-egy proxyzott `CNAME`-et
(`<tunnel-id>.cfargotunnel.com`-ra mutatva). A DNS-t nem kell kézzel szerkeszteni.

Ellenőrzés:

```powershell
nslookup admin.galandras.com
cloudflared tunnel info livestream
```

### 4.5 `config.yml` létrehozása

Másold be a repóból a sablont, és töltsd ki a saját értékeiddel:

```powershell
mkdir "$env:USERPROFILE\.cloudflared" -Force
copy infra\cloudflared\config.example.yml "$env:USERPROFILE\.cloudflared\config.yml"
notepad "$env:USERPROFILE\.cloudflared\config.yml"
```

A teljes, kommentezett sablon: [`infra/cloudflared/config.example.yml`](../infra/cloudflared/config.example.yml).

### 4.6 Próbafuttatás (még service nélkül)

```powershell
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run livestream
```

Ellenőrzés másik ablakból / telefonról:

```powershell
curl.exe -I https://admin.galandras.com
curl.exe -I https://live.galandras.com/live
curl.exe -I https://ingest.galandras.com
```

### 4.7 Windows service telepítése (autostart reboot után)

```powershell
# rendszergazdai PowerShell-ből
cloudflared service install
Start-Service cloudflared
Get-Service cloudflared
```

> A `cloudflared service install` a `%USERPROFILE%\.cloudflared\config.yml`-t
> (illetve `%ProgramData%\Cloudflare\cloudflared\config.yml`-t) használja.
> Ha a szolgáltatás nem találja a konfigot, másold át a ProgramData alá:
> ```powershell
> mkdir "$env:ProgramData\Cloudflare\cloudflared" -Force
> copy "$env:USERPROFILE\.cloudflared\config.yml"  "$env:ProgramData\Cloudflare\cloudflared\config.yml"
> copy "$env:USERPROFILE\.cloudflared\<tunnel-id>.json" "$env:ProgramData\Cloudflare\cloudflared\"
> ```
> A `config.yml`-ben ilyenkor a `credentials-file` is a ProgramData-beli útra mutasson.

**Ezt a lépést fel kell venni a 11. szegmens telepítési listájába** — a
`cloudflared` service és a watchdog ütemezett feladat nélkül a rendszer
géprebootolás után nem áll fel magától.

---

## 5. Mi történik, ha megszakad az alagút? (szerver oldali watchdog)

**Tünet:** a telefon és a böngésző is `502`/időtúllépést kap; a `cloudflared`
fut, de nincs élő kapcsolata a Cloudflare felé (vagy a folyamat elszállt).

**Detektálás — három szint:**

1. **Folyamat-szint:** fut-e a `cloudflared` Windows service (`Running` állapot).
2. **Konnektor-szint:** a `cloudflared` metrics végpontja
   (`http://127.0.0.1:20241/ready`) `200`-at ad-e, és jelent-e legalább egy
   aktív kapcsolatot. Ez az igazi „él-e az alagút” jelzés.
3. **Végpont-szint:** a publikus URL (`https://live.galandras.com/healthz`)
   kívülről válaszol-e. Ez fedi le azt az esetet is, amikor a tunnel él,
   de a mögötte lévő helyi service halott.

**Reakció (`scripts/tunnel-watchdog.ps1`):**

- N egymást követő sikertelen ellenőrzés után (alapértelmezés: 3) a watchdog
  **újraindítja** a `cloudflared` service-t.
- Exponenciális visszalépés a restartok között (30s → 60s → 120s → max 300s),
  hogy egy tartós Cloudflare-kimaradás alatt ne pörögjön feleslegesen.
- Minden esemény naplózódik (`logs/tunnel-watchdog.log`), és opcionálisan
  webhookra is kimegy (`ONLIVE_WATCHDOG_WEBHOOK`).
- Sikeres helyreállás után a számlálók nullázódnak, és „recovered” bejegyzés
  kerül a logba.

**Fontos elhatárolás:** a watchdog **csak az alagutat** kezeli. Ha az alagút él,
de a telefon nete szakadt meg, az **nem** a watchdog dolga — azt a telefon
reconnect-logikája (2. szegmens) és a vezérlő szerver `INTERRUPTED` állapota
(állapotgép-szegmens) kezeli.

**Indítás / regisztrálás ütemezett feladatként:**

```powershell
# rendszergazdai PowerShell-ből, a repó gyökeréből
powershell -ExecutionPolicy Bypass -File .\scripts\install-tunnel-watchdog.ps1
```

Kézi (előtérben futó) teszt:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-watchdog.ps1 -Verbose
```

---

## 6. Mi történik, ha csak a telefon net-je szakad meg?

Ez **nem hálózati infrastruktúra-hiba**, ezért itt csak a határokat rögzítjük;
a megvalósítás a 2. szegmensé (Android reconnect) és a 4. szegmensé (állapotgép).

Elvárt viselkedés, röviden:

| Réteg | Teendő |
|---|---|
| Android app | Detektálja a WebRTC kapcsolat `disconnected`/`failed` állapotát, és exponenciális visszalépéssel (1s → 2s → 4s → … max 30s) újrapróbálja a WHIP publish-t **ugyanarra a stream-útvonalra**. A UI „Újracsatlakozás…” állapotot mutat. |
| MediaMTX | Észreveszi a publisher eltűnését, és felszabadítja az útvonalat, hogy az újracsatlakozás azonnal sikerüljön. |
| Vezérlő szerver | A publisher eltűnése után rövid türelmi idővel (pl. 3 s) `INTERRUPTED` állapotba lép, és WebSocketen szól minden kliensnek. |
| `/live` oldal | `INTERRUPTED` állapotban a „megszakadt az adás” képernyőt mutatja, nem fekete képet — így az OBS Browser Source-ban is értelmes tartalom van. |
| Admin UI | Jelzi a megszakadást és annak hosszát. |

**Kulcsszabály:** a telefon net-vesztése **soha nem** eredményezhet fekete képet
vagy összeomlott lejátszót az OBS-ben.

---

## 7. Hibakeresési gyorstalpaló

| Tünet | Valószínű ok | Teendő |
|---|---|---|
| `502 Bad Gateway` az admin URL-en | fut az alagút, de nem fut a Node szerver a 8080-on (vagy átállították a portot) | indítsd a vezérlő szervert (`start.bat`) |
| `530` / `1033` hibakód | nincs futó tunnel-konnektor | `Get-Service cloudflared`, `cloudflared tunnel info livestream` |
| DNS nem oldódik fel | hiányzó vagy törölt DNS route | `cloudflared tunnel route dns livestream <hostname>` |
| WHIP POST `201`-et ad, de nincs kép | a WebRTC média nem talál utat (nincs TURN) | lásd a [3. fejezetet](#3-fontos-a-whip-jelzés-és-a-webrtc-média-két-külön-út) |
| Reboot után nem elérhető a rendszer | nincs telepítve a service | `cloudflared service install`, majd `Start-Service cloudflared` |
| Időnként megszakad, majd magától visszajön | normál konnektor-újracsatlakozás | nézd meg a `logs/tunnel-watchdog.log`-ot |

Hasznos parancsok:

```powershell
cloudflared tunnel list
cloudflared tunnel info livestream
Get-Service cloudflared
curl.exe http://127.0.0.1:20241/ready       # tunnel készenlét
curl.exe http://127.0.0.1:20241/metrics     # részletes metrikák
Get-Content .\logs\tunnel-watchdog.log -Tail 50 -Wait
```

---

## 8. Függelék: Tailscale-alapú ingest (B opció) vázlata

Ha a médiaút miatt a (B) utat választod, az admin/live rész marad Cloudflare
Tunnelen, és csak az ingest kerül át:

```powershell
# szerver oldalon
winget install --id tailscale.tailscale
tailscale up
tailscale ip -4        # pl. 100.x.y.z
```

- A telefonra is telepítsd a Tailscale-t, és lépj be **ugyanazzal a fiókkal**.
- Az OnLIVE app ingest URL-je ekkor: `http://100.x.y.z:8889/<stream>/whip`
  (tailnet-en belüli cím, a forgalom titkosított).
- Az `ingest.galandras.com` Cloudflare-route ilyenkor **tartalék** útvonalként
  megmarad, ha a telefon nem tud tailnetre lépni.
- A telefon appban ezért **két ingest URL** konfigurálható: elsődleges (tailnet)
  és tartalék (Cloudflare) — a választás a 2. szegmens feladata.

---

## 9. Fix URL-ek összefoglalása (ezek kerülnek a kliensekbe)

```
Admin UI      : https://admin.galandras.com
Live/OBS      : https://live.galandras.com/live
WHIP ingest   : https://ingest.galandras.com/<stream>/whip
WebSocket     : wss://admin.galandras.com/socket.io/   (admin)
                wss://live.galandras.com/socket.io/    (live oldal)
```

Ezek **soha nem változnak** — sem IP-váltáskor, sem reboot után, sem
router-cserekor. Az Android app és a web UI ezeket a konstansokat használja
(lásd `.env.example`).
