'use strict';

/**
 * Dog Monitoring System — Signaling Server
 * -----------------------------------------
 * Responsibilities:
 *   1. Serve the static client assets (camera.html, index.html) over Express.
 *   2. Host a WebSocket signaling server (using the `ws` library) on the SAME
 *      HTTP server so a single port serves both HTTP and WebSocket traffic.
 *   3. Authenticate every WebSocket connection with a shared secret token that
 *      is supplied as a `?secret=` query parameter. Connections without the
 *      correct token are rejected at the handshake layer — before any
 *      signaling data is ever exchanged.
 *   4. Act as a dumb-but-strict relay for a WebRTC mesh: assign every client a
 *      UUID, and forward SDP offers / answers / ICE candidates ONLY to the
 *      explicitly-addressed `targetId`. The server never inspects or stores
 *      media — all audio/video flows peer-to-peer between the iPad and phones.
 *
 * This server intentionally holds NO media. It is a signaling broker only.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The shared secret. Pulled from the environment when available so the token
// can be rotated without code changes, but falls back to a hardcoded constant
// for zero-config local use, exactly as specified by the requirements.
const STREAM_SECRET = process.env.STREAM_SECRET || 'MySuperSecretToken123';

const PORT = process.env.PORT || 3000;

// Bind to all network interfaces by default (0.0.0.0) rather than just
// loopback, so the server is reachable over the LAN / Tailscale hostname and
// not only from the machine it runs on. Override with HOST if you want to
// restrict it.
const HOST = process.env.HOST || '0.0.0.0';

// Optional: terminate TLS directly in Node instead of relying on a reverse
// proxy. This matters for tunnels like `tailscale serve` that proxy HTTP and
// negotiate HTTP/2 with the client — some mobile browsers (notably iOS
// Safari/WebKit) don't support WebSocket-over-HTTP/2 (RFC 8441 Extended
// CONNECT), so the WS upgrade silently fails through that kind of proxy even
// though plain GET requests work fine. Terminating TLS here means we only
// ever speak plain HTTP/1.1, which WebSocket upgrades always work with. Pair
// this with `tailscale serve --tcp` (raw TCP forward) instead of the default
// HTTP forward. Leave TLS_CERT_FILE/TLS_KEY_FILE unset to keep plain HTTP.
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;

// ---------------------------------------------------------------------------
// WebRTC ICE configuration
// ---------------------------------------------------------------------------
// The browsers need a list of ICE servers to negotiate a peer-to-peer path.
// Google's public STUN server is always included and is enough on the same
// network or over a VPN like Tailscale. For viewing over cellular WITHOUT a
// VPN you usually also need a TURN relay (cellular carriers use symmetric NAT
// that STUN can't traverse) — supply it via env vars and it gets handed to the
// clients automatically. With Tailscale you can leave the TURN vars unset.
function buildIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    // TURN_URL may be a single URL or a comma/whitespace-separated list, so one
    // set of credentials can advertise several transports at once. This matters
    // on cellular: only TURN over TCP and TLS on port 443 reliably punches
    // through restrictive carrier/captive networks, while UDP is faster when it
    // is allowed. Listing e.g.
    //   turn:host:3478,turn:host:3478?transport=tcp,turns:host:443?transport=tcp
    // lets the browser pick whichever path actually works.
    const urls = process.env.TURN_URL
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length) {
      servers.push({
        urls: urls.length === 1 ? urls[0] : urls,
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
      });
    }
  }
  return servers;
}

const ICE_SERVERS = buildIceServers();

// ---------------------------------------------------------------------------
// Express — static asset serving
// ---------------------------------------------------------------------------

const app = express();

// Everything in /public is served statically. index.html (the phone viewer)
// is served automatically at "/" while camera.html is reached at "/camera.html".
app.use(express.static(path.join(__dirname, 'public')));

// A tiny health endpoint that is handy for uptime checks / load balancers.
app.get('/healthz', (_req, res) => res.json({ ok: true, clients: clients.size }));

// The clients fetch their ICE/TURN configuration from here at startup so the
// STUN/TURN setup lives in one place (the server env) instead of being
// hardcoded in each HTML file. Requires the same shared secret so TURN
// credentials are never handed to an unauthenticated caller.
app.get('/ice-config', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ iceServers: ICE_SERVERS });
});

// Plain HTTP by default; HTTPS (terminated here, HTTP/1.1 only) when cert/key
// paths are provided. `https.createServer` never advertises HTTP/2 via ALPN
// unless explicitly configured to, so WebSocket upgrades are unaffected.
const server = (TLS_CERT_FILE && TLS_KEY_FILE)
  ? https.createServer(
      { cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) },
      app,
    )
  : http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket signaling server
// ---------------------------------------------------------------------------

// `noServer: true` lets us run our own `upgrade` handler so we can authenticate
// the token DURING the HTTP upgrade handshake and refuse the socket outright if
// the secret is missing or wrong — the rejected client never becomes a peer.
const wss = new WebSocketServer({ noServer: true });

// The live registry of connected clients, keyed by the UUID we assign.
//   id  -> { ws, role }
// role is informational ('camera' | 'viewer' | 'unknown'); routing is driven
// purely by explicit targetId values, not by role, keeping the relay simple.
const clients = new Map();

/**
 * Constant-time comparison of the provided token against the expected secret.
 * Using timingSafeEqual avoids leaking secret length / content through timing.
 */
function isValidSecret(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(STREAM_SECRET);
  // timingSafeEqual throws if buffers differ in length, so guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Handshake authentication ----------------------------------------------
// We intercept the raw HTTP upgrade so unauthorized clients are dropped before
// the WebSocket is ever established. This is the single chokepoint that
// enforces the shared secret.
server.on('upgrade', (request, socket, head) => {
  let secret;
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    secret = url.searchParams.get('secret');
  } catch (_err) {
    secret = null;
  }

  if (!isValidSecret(secret)) {
    // 401 + immediate socket destruction. No WebSocket upgrade happens.
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  // Token is valid — complete the upgrade and hand off to the connection logic.
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

/**
 * Send a JSON message to a specific client by id, if it is still connected.
 * Returns true when the message was handed to the socket.
 */
function sendTo(targetId, payload) {
  const client = clients.get(targetId);
  if (!client) return false;
  if (client.ws.readyState !== client.ws.OPEN) return false;
  client.ws.send(JSON.stringify(payload));
  return true;
}

// --- Per-connection lifecycle ----------------------------------------------
wss.on('connection', (ws) => {
  // Assign a cryptographically-random UUID to this peer. This id is how every
  // other peer addresses signaling messages to it via `targetId`.
  const id = crypto.randomUUID();
  clients.set(id, { ws, role: 'unknown' });

  // Tell the freshly-connected client its own id so it can stamp messages.
  ws.send(JSON.stringify({ type: 'welcome', id }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_err) {
      return; // Ignore non-JSON / malformed frames.
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // A phone announces itself. We forward the announcement to ALL other
      // peers; in practice only the iPad camera reacts to it by spinning up a
      // dedicated RTCPeerConnection for this viewer.
      case 'viewer-joined': {
        const me = clients.get(id);
        if (me) me.role = 'viewer';
        for (const [otherId, other] of clients) {
          if (otherId === id) continue;
          if (other.ws.readyState === other.ws.OPEN) {
            other.ws.send(JSON.stringify({ type: 'viewer-joined', from: id }));
          }
        }
        break;
      }

      // The iPad identifies itself as the camera (optional, informational).
      case 'camera-ready': {
        const me = clients.get(id);
        if (me) me.role = 'camera';
        break;
      }

      // Core mesh routing: SDP offers, SDP answers and ICE candidates are
      // relayed verbatim to the single addressed peer. The server adds a
      // trustworthy `from` field (our assigned id) so a peer can never spoof
      // its origin. If targetId is unknown/gone, the message is silently
      // dropped — the relay holds no queue and no media.
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (typeof msg.targetId !== 'string') return;
        sendTo(msg.targetId, {
          type: msg.type,
          from: id,
          // Pass through exactly the WebRTC payload the peer needs.
          sdp: msg.sdp,
          candidate: msg.candidate,
        });
        break;
      }

      default:
        // Unknown message types are ignored to keep the relay minimal.
        break;
    }
  });

  // --- Cleanup / memory management on disconnect ---------------------------
  // When ANY client drops we must (a) remove it from our registry so its UUID
  // is freed and we never try to route to a dead socket, and (b) notify the
  // remaining peers so THEY can tear down the matching RTCPeerConnection and
  // release its memory. This is what prevents leaked peer connections on the
  // iPad when a phone walks out of range or closes its tab.
  ws.on('close', () => {
    clients.delete(id);
    for (const [, other] of clients) {
      if (other.ws.readyState === other.ws.OPEN) {
        other.ws.send(JSON.stringify({ type: 'peer-left', from: id }));
      }
    }
  });

  ws.on('error', () => {
    // Treat socket errors like a disconnect; the 'close' handler will still
    // run and perform the registry/peer cleanup above.
    try { ws.close(); } catch (_err) { /* already closing */ }
  });
});

server.listen(PORT, HOST, () => {
  const scheme = (TLS_CERT_FILE && TLS_KEY_FILE) ? 'https' : 'http';
  console.log(`Dog monitor signaling server listening on ${HOST}:${PORT} (${scheme})`);
  console.log(`  Phone viewers : ${scheme}://localhost:${PORT}/?secret=${STREAM_SECRET}`);
  console.log(`  iPad camera   : ${scheme}://localhost:${PORT}/camera.html?secret=${STREAM_SECRET}`);
  if (ICE_SERVERS.length > 1) {
    console.log('  TURN relay    : configured (cellular without VPN supported)');
  } else {
    console.log('  TURN relay    : none (use same network or a VPN like Tailscale)');
  }
});
