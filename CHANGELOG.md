# Changelog

[Magyarul](CHANGELOG.hu.md)

OnLIVE was built along a fixed plan of **eleven segments**. Each segment added
one self-contained, working layer, and responsibilities were never allowed to
bleed into each other (see [`ARCHITECTURE.md`](ARCHITECTURE.md)).

Segment *N* is released as version **0.N**, and version **1.0.000** closes the
base phase. The internal documents still speak of "segments" — this file is the
mapping between the two.

---

## 1.0.104 — the local-address probe must not get stuck

*2026-08-16*

After 1.0.103 the ingest address was correct
(`http://100.74.161.60:8889`, publishing to `…/onlive/whip`), yet the phone kept
reconnecting and reported: *"The local address did not answer — going over the
public address."*

But the public address has **no media path** through the Cloudflare Tunnel
without TURN — so losing the local (Tailscale) route is by itself enough for
nothing to work. Three things were adjusted on the probe:

| | Was | Now |
|---|---|---|
| timeout | 1.5 s | **2.5 s** |
| attempts | 1 | **2** (300 ms apart) |
| lifetime of "unreachable" | 30 s | **5 s** |

The short life of a negative result is the point: a Tailscale or VPN route does
not answer during its first moments but does a few seconds later. If
"unreachable" stays valid for half a minute, the phone spends that time trying
the tunnel — exactly where there is no picture. A positive result is still
trusted for 30 seconds; re-measuring that is not worth it.

On top of that, **the probe result is discarded after every failed publish**: if
the tunnel did not work, the next round re-checks whether the local route has
come up in the meantime.

### What this does not fix by itself

If the phone cannot reach the server's Tailscale address at all, this change
does not help — that is a network matter. It can be checked without rebuilding:
open `http://<tailscale-address>:8080/admin` in the phone's browser. If that
fails too, the Tailscale connection or the server's firewall is at fault (see
chapter 6 of [`docs/OPERATIONS.md`](docs/OPERATIONS.md), with a `netsh` command).

---

## 1.0.103 — a path left in the ingest base address

*2026-08-16*

After the 1.0.102 diagnostics, the cause of a stalled live installation became
visible. The phone had:

```
Ingest (WHIP):  http://100.74.161.60:8889/ingest
Publish URL:    http://100.74.161.60:8889/ingest/onlive/whip
```

MediaMTX serves WHIP at the **root of its own port**:
`http://<host>:8889/<stream>/whip`. The leftover `/ingest` made the request look
for a path called `ingest/onlive`, which does not exist — HTTP 404, then endless
reconnecting.

The `/ingest` is an understandable mix-up: the **tunnel hostname** really is
`ingest.…` — but that is a host name, not a path. And since cloudflared does not
strip path prefixes, it cannot be there for tunnel addresses either.

So every path is now stripped from the ingest base on save — not just the
`/<stream>/whip` handled before — and the field shows **in advance** what it will
become:

> The ingest base address must have no path: `http://100.74.161.60:8889` — the
> `/<stream>/whip` part is added by the app. It will be fixed on save.

### The connection test says more

It used to measure only the control leg and reported "OK" even when publishing
was hopeless. It now prints the **publish URL**, reports from the server's ack
whether media **is currently arriving**, and raises a distinct error when the
**stream path does not match** the server's (phone: `onlive`, server:
`something-else` → WHIP would 404). It also states plainly that this test
measures the control leg; publishing is a separate route.

### Two small things that shorten the search

- When the server cannot reach **MediaMTX itself** (`available: false`), the
  phone now says so in its own sentence — that is not the same as "no data", and
  it is not the phone that needs fixing.
- The server **logs its own local addresses at startup** (LAN and Tailscale,
  control + ingest). These were only visible on the admin UI — which is exactly
  what is hard to reach when the network is the problem.

Two rows were added to the troubleshooting table in `docs/OPERATIONS.md`: the
ingest address with a path, and the firewall case (local address does not
answer) with a ready-to-paste `netsh` command.

---

## 1.0.102 — mutual feedback: which leg is down, and why

*2026-08-16*

There was a state where the server **saw the connection** while the phone kept
printing "Reconnecting… (#1)" forever. And nothing said what was wrong.

The cause is structural: the system has **three separate connections**, and any
one of them can be down while the other two are perfect.

| Leg | What travels on it | What it proves |
|---|---|---|
| Control server | `POST /api/session/*` to port 8080 | the address and stream key are right |
| WHIP publish | SDP + media to MediaMTX (8889) | the *picture* can get up |
| What the server SEES | the server's ack in every response | whether media actually **arrives** |

Until now only the end result was visible. All three now have their own line on
the main screen — a dot and a sentence each.

### The server's ack

Every phone request (`start`, `resume`, `stats`, `ping`) returns an `ack` object
describing what the server sees — from the MediaMTX API, not from optimism:

```json
{ "state": "live",
  "ingest": { "available": true, "flowing": false, "stalled": false, "tracks": 0 } }
```

This is the third leg, and it is the one that was missing: a successful HTTP
response does **not** mean the broadcast is running. WHIP signalling can pass
through the tunnel while the WebRTC media never arrives — and the phone had no
way to tell those two apart.

### The reason is visible too

The publish error used to exist only in logcat; the UI showed a silent
"Reconnecting…". The WHIP line now prints the HTTP status and the message.

**404/405** got its own sentence, because that is not a network hiccup but a
wrong address:

> The WHIP address does not exist on this server (HTTP 404): … — the ingest
> address must point at MediaMTX's WHIP port (8889 by default), not at the
> control server.

That is exactly the case described in 1.0.019: cloudflared does not strip path
prefixes, so a `…/ingest/onlive/whip` address arrives at the control server on
8080, where there is no WHIP endpoint.

### A small annoyance

"Retrying in **0 s** (#1)" — the first backoff can be 800 ms because of the ±20%
jitter, and integer division made that zero. It now rounds up, so the smallest
value shown is 1 s.

### Tests

5 new tests (225 → 230). The ack is measured through a real HTTP server:
`flowing` reflects the actual ingest state, stalled data is its own signal,
`start` and `ping` acknowledge too — and a wrong stream key returns 401 with no
ack at all, so no internal state leaks without authentication.

---

## 1.0.101 — portrait and landscape, a lens slider, and a local route

*2026-08-16*

Six requests in one release. What they have in common is that each one removes a
decision the system used to make for you.

### 1. The preview keeps the stream's aspect ratio

The camera image used to fill the display, so the edges showed things that never
made it into the broadcast. It now sits in a fixed 16:9 or 9:16 box with
`FIT_CENTER` scaling: **what you see is what goes out**.

### 2. 2160p

The resolution list lived in three places — the Android enum, the server
validation and the admin HTML buttons. Adding 4K made the obvious point: one
list is easy to extend, three are easy to forget. The two server-side ones now
come from a single module (`device/capture-options.js`), and a test measures
them against the admin UI's buttons.

The video bitrate ceiling went from 12,000 to **25,000 kbps**, because 12 Mbit/s
is not enough for 4K — the old limit would have silently clamped the value. The
same limit now applies on the server, on the phone and on the slider.

### 3. Lens slider and a Chromecast icon

The four optics sit on one axis — ultra-wide → main → tele, with the front
camera at the end — so you can drag across them instead of aiming at a chip for
every switch. The list is device-specific, so the slider's step count comes from
the optics actually present. Screen sharing got a **Chromecast** icon.

### 4. 16:9 landscape and 9:16 portrait

A rotate button on the main screen, chips in the settings, and the same switch
on the admin UI. The important part: the orientation is **not decided by how you
hold the phone**. We set the capture use cases' `targetRotation` explicitly, so
the aspect ratio does not flip when the device moves in your hand.

The button is **only active while idle**. Changing the ratio mid-broadcast would
make the composition jump for viewers — the OBS scene, the overlays and the
recording are all cut for one ratio. A command arriving from the web UI during a
broadcast is stored, and the phone says it takes effect at the next start.

WebRTC receives the **swapped** dimensions (`captureWidth`/`captureHeight`),
otherwise the encoder would scale a 9:16 image into 16:9. Resolution selection
stays in landscape sensor coordinates, because that is where CameraX looks for a
matching size.

### 5. About box

The app's name and version at the bottom of the settings, read from
`BuildConfig` rather than written into the UI as text. The version now lives in
exactly one place: `app/build.gradle.kts` (`versionName = "1.0.101"`).

### 6. Local route — LAN and Tailscale

The most valuable of the six. WHIP **signalling** passes through the Cloudflare
Tunnel, WebRTC **media does not** — that needs TURN. But when the phone and the
server are on the same network (or in the same Tailscale network), the tunnel
can be bypassed: the picture stays local, **there is a broadcast without TURN**,
and latency drops.

So the phone's settings now have a *Local access* section (local control URL +
local ingest URL) and a **connection mode**:

| Mode | Behaviour |
|---|---|
| Automatic | probes the local address and uses it if it answers, otherwise the tunnel |
| Local only | LAN / Tailscale exclusively |
| Tunnel only | the public addresses exclusively |

The addresses do not have to be guessed: the server prints them on the
**admin → Stream key** tab, from its own network interfaces. The Tailscale
address goes first because it works away from home too; it is recognised by the
100.64.0.0/10 CGNAT range rather than the interface name (which is `Tailscale`
on Windows, `tailscale0` on Linux and `utun3` on macOS — the last of which tells
you nothing).

The `AUTO` probe runs on a **separate client with a 1.5-second timeout**. The
regular 8 seconds would mean the "Start" button hangs that long on mobile data
before falling back to the tunnel. The result is cached for 30 seconds, so it
recovers by itself after a network change.

And the part that matters most: the **reason** for the choice is printed — on the
main screen and in the connection test. A silent route choice would be exactly
the kind of hard-to-trace failure the recent releases have been fixing.

### Tests

14 new tests (211 → 225). The resolution and orientation lists are measured
against the admin HTML, Tailscale detection is checked at the CGNAT boundaries
(100.63 and 100.128 are not Tailscale), the private ranges at the RFC 1918 edges
(172.32 falls outside), and the suggested addresses are checked to point at the
right ports.

---

## 1.0.019 — the 404 that was not about the server

*2026-08-16*

The phone's **Test connection** button reported *"the address is reachable, but
no OnLIVE server answers (HTTP 404)"* on a live installation. Everything was
right except one thing: the **Control server** field held the address of the
admin *page*.

```
field:   https://live.example.com/admin
called:  https://live.example.com/admin/api/session/ping   → 404
correct: https://live.example.com
```

The app appends its own paths to the base address, so `/admin` — which is a
page of the server, never part of the origin — pushed every request one level
too deep. Nothing in the system said so: the server was running, the tunnel was
up, the stream key was valid.

Guardrails, in the four places this can go wrong:

- **The phone** normalises the addresses when saving: a trailing `/admin` or
  `/live` comes off the control URL, and a pasted `…/<stream>/whip` comes off the
  ingest URL. The corrected value is written back into the field, so it is
  visible what was saved. Other paths are left alone — a server behind a reverse
  proxy may legitimately live under one.
- **The 404 message** now names the URL it actually called and states the rule,
  instead of blaming the server.
- **The server** checks all three `ONLIVE_PUBLIC_*_URL` values at startup and
  logs a concrete error, including the corrected form.
- **The Stream key tab** shows the same findings, since that is the page people
  copy these values from.
- **`config.bat`** rejects an address with a path and offers the origin instead.

### The second, quieter half

The same installation had `ONLIVE_PUBLIC_INGEST_URL=https://live.example.com/ingest`
— one hostname for everything. That cannot work, and it is worth stating why:
WHIP goes to **MediaMTX on port 8889**, the control server listens on 8080, and
**cloudflared does not strip path prefixes**, so `…/ingest/onlive/whip` arrives
at the control server exactly as written. The ingest address needs its own
tunnel hostname (`ingest.example.com → http://localhost:8889`). The server now
warns when the ingest and admin hosts are identical.

Nine new tests (211 in total), including the wizard correcting a pasted
`…/admin` address end to end. `.env.example` and the troubleshooting table in
`docs/OPERATIONS.md` now state the base-address rule explicitly.

---

## 1.0.018 — an unresolved merge conflict in `gradle.properties`

*2026-08-16*

The toolchain moved up to **AGP 9.3.1 / Gradle 9.5.0** — which is the right
pairing, since AGP 9 requires Gradle 9.5 or newer. The commit that did it,
however, also carried a file that was never finished merging:

```
<<<<<<< Updated upstream
...
=======
...
>>>>>>> Stashed changes
```

`android/gradle.properties` went into the repository with those markers still in
it. That is worse than a syntax error, because it is not one: Gradle reads
`.properties` line by line, turns the markers into meaningless keys, and carries
on — so the build does not stop, it just no longer means what it looks like.

The file is now resolved. The block Android Studio added stays, because those
switches are not cosmetic — `android.builtInKotlin=false` and
`android.newDsl=false` are what keep the classic `org.jetbrains.kotlin.android`
plugin and the familiar `android { }` DSL working under AGP 9. AGP still prints
a deprecation warning for each of them; they are yellow triangles, not errors,
and removing them is only safe together with migrating to built-in Kotlin.

Dropped in the process: `android.dependency.excludeLibraryComponentsFromConstraints`
from 1.0.016. That was AGP 8.13's suggestion; the AGP 9 toolchain sets
`android.dependency.useConstraints=true` instead, and holding both would be two
settings pulling against each other.

### A guard against the next one

Three new tests (203 in total). One walks every text file in the repository and
fails on any conflict marker — it fails on the previous commit and passes on
this one. The other two check that the build configuration files exist and that
the AGP major version and the Gradle wrapper still match, since that mismatch
stops the build before compilation even starts.

---

## 1.0.017 — `config.bat`: setup is no longer file editing

*2026-08-16*

Until now, installing OnLIVE meant editing five files by hand: copy
`.env.example`, run `npm run keygen`, copy two lines, run
`npm run hash-password`, copy another line, then open `hook-env.example.bat` and
fill that in too. Every one of those steps can be mistyped — and a mistyped
secret does not produce an error message, it produces a system that silently
refuses to authenticate.

**`config.bat`** replaces all of it. It asks, in order, for the nine things that
actually need deciding, and writes them where they belong:

| Step | Question | Written to |
|---|---|---|
| 1 | server port | `.env` **and** `server/data/server.json` |
| 2 | admin password | `.env`, as a **scrypt hash** |
| 3 | stream key (generated or manual) | `server/data/stream-key.json`, hashed |
| 4 | `/live` protection | `.env` (`ONLIVE_LIVE_TOKEN`) |
| 5 | public domain | the three `ONLIVE_PUBLIC_*_URL` values |
| 6 | stream path | `.env` |
| 7 | MediaMTX location | `.env` |
| 8 | tunnel service name | `.env` |
| 9 | hook secret (automatic) | `.env` **and** `infra/mediamtx/hooks/hook-env.bat` |

Passwords are typed **hidden** and entered twice, then hashed immediately — the
raw password never reaches a file, and the test suite asserts exactly that by
grepping every file the wizard writes. The stream key is shown once at the end,
because that is the one value that has to be typed into the phone.

Two settings are written in **two** places on purpose, because the second one is
where the silent failures used to come from: the port also goes into
`server/data/server.json` (the UI value outranks `.env`, so writing only `.env`
would have left the answer with no effect), and the hook secret also goes into
`hook-env.bat` (the MediaMTX hooks run in a separate process and never see
`.env`).

### Careful writing

The wizard **writes nothing** until you confirm the summary, and the previous
`.env` is copied to `.env.bak` first. The file is updated line by line rather
than regenerated, so the template's explanatory comments survive — otherwise the
first run would replace a documented template with a bare list of keys.

Values are quoted with **single** quotes when quoting is needed. This is not a
style choice: Node's `--env-file` turns `\n` into a real newline inside double
quotes, so a perfectly ordinary `C:\new\mediamtx.exe` path would break in half.
Single quotes pass everything through untouched. Both behaviours were measured
against Node, not assumed, and both directions are covered by tests.

The wizard needs **no `npm install`** — it only uses Node's built-in modules, so
it can run as the very first step on a fresh machine. It is also available as
`npm run config` on Linux and macOS.

### Tests

The suite grew from 172 to 200. The wizard is driven end to end in a throwaway
directory (`ONLIVE_CONFIG_ROOT`), and the resulting files are checked: the stored
hash verifies against the password that was typed, the printed stream key
verifies against the hash on disk, the hook environment carries the same port and
secret, the template comments are still there, and answering "no" at the end
leaves every file untouched.

---

## 1.0.016 — the yellow triangles in the sync log

*2026-08-16*

After 1.0.015 the build succeeds, but the sync log fills up with warnings. They
are worth writing down, because most of them **cannot be fixed from this
repository** — and that is not obvious from the message text.

**Deprecated project options.** AGP reports seven settings as deprecated
(`android.builtInKotlin=false`, `android.newDsl=false`,
`android.enableAppCompileTimeRClass=false`, and four more). None of them are set
in `android/gradle.properties`: **Android Studio passes them to AGP itself**
during sync, for its own compatibility. Since we never set them, we cannot unset
them either — they disappear with a newer Studio release.

**Obsolete variant APIs** (`applicationVariants`, `testVariants`,
`unitTestVariants`). Our build scripts call none of these; the warnings come
from the same injected configuration.

**The Kotlin plugin note** — *"`org.jetbrains.kotlin.android` is no longer
required since AGP 9.0"* — is forward-looking. Built-in Kotlin support arrives
with AGP 9, which requires **Gradle ≥ 9.5**, and the wrapper is on 9.3.0. Until
the toolchain moves to AGP 9, the plugin stays.

**The one thing we do control** is the performance suggestion AGP repeats four
times, so it is now set:

```properties
android.dependency.excludeLibraryComponentsFromConstraints=true
```

Every version in this project is pinned in `libs.versions.toml`, so the
dependency constraints published in AAR metadata do not decide anything here —
skipping them only shortens the configuration phase. It is a single line, and
deleting it reverts the change.

All of this is now documented in `android/gradle.properties` itself, so the next
time the triangles show up the answer is next to the file they are about.

---

## 1.0.015 — compileSdk 36, so the new libraries build

*2026-08-16*

The 1.0.014 dependency bump failed at `:app:checkDebugAarMetadata` with 13
issues: CameraX 1.6, androidx.core 1.18 and activity 1.13 all ship with
`minCompileSdk = 36`, while the project compiled against 35.

`compileSdk` is now **36**. As the error message itself points out, this is
independent of the other two levels, so nothing about runtime behaviour changes:

| Setting | Value | Meaning |
|---|---|---|
| `compileSdk` | 36 | which APIs we compile against — required by the dependencies |
| `targetSdk` | 34 | which runtime behaviour we opt into — unchanged, still the segment 2 decision |
| `minSdk` | 26 | which devices can install the app |

Android Studio may need to download the API 36 platform on the first sync.

---

## 1.0.014 — 16 KB page-size compatibility, pinned toolchain

*2026-08-16*

A Galaxy S26 Ultra refused the app with *"not compatible with the 16 KB size —
ELF alignment check failed"*, listing four native libraries. New devices run
with 16 KB memory pages, and every `.so` has to be aligned to that.

The alignment is the **libraries'** job, so the fix is a version bump — all of
these ship 16 KB-aligned builds:

| Library | Was | Now | The `.so` it fixes |
|---|---|---|---|
| CameraX | 1.3.4 | 1.6.1 | `libimage_processing_util_jni.so` |
| DataStore | 1.1.1 | 1.2.1 | `libdatastore_shared_counter.so` |
| Compose BOM | 2024.09.02 | 2026.06.01 | `libandroidx.graphics.path.so` |
| WebRTC | 125.6422.07 | 144.7559.12 | `libjingle_peerconnection_so.so` |

On our side only the packaging matters: `jniLibs { useLegacyPackaging = false }`
is now stated explicitly, so native files stay uncompressed and page-aligned
(AGP already defaults to this above minSdk 23).

### Toolchain

- **AGP 8.5.2 → 8.13.2.** This clears the *"tested up to compileSdk = 34"*
  warning — the project compiles against 35.
- **The Gradle version is now pinned** in `gradle/wrapper/gradle-wrapper.properties`
  (9.3.0, matching the wrapper committed alongside). There was no wrapper config
  at all before, so Android Studio used whatever it had and the build differed
  from machine to machine. AGP enforces its own minimum — read out of the AGP
  jars themselves: **AGP 8.13.x needs Gradle ≥ 8.13, AGP 9.x needs ≥ 9.5**. So
  8.13.2 is happy on 9.3.0, and moving Gradle to 9.7.0 needs no AGP change.
- **Kotlin 2.0.20 → 2.3.21**, with `kotlinOptions` replaced by the modern
  `kotlin { compilerOptions { … } }` block, plus refreshed core-ktx, lifecycle,
  activity-compose and coroutines.

> Every version here was checked against the actual Maven metadata, but this
> environment has no Android SDK: **the build itself is unverified**. If a
> Gradle sync fails, this commit is self-contained and can be reverted on its
> own — the camera fixes in 1.0.013 do not depend on it.

---

## 1.0.013 — Camera preview and lens switching actually work

*2026-08-16*

Three symptoms on a Galaxy S26 Ultra, one shared root cause plus one separate
bug — both in the app.

### Black preview, dead lens buttons

The capture pipeline lives in the Service so a broadcast survives switching
apps. But the camera was only ever started by **"Kezdés"**, so opening the app
bound no camera at all: the preview stayed black, and because `cameraSource`
was `null`, the lens buttons, the torch and the photo button silently did
nothing.

There is now a preview mode: the Service starts the camera when the Activity
becomes visible (`ACTION_PREVIEW`) and releases it when the Activity goes away
— unless a broadcast is running, in which case it keeps streaming untouched.
Pressing "Kezdés" now only adds the WHIP connection to an already-running
camera.

While previewing, frame conversion is throttled to ~2 fps: the WebRTC sink is
`null` then, so converting 1080p30 YUV → I420 would burn CPU and battery for
frames nobody consumes. The throttled frame is what the photo button uses.

### Optics could not be switched

Lens discovery walked `cameraIdList` and then filtered CameraX cameras by
`Camera2CameraInfo.cameraId`. On modern phones the rear optics sit behind a
single *logical* camera — `cameraIdList` returns just that one, and the tele and
ultra-wide are *physical* sub-cameras whose ids CameraX never reports. So the
filter always came up empty, the fallback returned the same camera, and the
switch silently did nothing.

Now the physical sub-cameras are read via `getPhysicalCameraIds()` (API 28+),
classified by focal length, and switched with a **zoom ratio** (focal ÷ main
focal, clamped to the camera's real zoom range) — which is how the system picks
the physical optic. Front ↔ back still uses a `CameraSelector`, because that
genuinely is a separate camera.

A welcome side effect: switching between rear optics no longer rebinds the
camera, so it is instant instead of dropping 300–800 ms of frames.

### Compiler warnings

`Icons.Filled.ArrowBack` / `ScreenShare` → the `AutoMirrored` variants, and the
`@OptIn(ExperimentalCamera2Interop::class)` that the current CameraX no longer
requires (it warned that the annotation has no effect) is gone.

> Verified by reading and static checks only — there is no Android SDK in this
> environment, so the build and the device behaviour still need a run on your
> machine.

---

## 1.0.012 — start.bat: fixed the vanishing window, added step-by-step output

*2026-08-16*

### Fixed: the window flashed and disappeared

`start.bat` opened and closed instantly, showing nothing. The cause was a single
unescaped character:

```bat
if errorlevel 1 (
    echo   [!] A(z) "%TUNNEL_SERVICE%" service nincs telepitve.
```

Inside a parenthesised block the unescaped `)` in `A(z)` **closes the block**, so
the later `) else (` became a syntax error and cmd aborted the whole file — before
doing anything useful.

The fix is not careful escaping but removing the hazard: the script now branches
with `goto` and contains **no parenthesised blocks at all**, so this class of bug
cannot come back. `server/test/start-script.test.js` enforces it, along with
ASCII-only content, CRLF line endings, resolvable `goto` targets, and the rule
that every error path ends at the shared `:end` with a `pause`. Verified against
the old file: it fails there.

### Added: you can see where the startup is

```
   [1/5] Cloudflare Tunnel ellenorzese
         OK   A tunnel service mar fut.
   [2/5] Node.js ellenorzese
         OK   Node.js v22.11.0
   [3/5] Port ellenorzese
         OK   A szerver a 8080-es porton fog indulni.
         Helyi cim:  http://localhost:8080/admin
```

- The **port and the local URL are printed before the server starts**, and the
  script warns if something already listens there ("if it stops with EADDRINUSE,
  this is why"). The port comes from the server's own configuration via the new
  `server/tools/port.js`, so it matches whatever the Server tab is set to.
- `npm` is checked separately from `node`, and a failed `npm install` stops with
  an explanation instead of failing later in a confusing way.
- On exit the script prints the **last 20 lines of the log**, formatted from the
  JSON records — so a fast crash is visible even after the console scrolled.
- Every path — including every error — ends with the window open and a clear
  message. Each step is also appended to `logs/startup.log`, so even a hard
  parse failure leaves a trace of how far it got.

**172 tests, all green.**

---

## 1.0.011 — Configurable server port, new default 8080

*2026-08-16*

- **The port is now set from the web UI** — a new **Server** tab. It takes
  effect on the **next start**: a running server cannot change ports without
  tearing down every open connection (Socket.io, the playback proxy, an ongoing
  broadcast), so the change is stored and applied at startup.
- **The default port is 8080** (was 3000). The template configurations, the
  installer, the watchdog and the docs all moved with it.
- Precedence, when the port is set in more than one place: the value from the
  web UI, then `ONLIVE_SERVER_PORT`, then 8080. The UI value deliberately wins —
  `.env` is written once at install time, while the UI is where the operator
  acts now; the other way round the button would be dead for everyone using the
  template `.env`.
- **The port lives in three other files**, and if they keep pointing at the old
  one the system fails quietly: the public addresses answer 502 and the phone
  gets 401 on WHIP. So the Server tab lists the exact lines to change, and the
  server **compares those files against its own port at startup** and logs any
  mismatch:

  ```
  HIBA  MediaMTX hitelesítés: a(z) C:\OnLIVE\mediamtx\mediamtx.yml még a 3000
        portra mutat, a szerver viszont a 8080-on hallgat.
  ```

- Ports below 1024 and commonly occupied ones (3306, 8888, 9997 …) are accepted
  but warned about, since that is a judgement call, not an error.

**164 tests, all green.** The full lifecycle was verified against a running
server: set the port on the UI → restart → the server comes up on the new port,
and the old one stops answering.

---

## 1.0.010 — Stream key on the web, connection settings on the phone

*2026-08-16*

Until now the stream key lived in `.env` as plain text, and the same value had
to be copied into the MediaMTX configuration by hand. From this version it is
created on the web UI and **only its hash is stored**.

### Stream key management (web UI)

- New **Stream key** tab in the admin surface: generate a key (32 characters,
  cryptographic randomness) or enter your own.
- Requirements, enforced on both sides: **at least 16 characters**, with
  lowercase, uppercase, a digit and a special character. The form marks each
  rule as you type; the server validates again on save, so bypassing the UI
  does not let a weak key through.
- The raw key leaves the server **exactly once** — in the response that created
  it, which the page shows once with a copy button. After that it cannot be
  read back from anywhere.
- Storage is a **scrypt hash** (`data/stream-key.json`), the same primitive as
  the admin password. No fingerprint or "reminder" of the key is stored either:
  a fast hash next to the file would undo the very slowness scrypt is there for.
- Creating a new key invalidates the old one immediately. The status panel shows
  when the key was created and last used — never the value.

### MediaMTX no longer stores a password

The reason the "hashed only" claim holds end to end: MediaMTX now delegates
every authentication question to the control server (`authMethod: http` →
`POST /api/ingest/auth`), which checks it against the hash. Nothing secret goes
into `mediamtx.yml` any more.

The endpoint is callable from localhost only, and failed publish attempts feed
the same per-IP lockout as the login. One operational consequence, documented:
if the control server is down, MediaMTX denies every publish — so a "401 on
WHIP" means a stopped Node server before it means a bad key.

### Android: the gear now opens a real settings screen

- The gear icon leads to a full-screen settings page instead of the cramped
  quality dialog.
- **Connection** section: stream key (masked, with a reveal toggle) and the
  Cloudflare Tunnel addresses — control server, ingest, stream path, ingest
  user.
- **Test connection** button: one `GET /api/session/ping` tells you whether the
  address and the key are right, without having to start a broadcast. Errors are
  specific — a wrong key points you back at the web UI.
- **TURN** and **Quality** sections alongside it; the system Back button closes
  the settings rather than the app.

### Fixed

- **The entire admin page's JavaScript was dead in the browser.** A line break
  had slipped inside a quoted string in `admin.html` (`join('` … `')`) back in
  segment 10, so the whole inline script failed to parse: tabs, start/stop
  buttons, live state and the security pill did nothing. Found with a real
  headless browser while testing this release.
- New test file (`test/web-pages.test.js`) parses every inline script in every
  served page, so a syntax error can never ship silently again. Verified against
  the old broken file: it fails there.

**146 tests, all green.**

---

## 1.0.000 — Base phase closed

*2026-08-16*

The eleven planned segments are complete: the system works end to end, from
pressing "Start" on the phone to the composited picture appearing in OBS.

Included in this release beyond `0.11`, from a full audit of the codebase:

- **`/live?preview=`** put its parameter into `innerHTML`. Since `/live` is served
  on every host, a crafted `admin…/live?preview=…` link executed code in a
  logged-in admin's origin — and the CSRF token lives in `sessionStorage`, so
  that meant session takeover. The screen name is now whitelisted.
- **`/admin/login?next=`** accepted `javascript:` URLs and external addresses,
  which `location.replace()` then executed or followed. Only own absolute paths
  are accepted now.
- **The admin surface rendered phone telemetry with `innerHTML`** — the holder of
  the stream key (a lower privilege tier) could run code in the admin page.
- **`trust proxy: true` → `'loopback'`.** Previously the first element of the
  client-supplied `X-Forwarded-For` became `req.ip`, so an attacker could claim a
  fresh IP for every attempt and never hit the login rate limit.
- **`new URL(...).pathname` → `fileURLToPath`.** On Windows — the target platform —
  the former yields `/C:/…` and percent-encodes spaces, so the data and log
  directories were never created under a path like `C:\Program Files\OnLIVE`.
- **A malformed cookie** (`onlive_session=%`) threw inside the cookie parser,
  which runs in the auth middleware: one broken cookie meant HTTP 500 on every
  request.
- **The log stream was buffered**, so `process.exit` dropped the lines that had
  not been flushed yet — exactly the ones about shutting down.
- Smaller fixes: the metrics recorder called `.toFixed()` on phone-supplied
  values (a non-number silently lost the sample); resolution appeared in two
  forms in the log (`P720` vs `720p`), making every change look like two; the
  bulk overlay-replace endpoint logged nothing; `start.bat` became pure ASCII
  (the Windows console codepage is not UTF-8).

**118 tests, all green.** The two injection bugs were verified in a real headless
browser both before and after the fix; the rate limit and the log flush were
verified against a running server.

---

## 0.11 — Deployment, operations, test plan

*2026-08-15* · segment 11

- **One entry point.** `npm start` (`server/tools/start.js`) checks the
  cloudflared service, checks MediaMTX (API probe, starts it if missing), then
  starts the control server **in the same process** — one window, one log, one
  Ctrl+C. A missing dependency is a warning, never fatal.
- **`start.bat`** in the project root: the tunnel check happens *before* Node
  (that is where it surfaces if administrator rights are needed), `npm install`
  on first launch, a console window that stays open, and timestamped lines
  appended to `logs/startup.log`.
- **A unified structured logger** (`server/src/log/logger.js`) used by every
  component. Colored line to the console, one JSON object per line to
  `logs/YYYY-MM-DD.log`, rotating by date.
- What the log records: WHIP ingest connect/disconnect (telling "stalled" apart
  from "disconnected"), Socket.io connect/disconnect with the **OBS Browser
  Source flagged separately** by User-Agent, every state machine transition, and
  **every settings change with its old and new value** (quality, lens, source,
  widget, media, outro length, chat links). Every entry carries the source
  (phone / web UI / OBS / ingest / timer) and a client identifier — of the session
  token only a 6-character fingerprint, never the whole thing.
- **The four mandated test scenarios** as runnable tests
  (`server/test/scenarios.test.js`): first start → intro until the stream
  arrives; an interruption after more than 2 minutes live → resumes on its own;
  pause with no reconnect timer; "End" from the web UI → outro → timed `ended`.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): installation order, start/stop, log
  format and how to read it, the manual walkthrough of the four scenarios with
  expected results, troubleshooting table.

---

## 0.10 — Security and authentication

*2026-08-15* · segment 10

- **Three privilege tiers, strictly separated:** admin (session cookie), phone
  (stream key), viewer/OBS (optional playback token). The playback token grants
  **view only** — it can neither control the session nor read telemetry, and a
  test enforces this.
- Admin login with **scrypt-hashed** password, HttpOnly + SameSite=Strict
  session cookie, and a **double-submit CSRF token** that the JavaScript keeps
  separately (the cookie alone is not enough for a state-changing request).
- **Rate limiting** per IP with exponential lockout: 5 failed attempts → 30 s,
  doubling up to 15 minutes. A successful login clears the counter.
- The WHIP ingest is protected by a unique, high-entropy stream key — the same
  value in the MediaMTX configuration.
- Security headers (CSP, `nosniff`, `frame-ancestors`), and a security status
  panel that flags weak or missing secrets at startup and on the admin surface.

---

## 0.9 — Stream monitor, log and links

*2026-08-15* · segment 9

- **Stream monitor:** live technical data (instantaneous bitrate, resolution,
  framerate, RTT, jitter, packet loss) plus a small preview of the **raw incoming
  stream** — deliberately distinct from the `/live` composite, as an admin-only
  diagnostic.
- **Downloadable log:** every state transition with durations and average /
  min / max bitrate per period, filtered by session or date range. CSV with BOM
  and semicolons for Hungarian Excel, comma-separated for Google Sheets.
- An embedded chart of the bitrate timeline with the interruptions marked in red.
- **Chat-link collector:** named links that open in a new tab with one tap on a
  phone — explicitly *not* the embedded widgets of `0.7`. Only `http`/`https`
  schemes are accepted.

---

## 0.8 — Admin web UI

*2026-08-15* · segment 8

- The full control surface at `/admin`: live status, Start/End (either surface
  can do it), camera selector, resolution / bitrate / framerate / audio sliders,
  widget editor, overlay-media uploader with preview, plus the `0.9` monitor and
  link collector as separate tabs.
- **The web→phone command channel.** Without it the two surfaces drift apart:
  after an admin presses "End" the phone would keep publishing and keep showing
  "LIVE". Commands ride along in the response to the phone's telemetry request —
  zero extra requests, at most 3 seconds of delay.
- Two-way real-time sync over Socket.io, and a minimalist dark design with shared
  tokens (`admin.css`).

---

## 0.7 — Widget system

*2026-08-14* · segment 7

- Freely movable and resizable widgets on a fixed 1920×1080 canvas, with a
  drag-and-drop editor: logo (uploaded image), 3rd-party embed (chat, alerts),
  text and notification.
- Position, size, visibility and layer are persisted, so a layout **survives a
  server restart**.
- **The embed sandbox is the heart of this segment:** third-party code runs in
  its own document, in an `allow-scripts` iframe **without** `allow-same-origin`,
  reachable only through a per-widget random key. So the embedded script gets an
  opaque origin — it cannot reach the parent DOM, the cookies, or read the
  playback token out of its own address bar.
- Rendering is incremental: a chat iframe is not recreated on a state change, so
  it does not reconnect and lose its history.

---

## 0.6 — OBS integration

*2026-08-14* · segment 6

- The `/live` composite page: a single canvas carrying the state screen and the
  active overlay widgets, with a transparent background wherever there is no
  content. In OBS it is one Browser Source at 1920×1080.
- Video over **WHEP** (WebRTC, ~0.2–0.5 s latency), with HLS as an automatic
  fallback.
- A **playback proxy** so the browser talks to a single origin and MediaMTX can
  keep its read permission bound to localhost. The proxy rewrites the WHEP
  `Location` header: without that, an OBS restart would leave dead readers piling
  up inside MediaMTX.
- Socket.io keeps the page in step with state changes and overlay moves without a
  reload.

---

## 0.5 — Overlay and media handling

*2026-08-14* · segment 5

- Admin-uploadable intro / interrupted / outro media (jpg, png, webp, mp4, webm)
  with a configurable outro duration, local file storage and preview.
- **Validation looks at the file's content (magic bytes)**, not at the extension
  or the client-supplied `Content-Type`. An HTML file renamed to `.mp4` and
  embedded into `/live` would otherwise run arbitrary script.
- When the outro expires the state machine moves to `ended`: the publisher
  connection is actively dropped, so a stuck phone cannot make the next session
  jump straight to `live` off an old stream.
- The outro length is adjustable at runtime — the controller asks for it as a
  function, not as a fixed value.

---

## 0.4 — Control server: the state machine

*2026-08-12* · segment 4

- The `idle → intro → live → reconnecting / paused → outro → ended` machine as a
  **pure module** with an injectable clock and returned effects, so it is fully
  testable without I/O.
- **The 2-minute rule affects one decision only:** whether an interruption shows
  the "Interrupted" screen (≥ 2 minutes live) or "Starting soon" (below it).
  Nothing else.
- `paused` is independent of the threshold and has no backoff timer: the stream
  coming back does **not** lift it, only an explicit "Resume" does.
- A Socket.io event for every transition, so the web UI and the Browser Source
  follow in real time.
- **Ingest signalling is level-triggered, not edge-triggered.** An end-to-end test
  caught the bug: pressing "Start" while the phone was already publishing
  produced no rising edge, so the server sat in `intro` while a live stream was
  running. Now the current situation is sent on every poll and the machine is
  idempotent.

---

## 0.3 — Media ingest layer

*2026-08-12* · segment 3

- MediaMTX configuration: WHIP in; WebRTC, RTMP and low-latency HLS out.
- **Ingest monitoring on two channels.** Pull (the API polled every second) is the
  source of truth; push (the `runOnReady` / `runOnNotReady` hooks) only requests
  an immediate sample. That way a hook can hurry the decision but never falsify
  it.
- `ready: true` is not enough on its own — a publisher can stay connected while
  the data stops, so `bytesReceived` movement is what counts. This is what tells
  "stalled" apart from "disconnected".
- The interruption report is debounced (3 s by default) so a momentary network
  hiccup does not make the `/live` page flicker; recovery, by contrast, is
  reported immediately.
- A health-check endpoint plus an installer and ingest probe script.

---

## 0.2 — Android app: capture and publish

*2026-08-12* · segment 2

- Camera capture with CameraX, live lens switching (front / main / tele /
  ultra-wide) in under a second, torch, photo capture and parallel local
  recording.
- **Screen mode** over MediaProjection, and a one-button camera↔screen toggle.
- Microphone capture with quality selectors; resolution, bitrate and framerate
  are reported to the server so the admin surface shows what is actually going
  out.
- **WHIP publish** (RFC 9725) over WebRTC, with automatic reconnect using
  exponential backoff.
- **Background survival**, which is what makes this usable in practice: the whole
  capture pipeline runs in a Foreground Service (not the Activity), with the
  Android 14 FGS types (`camera|microphone|mediaProjection`), a wake lock, a
  battery-optimization exemption prompt, and a persistent notification with
  Pause/Stop actions. PIP is a bonus, not the mechanism.
- The app knows nothing about intro, outro or overlays. It reports what the user
  pressed: `POST /session/start`, `/pause`, `/resume`, `/end`.

---

## 0.1 — Architecture and networking

*2026-08-12* · segments 0–1

- [`ARCHITECTURE.md`](ARCHITECTURE.md): the four components and their strictly
  separated responsibilities, including an explicit list of what each component
  is **not** responsible for. Every later segment refers back to this.
- **Cloudflare Tunnel** instead of port forwarding or dynamic DNS: an outbound
  connection, so it works behind NAT and CGNAT, and the addresses survive an IP
  change or a reboot. Three subdomains — admin, live, ingest.
- Installed as a Windows service, with a watchdog that checks on three levels
  (process, connector, public endpoint) and restarts the tunnel automatically.
  If it is the Node server that is down, that is not the tunnel's fault, so the
  watchdog leaves it alone.
- Documented honestly: **the WHIP signalling passes through the tunnel, the
  WebRTC media does not** — that needs TURN or Tailscale. Along with what happens
  when the tunnel breaks versus when only the phone's connection does.
