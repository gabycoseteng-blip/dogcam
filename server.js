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
const GtfsRt = require('gtfs-realtime-bindings');

// Web Push is optional: if the `web-push` module isn't installed the server
// still runs, just without server-sent push notifications. Wrapping the require
// keeps zero-config local use working even before `npm install`.
let webpush = null;
try { webpush = require('web-push'); } catch (_e) { webpush = null; }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// The shared secret. Pulled from the environment when available so the token
// can be rotated without code changes, but falls back to a hardcoded constant
// for zero-config local use, exactly as specified by the requirements.
const STREAM_SECRET = process.env.STREAM_SECRET || 'CleoCam';

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

// Optional: Cloudflare Realtime TURN. Unlike a static-credential provider
// (Metered, Twilio), Cloudflare hands out SHORT-LIVED credentials minted on
// demand through its API, so instead of a fixed username/password we store the
// Turn Token ID + API token and generate fresh credentials per /ice-config
// request. Cloudflare's free allowance (1,000 GB/month, shared with their SFU)
// dwarfs typical free TURN caps, which makes it a good fit for lots of cellular
// dog-watching. Leave these unset to keep using static TURN_URL/USERNAME/etc.
const CF_TURN_TOKEN_ID = process.env.CF_TURN_TOKEN_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
// How long each minted credential stays valid. A day is plenty: the page only
// needs it for the lifetime of a viewing session and refetches on next launch.
const CF_TURN_TTL = Number(process.env.CF_TURN_TTL || 86400);

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

// Whether Cloudflare TURN is configured. When it is, /ice-config mints fresh
// credentials on each request and appends Cloudflare's relay to the static list.
const CF_TURN_ENABLED = Boolean(CF_TURN_TOKEN_ID && CF_TURN_API_TOKEN);

/**
 * Ask Cloudflare to mint a short-lived TURN credential and return an iceServers
 * entry ({ urls, username, credential }) ready to hand to the browser. Returns
 * null on any failure so the caller can fall back to the static ICE list rather
 * than breaking the page. Requires Node 18+ (built-in global fetch).
 */
async function getCloudflareIceServers() {
  if (!CF_TURN_ENABLED) return null;
  const endpoint =
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_TOKEN_ID}/credentials/generate`;
  // Bound the request so a slow/unreachable Cloudflare never hangs /ice-config.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: CF_TURN_TTL }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error(`Cloudflare TURN: credential request failed (HTTP ${resp.status})`);
      return null;
    }
    const data = await resp.json();
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }.
    if (!data || !data.iceServers || !data.iceServers.urls) {
      console.error('Cloudflare TURN: unexpected response shape');
      return null;
    }
    return data.iceServers;
  } catch (err) {
    console.error(`Cloudflare TURN: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Web Push notifications (camera on/off + bark alerts)
// ---------------------------------------------------------------------------
// Phones can subscribe to be notified — even when the viewer app is closed —
// when the camera switches on/off or the iPad hears barking. This needs a
// VAPID key pair. Supply VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY to keep the same
// keys across restarts (so existing subscriptions survive); otherwise we
// generate an ephemeral pair at boot and clients simply re-subscribe next time
// they open the app. Push is fully optional and silently inert if `web-push`
// isn't installed.
let vapidPublicKey = null;
if (webpush) {
  let pub = process.env.VAPID_PUBLIC_KEY;
  let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    console.warn('[push] No VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set — generated ' +
      'ephemeral keys. Push works, but subscriptions reset whenever the server ' +
      'restarts. Set both env vars to make them durable.');
  }
  vapidPublicKey = pub;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:dogcam@example.invalid', pub, priv);
}

// Live push subscriptions, keyed by endpoint so re-subscribing is idempotent.
// In-memory only: clients re-subscribe each time they open the app, so a
// restart self-heals on the next viewer launch.
const pushSubs = new Map();

// Fan a notification out to every subscribed phone. Stale subscriptions (the
// browser unsubscribed, or the push service 404/410s the endpoint) are pruned.
function sendPush(payload) {
  if (!webpush || !vapidPublicKey || pushSubs.size === 0) return;
  const data = JSON.stringify(payload);
  for (const [endpoint, sub] of pushSubs) {
    webpush.sendNotification(sub, data).catch((err) => {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) pushSubs.delete(endpoint);
    });
  }
}

// ---------------------------------------------------------------------------
// MTA real-time train arrivals (Carroll St — F & G)
// ---------------------------------------------------------------------------
// The iPad dashboard shows live "T-minus X min" countdowns for the next trains
// at the Carroll St station. The MTA publishes GTFS-realtime protobuf feeds
// (no API key required since 2021). We fetch them HERE, server-side, and expose
// a small JSON summary at /trains so the browser never has to decode protobuf
// or learn the feed URLs. Results are cached briefly to be a good MTA citizen.
//
// Carroll St is stop "F21" (F21N = Manhattan/Queens-bound, F21S = Brooklyn-bound)
// and is served by both the F (on the BDFM feed) and the G (on its own feed).
// All three are overridable via env vars so the same code can power another
// station without edits.
const TRAIN_FEEDS = (process.env.TRAIN_FEEDS ||
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm,' +
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g'
).split(',').map((s) => s.trim()).filter(Boolean);

const TRAIN_STOP_PREFIX = process.env.TRAIN_STOP_ID || 'F21';
const TRAIN_ROUTES = new Set(
  (process.env.TRAIN_ROUTES || 'F,G').split(',').map((s) => s.trim()).filter(Boolean),
);
const TRAIN_CACHE_MS = 20000;            // serve cached arrivals for ~20s
const TRAIN_FETCH_TIMEOUT_MS = 8000;     // give up on a slow feed

let trainCache = { at: 0, data: null };

// Fetch one GTFS-realtime feed and decode it into a FeedMessage. Bounded by an
// AbortController so a hung MTA endpoint can't stall the /trains request.
async function fetchFeed(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAIN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'dogcam/1.0 (+train-arrivals)' },
    });
    if (!res.ok) throw new Error(`feed responded ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return GtfsRt.transit_realtime.FeedMessage.decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

// protobufjs surfaces int64 fields (like arrival.time) as Long objects. Coerce
// them — and plain numbers — to a JS number of epoch seconds.
function toSeconds(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t;
  if (typeof t.toNumber === 'function') return t.toNumber();
  return Number(t);
}

// Pull every upcoming F/G arrival at the Carroll St platforms out of the feeds
// and return them as a sorted, JSON-friendly list. Each entry is one train:
//   { route: 'F'|'G', direction: 'N'|'S', minutes, time(ISO) }
async function getTrainArrivals() {
  const now = Date.now();
  if (trainCache.data && now - trainCache.at < TRAIN_CACHE_MS) {
    return trainCache.data;
  }

  const results = await Promise.allSettled(TRAIN_FEEDS.map(fetchFeed));
  if (!results.some((r) => r.status === 'fulfilled')) {
    throw new Error('all train feeds failed');
  }

  const arrivals = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const entity of r.value.entity || []) {
      const tu = entity.tripUpdate;
      if (!tu || !tu.trip) continue;
      const route = tu.trip.routeId;
      if (!TRAIN_ROUTES.has(route)) continue;

      for (const stu of tu.stopTimeUpdate || []) {
        const stopId = stu.stopId || '';
        if (!stopId.startsWith(TRAIN_STOP_PREFIX)) continue;
        const direction = stopId.slice(-1); // 'N' (uptown) or 'S' (downtown)
        if (direction !== 'N' && direction !== 'S') continue;

        const sec = toSeconds((stu.arrival && stu.arrival.time) ||
                              (stu.departure && stu.departure.time));
        if (!sec) continue;

        const minutes = (sec * 1000 - now) / 60000;
        if (minutes < -1) continue; // already departed
        arrivals.push({
          route,
          direction,
          minutes: Math.max(0, Math.round(minutes)),
          time: new Date(sec * 1000).toISOString(),
        });
      }
    }
  }

  arrivals.sort((a, b) => a.minutes - b.minutes);
  const data = { updatedAt: new Date(now).toISOString(), stop: TRAIN_STOP_PREFIX, arrivals };
  trainCache = { at: now, data };
  return data;
}

// ---------------------------------------------------------------------------
// Express — static asset serving
// ---------------------------------------------------------------------------

const app = express();

// Build marker so it's obvious at a glance whether the deployed/running code is
// the latest. Render exposes the deployed commit as RENDER_GIT_COMMIT; we fall
// back to an APP_VERSION override or 'dev' for local runs. `started` records
// when this process booted, which doubles as a "last redeploy/restart" signal.
const BUILD_VERSION =
  (process.env.RENDER_GIT_COMMIT && process.env.RENDER_GIT_COMMIT.slice(0, 7)) ||
  process.env.APP_VERSION || 'dev';
const BUILD_STARTED = new Date().toISOString();

// Parse small JSON bodies (used by the push-subscription endpoints below).
app.use(express.json({ limit: '16kb' }));

// Dynamic web app manifest. iOS gives an installed home-screen PWA its OWN
// storage, separate from Safari, so a secret saved to localStorage in Safari
// does NOT survive "Add to Home Screen". To make the installed app launch
// authenticated, we bake the secret into start_url here: the page requests
// /manifest.webmanifest?secret=... and we echo that secret into start_url so
// the home-screen icon always opens "/?secret=...". Defined BEFORE the static
// middleware so it wins over any file on disk.
function sendManifest(req, res) {
  const secret = typeof req.query.secret === 'string' ? req.query.secret : '';
  const start = secret ? '/?secret=' + encodeURIComponent(secret) : '/';
  res.type('application/manifest+json').json({
    name: 'Dog Cam',
    short_name: 'Dog Cam',
    description: 'Live dog monitoring camera viewer',
    start_url: start,
    scope: '/',
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'any',
    icons: [
      {
        src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='32' fill='%23000'/%3E%3Ctext x='96' y='130' font-size='110' text-anchor='middle'%3E%F0%9F%90%B6%3C/text%3E%3C/svg%3E",
        sizes: '192x192',
        type: 'image/svg+xml',
      },
    ],
  });
}
app.get('/manifest.webmanifest', sendManifest);
app.get('/manifest.json', sendManifest);

// Everything in /public is served statically. index.html (the phone viewer)
// is served automatically at "/" while camera.html is reached at "/camera.html".
app.use(express.static(path.join(__dirname, 'public')));

// A tiny health endpoint that is handy for uptime checks / load balancers.
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, clients: clients.size, version: BUILD_VERSION, started: BUILD_STARTED }));

// Public build marker the clients poll to display which build is live. No
// secret required — it's just a commit id + boot time, nothing sensitive.
app.get('/version', (_req, res) =>
  res.json({ version: BUILD_VERSION, started: BUILD_STARTED }));


// The clients fetch their ICE/TURN configuration from here at startup so the
// STUN/TURN setup lives in one place (the server env) instead of being
// hardcoded in each HTML file. Requires the same shared secret so TURN
// credentials are never handed to an unauthenticated caller.
app.get('/ice-config', async (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Start from the static list (Google STUN + any static TURN_URL provider).
  const iceServers = [...ICE_SERVERS];
  // If Cloudflare TURN is configured, mint a fresh short-lived credential and
  // append it. On any failure we silently fall back to the static list so the
  // page still loads (it just won't have the Cloudflare relay this time).
  if (CF_TURN_ENABLED) {
    const cf = await getCloudflareIceServers();
    if (cf) iceServers.push(cf);
  }
  res.json({ iceServers });
});

// --- Web Push subscription management (all require the shared secret) -------
// The client fetches the VAPID public key, subscribes through the browser, then
// POSTs the resulting subscription here so the server can push to it later.
app.get('/push/key', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ enabled: !!vapidPublicKey, key: vapidPublicKey });
});

app.post('/push/subscribe', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sub = req.body;
  if (!sub || typeof sub.endpoint !== 'string') {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  pushSubs.set(sub.endpoint, sub);
  res.json({ ok: true });
});

app.post('/push/unsubscribe', (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) pushSubs.delete(endpoint);
  res.json({ ok: true });
});

// Live train arrivals for the iPad dashboard / phone viewers. Same shared
// secret as everything else so the endpoint isn't an open proxy. On total feed
// failure we return 502 and let the client keep showing its last good data.
app.get('/trains', async (req, res) => {
  if (!isValidSecret(req.query.secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    res.json(await getTrainArrivals());
  } catch (_err) {
    res.status(502).json({ error: 'train_feed_unavailable' });
  }
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

// The set of client ids that currently report a live camera (via `cam-state`).
// Used to detect on/off transitions for push notifications and to fire an
// "offline" push if a live camera's socket dies. Normally holds zero or one id.
const liveCameras = new Set();

// Push helper for the camera on/off transitions, so the message text lives in
// one place. `on` true => the camera just came online; false => it went off.
function notifyCameraState(on) {
  sendPush({
    title: '🐶 Dog Cam',
    body: on ? 'Camera is now ON' : 'Camera turned OFF',
    tag: 'cam-state',
    url: '/',
  });
}

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

  // Liveness flag for the ping/pong heartbeat below: a pong (or any pong-like
  // activity) marks the socket alive; the sweep terminates anything that didn't
  // answer the previous ping, catching half-dead sockets TCP hasn't noticed.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

      // The iPad announces it is online / has (re)started streaming. We tag the
      // sender as the camera AND relay the announcement to every other peer so
      // viewers can (re)send `viewer-joined` and get a fresh offer. This is what
      // lets phones recover automatically after the camera is stopped and
      // started again (manually or by the schedule) without a page reload.
      case 'camera-ready': {
        const me = clients.get(id);
        if (me) me.role = 'camera';
        for (const [otherId, other] of clients) {
          if (otherId === id) continue;
          if (other.ws.readyState === other.ws.OPEN) {
            other.ws.send(JSON.stringify({ type: 'camera-ready', from: id }));
          }
        }
        break;
      }

      // The iPad reports its camera turning on/off (decoupled from the WebRTC
      // `camera-ready` reattach signal). We track live cameras to push an
      // on/off notification on the first-on / last-off transition, and relay
      // the state to viewers so an open app updates instantly.
      case 'cam-state': {
        const me = clients.get(id);
        if (me) me.role = 'camera';
        const on = !!msg.on;
        const wasEmpty = liveCameras.size === 0;
        if (on) liveCameras.add(id); else liveCameras.delete(id);

        for (const [otherId, other] of clients) {
          if (otherId === id) continue;
          if (other.ws.readyState === other.ws.OPEN) {
            other.ws.send(JSON.stringify({ type: 'cam-state', on, from: id }));
          }
        }

        if (on && wasEmpty) notifyCameraState(true);
        else if (!on && !wasEmpty && liveCameras.size === 0) notifyCameraState(false);
        break;
      }

      // The iPad detected something worth flagging (e.g. barking). Relay it to
      // viewers for an in-app alert and push it to subscribed phones.
      case 'alert': {
        const kind = typeof msg.kind === 'string' ? msg.kind : 'alert';
        for (const [otherId, other] of clients) {
          if (otherId === id) continue;
          if (other.ws.readyState === other.ws.OPEN) {
            other.ws.send(JSON.stringify({ type: 'alert', kind, from: id }));
          }
        }
        if (kind === 'bark') {
          sendPush({ title: '🐶 Dog Cam', body: 'Barking detected', tag: 'bark', url: '/' });
        }
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
    // If a live camera's socket died, treat it as the camera going offline:
    // tell viewers and, if it was the last one, push an "offline" alert.
    if (liveCameras.delete(id) && liveCameras.size === 0) {
      notifyCameraState(false);
    }
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

// --- Heartbeat -------------------------------------------------------------
// Ping every socket on an interval and terminate any that didn't pong since the
// last sweep. This reclaims dead connections (e.g. an iPad that dropped off
// wifi without a clean close) so their `close` handler runs — freeing the slot
// and notifying viewers that the camera went offline.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_e) {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_e) {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  const scheme = (TLS_CERT_FILE && TLS_KEY_FILE) ? 'https' : 'http';
  console.log(`Dog monitor signaling server listening on ${HOST}:${PORT} (${scheme})`);
  console.log(`  Build         : ${BUILD_VERSION} (started ${BUILD_STARTED})`);
  console.log(`  Phone viewers : ${scheme}://localhost:${PORT}/?secret=${STREAM_SECRET}`);
  console.log(`  iPad camera   : ${scheme}://localhost:${PORT}/camera.html?secret=${STREAM_SECRET}`);
  if (CF_TURN_ENABLED) {
    console.log('  TURN relay    : Cloudflare (short-lived creds, cellular supported)');
  } else if (ICE_SERVERS.length > 1) {
    console.log('  TURN relay    : configured (cellular without VPN supported)');
  } else {
    console.log('  TURN relay    : none (use same network or a VPN like Tailscale)');
  }
});
