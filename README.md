# 🐶 Dog Cam

A secure, minimal multi-client dog monitoring system. One stationary **iPad**
acts as the camera and streams **live video + microphone audio** peer-to-peer
to **up to two phones** at once. The Node.js server only brokers the WebRTC
handshake — it never sees or stores any media. The iPad uses its **front
camera by default** (so it can face the room while propped face-up), and a
**Flip** button in the live overlay switches to the back camera on the fly;
the choice is remembered per device.

The iPad page doubles as an **always-on kiosk dashboard**: when the camera is
off it shows a big clock and **live F/G train countdowns for the Carroll St
station** ("↑ Manhattan 4 min, ↓ Brooklyn 7 min"). You can turn the camera on
by hand, or set an **auto-on schedule** so it starts and stops itself during
the time windows you choose.

## Camera modes

- **Manual:** tap **Start Camera** on the iPad; tap **Stop** to return to the
  dashboard.
- **Scheduled:** open ⚙ and add one or more windows (days + start/end time).
  The camera turns on automatically inside a window and off when it ends. The
  schedule lives in the iPad's `localStorage`.
  - iOS only grants camera access after a user gesture, so for unattended
    scheduled starts **start the camera by hand once** to grant permission and
    keep the iPad on this page. If a scheduled start still needs a tap, the
    screen shows a one-tap "Start scheduled session" prompt instead of failing.
  - Manually tapping **Stop** during a window keeps it off until the window ends.

## Alerts & notifications

- **Bark alerts:** while the camera is live the iPad listens to its own mic with
  a Web Audio analyser. Sustained loudness above a threshold fires a single
  (rate-limited) alert that flashes on the iPad and is sent to the phones.
  Toggle it under ⚙ ("Bark alerts"); it's on by default and never keeps the mic
  open on the idle dashboard.
- **Camera on/off + bark push:** phones can tap **🔔 Alerts** in the viewer to
  be notified when the camera turns on or off, or hears barking — **even when
  the viewer app is closed**, via Web Push. This needs the viewer added to the
  Home Screen (iOS 16.4+ only delivers push to installed PWAs) and a one-time
  notification-permission tap. While the app is open you get the alert
  regardless of push support. Push is optional and degrades gracefully: with no
  `VAPID_*` keys set the server generates a pair at boot (works, but phones
  re-subscribe after a restart); set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` for
  durable subscriptions (`npx web-push generate-vapid-keys`).
- **Picture-in-Picture:** the viewer has a **⧉ PiP** button (where the browser
  supports it, including iOS Safari) so you can keep watching in a floating
  window while using other apps.
- **Torch:** when streaming from the **back** camera on a device that exposes
  the torch (Android Chrome; not iOS Safari), a **Torch** button appears in the
  live overlay for low-light watching.

## Reliability

- **Auto-reconnect:** both pages reconnect the signaling socket with exponential
  backoff, and the server runs a 30s ping/pong heartbeat that reclaims dead
  sockets (e.g. an iPad that dropped off wifi) so viewers are told the camera
  went offline.
- **Self-healing video:** if a peer connection wedges, the camera rebuilds it
  from a fresh offer and the viewer re-announces — recovering a stalled stream
  without a page reload.
- **Cool & cellular-friendly:** the camera captures at 720p/24fps and caps each
  viewer's video at ~1.2 Mbps, keeping the always-plugged-in iPad cooler and the
  uplink modest.

## Train arrivals

Both the iPad dashboard and the phone viewer show the next F and G trains at
**Carroll St** (GTFS stop `F21`). The server fetches the MTA's GTFS-realtime
protobuf feeds (BDFM for the F, plus the G feed — no API key required),
decodes them, and exposes a small JSON summary at **`/trains`** (cached ~20s).
The browser never touches protobuf or the feed URLs. The station, routes and
feed URLs are configurable via env vars (see the table below) so the same code
can power a different stop.

## Architecture

```
                 ┌───────────────────────────┐
                 │  Node.js server (port 3000)│
                 │  • Express static files    │
                 │  • ws signaling relay       │
                 │  • secret-token auth        │
                 └─────────────┬──────────────┘
            signaling (WS)     │     signaling (WS)
        ┌──────────────────────┴──────────────────────┐
        │                                              │
   ┌────▼─────┐         WebRTC media (P2P)        ┌────▼─────┐
   │  iPad    │ ───────────────────────────────► │ Phone 1  │
   │ (camera) │ ───────────────────────────────► │ Phone 2  │
   └──────────┘                                   └──────────┘
```

- **Mesh signaling:** every client gets a server-assigned UUID. SDP offers,
  answers and ICE candidates are routed only to the explicit `targetId`.
- **Per-viewer connections:** the iPad keeps an object mapping each phone's id
  to its own `RTCPeerConnection`, so both phones receive the stream
  concurrently and independently.
- **Media is peer-to-peer:** only signaling passes through the server. STUN is
  the public Google server `stun:stun.l.google.com:19302`.

## Security

Every WebSocket connection must present the shared secret as a query parameter:

```
ws://<host>/?secret=CleoCam
```

The token is validated **during the HTTP upgrade handshake** using a
constant-time comparison; connections without the correct token are rejected
with `401` before any signaling occurs. Configure it via the `STREAM_SECRET`
environment variable (it falls back to `CleoCam`).

> Note: a query-string secret is only as private as the transport. Run behind
> HTTPS/WSS in any real deployment so the token isn't sent in the clear.

## Running

```bash
npm install
STREAM_SECRET=CleoCam npm start
```

Then open:

- **iPad (camera):** `http://<server-ip>:3000/camera.html?secret=CleoCam`
- **Phones (viewers):** `http://<server-ip>:3000/?secret=CleoCam`

> Browsers only grant camera/microphone access on `localhost` or over HTTPS.
> For real devices on your LAN, terminate TLS (e.g. behind a reverse proxy or
> a tunneling tool) so `getUserMedia` is permitted.

### Use it like an app

Both pages are installable: open a link **with `?secret=` once** and the token is
saved to that device's local storage and stripped from the URL, so afterwards a
bare link (or home-screen icon) just works. On iOS use **Share → Add to Home
Screen** to get a fullscreen, standalone icon for the camera and the viewer.
Once installed and permission is granted, the camera starts on its own when
launched and the viewer auto-connects — open the icon and you're live. (If the
secret is ever missing, the page prompts for it once instead of failing.)

### Watching over cellular / from outside the house

See **[SETUP.md](./SETUP.md)** for two click-by-click guides:

- **No home computer** — host the signaling server in the cloud on
  [Render](https://render.com) (free HTTPS, works on cellular with a TURN relay).
  This needs only the iPad and your phone. A `render.yaml` blueprint is included
  for one-click deploy.
- **Tailscale** — keep the server on an always-on computer at home behind a free
  private VPN; no public exposure, no TURN needed.

### Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STREAM_SECRET` | `CleoCam` | Shared secret required on every connection. |
| `PORT` | `3000` | HTTP/WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address (all interfaces, so the LAN/VPN can reach it). |
| `TURN_URL` | — | Optional TURN relay URL(s). Needed for cellular **without** a VPN. Accepts a single URL (`turn:host:3478`) or a comma-separated list to advertise several transports at once (`turn:host:3478,turn:host:443?transport=tcp,turns:host:443?transport=tcp`) — the extra TCP/TLS/443 entries are what make cellular and locked-down wifi work. |
| `TURN_USERNAME` | — | TURN username (if `TURN_URL` set). |
| `TURN_CREDENTIAL` | — | TURN password (if `TURN_URL` set). |
| `CF_TURN_TOKEN_ID` | — | Cloudflare Realtime TURN **Turn Token ID**. When set with `CF_TURN_API_TOKEN`, the server mints **short-lived** TURN credentials per `/ice-config` request — no static username/password needed. Cloudflare's free allowance (1,000 GB/month) is far larger than typical free TURN tiers. Used in addition to any static `TURN_URL`. |
| `CF_TURN_API_TOKEN` | — | Cloudflare API token paired with `CF_TURN_TOKEN_ID`. |
| `CF_TURN_TTL` | `86400` | Lifetime (seconds) of each minted Cloudflare credential. |
| `TLS_CERT_FILE` | — | Path to a TLS certificate. When set with `TLS_KEY_FILE`, the server terminates HTTPS itself (HTTP/1.1 only — no HTTP/2), bypassing reverse-proxy issues like iOS Safari failing WebSocket-over-HTTP/2 through `tailscale serve`. |
| `TLS_KEY_FILE` | — | Path to the matching TLS private key. |
| `TRAIN_STOP_ID` | `F21` | GTFS stop-id prefix to report arrivals for (`F21` = Carroll St; `F21N`/`F21S` are its two directions). |
| `TRAIN_ROUTES` | `F,G` | Comma-separated GTFS route ids to include. |
| `TRAIN_FEEDS` | BDFM + G feeds | Comma-separated GTFS-realtime feed URLs to poll. Defaults to the MTA BDFM and G feeds. |
| `VAPID_PUBLIC_KEY` | — | Web Push VAPID public key. Set with the private key to keep push subscriptions durable across restarts. Generate with `npx web-push generate-vapid-keys`. If unset, an ephemeral pair is generated at boot. |
| `VAPID_PRIVATE_KEY` | — | Web Push VAPID private key (pairs with the public key above). |
| `VAPID_SUBJECT` | `mailto:dogcam@example.invalid` | `mailto:` or URL identifying the push sender (required by the Web Push spec). |
| `APP_VERSION` | `RENDER_GIT_COMMIT` or `dev` | Build label shown in both app headers and at `/version` & `/healthz`. On Render it auto-uses the deployed commit SHA; set this to override. |

> **Which build is live?** Both pages show a small `build <id>` tag in the
> header, and the server exposes it at **`/version`** (and `/healthz`). If the
> tag/endpoint doesn't match your latest commit after a deploy, Render hasn't
> redeployed yet — or the device is showing a cached copy (fully close the app
> and reopen, or remove and re-add the Home Screen icon).

The clients fetch their ICE/TURN list from the authenticated `/ice-config`
endpoint at startup, so STUN/TURN setup lives only in the server's environment.

## Memory management

- When a phone disconnects, the server removes its UUID from the registry and
  broadcasts `peer-left`. The iPad receives it, calls `closePeer(phoneId)`
  which closes the `RTCPeerConnection`, nulls its event handlers, deletes it
  from the `peers` map and drops buffered ICE candidates — freeing the slot for
  a new viewer. The shared camera stream keeps running for remaining viewers.
- `connectionstatechange` also triggers cleanup if a peer fails silently.
- `pagehide` closes all connections when a tab is backgrounded/closed on iOS.
