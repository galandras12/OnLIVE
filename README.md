# OnLIVE

**Version 1.0.015** · [Changelog](CHANGELOG.md) · [Magyarul](README.hu.md)

Live broadcasting system. An Android phone (camera/screen + audio) publishes over
WHIP to a self-hosted server, which applies the intro / outro / interruption
logic and the overlays (logo, chat, notification), then serves the result both as
an OBS Browser Source and as a direct web player.

**Core principle:** the phone is a stream source and nothing else — every piece of
control logic lives on the server and in the web UI.

## Version 1.0

Version 1.0 closed the base phase of the project: the eleven planned segments
(`0.1` – `0.11`) are complete, so the system is usable end to end — from pressing
"Start" on the phone to the composited picture appearing in OBS, with logging,
authentication and a documented test plan.

**1.0.010** adds stream key management to the web UI (created there, stored as a
scrypt hash only) and a real settings screen behind the gear icon in the Android
app, where the key and the tunnel addresses are entered.

**1.0.011** makes the server port configurable from the web UI — effective on the
next start — and moves the default port to **8080**. **1.0.012** fixes `start.bat`,
which used to flash and disappear, and gives it step-by-step startup output.

The per-segment history is in [`CHANGELOG.md`](CHANGELOG.md); the machine-readable
version number is in [`versions.onlive`](versions.onlive).

## Components

1. **Android app** (Kotlin, CameraX + MediaProjection + WebRTC) — capture,
   encoding, WHIP publish.
2. **Media ingest** (MediaMTX) — WHIP in; WebRTC / RTMP / HLS out.
3. **Control server** (Node.js + Express + Socket.io, file-based JSON storage) —
   state machine, overlay composition, admin API.
4. **Web UI** — the `/admin` control surface and the `/live` composite player
   (OBS Browser Source).

## Public endpoints

```
Admin UI     : https://admin.galandras.com/admin    (tabs: control, overlay, media, OBS, monitor)
Live / OBS   : https://live.galandras.com/live      (Browser Source, 1920x1080)
Chat links   : https://live.galandras.com/links     (mobile, one tap)
WHIP ingest  : https://ingest.galandras.com/<stream>/whip
```

All of them are reachable through a single Cloudflare Tunnel — no port
forwarding, no dynamic DNS, and the addresses survive an IP change or a reboot.

## Getting started

```powershell
copy .env.example .env          # fill in the secrets and ports

# 1) networking: fixed public URLs from behind NAT
#    docs/NETWORKING.md - chapter 4 (installing cloudflared)

# 2) media ingest: this is where the phone publishes
#    docs/INGEST.md - chapter 6
cd infra\mediamtx
powershell -ExecutionPolicy Bypass -File .\install-mediamtx.ps1

# 3) control server
cd ..\..\server
npm install
npm run keygen                              # live token, hook secret
npm run hash-password -- "long password"    # admin password hash
npm test
npm start
```

Then create the stream key on the web UI — **Admin → Stream key** — and enter it
on the phone under the gear icon (**Connection** section). The server only ever
stores its hash, so copy it while it is shown.

## Setting the admin password

This is what you log in to `/admin` with. There is no default password: until you
set one, **the admin UI only answers from the machine itself** (localhost) — a
half-configured system must not stand open on a public address.

**1. Generate the hash** (in the `server` directory, with your own password in
quotes):

```powershell
cd server
npm run hash-password -- "a long password of your own"
```

It prints one line:

```
ONLIVE_ADMIN_PASSWORD_HASH=scrypt$16384$8$1$DLTHAcA8J5gUQnAdVIGZtg==$kwqOkiDHIas...
```

**2. Copy that line into `.env`** in the project root (create it from
`.env.example` if it does not exist yet), replacing the empty
`ONLIVE_ADMIN_PASSWORD_HASH=` line. Delete the `ONLIVE_ADMIN_PASSWORD` line while
you are there.

**3. Restart the server** (`start.bat`, or `Ctrl+C` then `npm start`). Settings
in `.env` are read at startup.

**4. Log in**: open `http://localhost:8080/admin` — it sends you to the login
page, where you type the password itself, not the hash.

A few things worth knowing:

- **Only the hash is stored**, so `.env` leaking does not hand over a usable
  password. The plain `ONLIVE_ADMIN_PASSWORD=…` still works for convenience, but
  the server warns about it at every start.
- **Use at least 12 characters.** The tool warns if the password is short or a
  well-known one, and the server reports weak secrets at startup and on the admin
  header ("védelem" pill).
- **Forgot it?** Nothing is tied to the old one: generate a new hash the same
  way, replace the line, restart. Existing logins stay valid until they expire —
  the **Security** section of the admin UI can also drop every session at once.
- The password is only for the web UI. The phone uses the **stream key** and
  never sees this password.

After that the daily start is a single action: **`start.bat`** in the project
root (tunnel check → MediaMTX → control server, in a console window that stays
open). Details: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Documentation

| Document | Contents |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | the 4 components and their strictly separated responsibilities |
| [`docs/NETWORKING.md`](docs/NETWORKING.md) | **0.1** — Cloudflare Tunnel, subdomains, watchdog, the WebRTC media path |
| [`docs/ANDROID.md`](docs/ANDROID.md) | **0.2** — capture, WHIP publish, background survival, reconnect |
| [`android/`](android/) | source of the OnLIVE Android app |
| [`docs/INGEST.md`](docs/INGEST.md) | **0.3** — MediaMTX, output formats, ingest monitoring, health check |
| [`infra/mediamtx/`](infra/mediamtx/) | MediaMTX configuration, hooks, installer, ingest probe |
| [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md) | **0.4** — state machine, the 2-minute rule, Socket.io events, API |
| [`server/`](server/) | source of the control server |
| [`docs/OVERLAY-MEDIA.md`](docs/OVERLAY-MEDIA.md) | **0.5** — intro / outro / interrupted media, validation, preview |
| [`docs/OBS.md`](docs/OBS.md) | **0.6** — Browser Source setup, transparent canvas, WHEP/HLS playback |
| [`docs/WIDGETS.md`](docs/WIDGETS.md) | **0.7** — widgets, drag-and-drop editor, sandboxed embeds |
| [`docs/ADMIN-UI.md`](docs/ADMIN-UI.md) | **0.8** — admin surface, design tokens, web→phone command channel |
| [`docs/MONITORING.md`](docs/MONITORING.md) | **0.9** — stream monitor, downloadable CSV log, chat-link collector |
| [`docs/SECURITY.md`](docs/SECURITY.md) | **0.10** — privilege tiers, login, stream key, CSRF |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | **0.11** — installation, startup, logging, test plan, troubleshooting |
| [`infra/cloudflared/`](infra/cloudflared/) | tunnel `config.yml` template + installation quick start |
| [`scripts/`](scripts/) | tunnel watchdog and its scheduled-task registration |

## Version history

| Version | Segment | Title |
|---|---|---|
| [`0.1`](CHANGELOG.md#01--architecture-and-networking) | 1 | Architecture and networking |
| [`0.2`](CHANGELOG.md#02--android-app-capture-and-publish) | 2 | Android app: capture and publish |
| [`0.3`](CHANGELOG.md#03--media-ingest-layer) | 3 | Media ingest layer |
| [`0.4`](CHANGELOG.md#04--control-server-the-state-machine) | 4 | Control server: the state machine |
| [`0.5`](CHANGELOG.md#05--overlay-and-media-handling) | 5 | Overlay and media handling |
| [`0.6`](CHANGELOG.md#06--obs-integration) | 6 | OBS integration |
| [`0.7`](CHANGELOG.md#07--widget-system) | 7 | Widget system |
| [`0.8`](CHANGELOG.md#08--admin-web-ui) | 8 | Admin web UI |
| [`0.9`](CHANGELOG.md#09--stream-monitor-log-and-links) | 9 | Stream monitor, log and links |
| [`0.10`](CHANGELOG.md#010--security-and-authentication) | 10 | Security and authentication |
| [`0.11`](CHANGELOG.md#011--deployment-operations-test-plan) | 11 | Deployment, operations, test plan |
| [`1.0.000`](CHANGELOG.md#10000--base-phase-closed) | — | **Base phase closed** |
| [`1.0.010`](CHANGELOG.md#10010--stream-key-on-the-web-connection-settings-on-the-phone) | — | Stream key on the web, connection settings on the phone |
| [`1.0.011`](CHANGELOG.md#10011--configurable-server-port-new-default-8080) | — | Configurable server port, new default 8080 |
| [`1.0.012`](CHANGELOG.md#10012--startbat-fixed-the-vanishing-window-added-step-by-step-output) | — | start.bat: fixed the vanishing window, step-by-step output |
| [`1.0.013`](CHANGELOG.md#10013--camera-preview-and-lens-switching-actually-work) | — | Camera preview and lens switching actually work |
| [`1.0.014`](CHANGELOG.md#10014--16-kb-page-size-compatibility-pinned-toolchain) | — | 16 KB page-size compatibility, pinned toolchain |
| [`1.0.015`](CHANGELOG.md#10015--compilesdk-36-so-the-new-libraries-build) | — | compileSdk 36, so the new libraries build |
