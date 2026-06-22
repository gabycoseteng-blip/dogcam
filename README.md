# 🐶 Dog Cam

A secure, minimal multi-client dog monitoring system. One stationary **iPad**
acts as the camera and streams **live back-camera video + microphone audio**
peer-to-peer to **up to two phones** at once. The Node.js server only brokers
the WebRTC handshake — it never sees or stores any media.

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
ws://<host>/?secret=MySuperSecretToken123
```

The token is validated **during the HTTP upgrade handshake** using a
constant-time comparison; connections without the correct token are rejected
with `401` before any signaling occurs. Configure it via the `STREAM_SECRET`
environment variable (it falls back to `MySuperSecretToken123`).

> Note: a query-string secret is only as private as the transport. Run behind
> HTTPS/WSS in any real deployment so the token isn't sent in the clear.

## Running

```bash
npm install
STREAM_SECRET=MySuperSecretToken123 npm start
```

Then open:

- **iPad (camera):** `http://<server-ip>:3000/camera.html?secret=MySuperSecretToken123`
- **Phones (viewers):** `http://<server-ip>:3000/?secret=MySuperSecretToken123`

> Browsers only grant camera/microphone access on `localhost` or over HTTPS.
> For real devices on your LAN, terminate TLS (e.g. behind a reverse proxy or
> a tunneling tool) so `getUserMedia` is permitted.

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
| `STREAM_SECRET` | `MySuperSecretToken123` | Shared secret required on every connection. |
| `PORT` | `3000` | HTTP/WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address (all interfaces, so the LAN/VPN can reach it). |
| `TURN_URL` | — | Optional TURN relay URL(s). Needed for cellular **without** a VPN. Accepts a single URL (`turn:host:3478`) or a comma-separated list to advertise several transports at once (`turn:host:3478,turn:host:443?transport=tcp,turns:host:443?transport=tcp`) — the extra TCP/TLS/443 entries are what make cellular and locked-down wifi work. |
| `TURN_USERNAME` | — | TURN username (if `TURN_URL` set). |
| `TURN_CREDENTIAL` | — | TURN password (if `TURN_URL` set). |
| `TLS_CERT_FILE` | — | Path to a TLS certificate. When set with `TLS_KEY_FILE`, the server terminates HTTPS itself (HTTP/1.1 only — no HTTP/2), bypassing reverse-proxy issues like iOS Safari failing WebSocket-over-HTTP/2 through `tailscale serve`. |
| `TLS_KEY_FILE` | — | Path to the matching TLS private key. |

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
