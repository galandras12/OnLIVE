# Changelog

[Magyarul](CHANGELOG.hu.md)

OnLIVE was built along a fixed plan of **eleven segments**. Each segment added
one self-contained, working layer, and responsibilities were never allowed to
bleed into each other (see [`ARCHITECTURE.md`](ARCHITECTURE.md)).

Segment *N* is released as version **0.N**, and version **1.0.000** closes the
base phase. The internal documents still speak of "segments" — this file is the
mapping between the two.

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
