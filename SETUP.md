# 📡 Setup: watch your dog from anywhere (cellular) with Tailscale

This guide gets you from "it works on my home wifi" to "I can open my phone on
cellular and see my dog." It uses **Tailscale**, a free private VPN, so your
camera is never exposed to the public internet and works over cellular without
any extra relay server.

You'll set up three devices once. After that you just open a link.

> **Don't want to leave a computer running at home?** See
> **[No home computer: host on Render](#no-home-computer-host-on-render)** at the
> bottom. That path puts the tiny signaling server in the cloud, so you only need
> the **iPad** and your **phone** — and it works over cellular too.

---

## What you need

- An **always-on computer** at home to run the server (laptop, mini PC, or a
  Raspberry Pi). It must have **Node.js 18+** installed. This is *not* the iPad.
- The **iPad** that will be the camera.
- Your **phone** (the viewer).
- A free **Tailscale** account: https://tailscale.com

---

## Step 1 — Run the server on the always-on computer

```bash
# in the dogcam folder, once:
npm install

# start it (keep it running):
STREAM_SECRET=ChangeMeToSomethingLong npm start
```

> Change `ChangeMeToSomethingLong` to your own secret and use that same value
> in the links below. It's the password that keeps strangers off your feed.

To keep it running after you close the terminal, use a process manager:

```bash
npm install -g pm2
STREAM_SECRET=ChangeMeToSomethingLong pm2 start server.js --name dogcam
pm2 save && pm2 startup    # makes it restart on reboot
```

---

## Step 2 — Install Tailscale on all three devices

Install and sign into the **same Tailscale account** on each:

1. **The always-on computer** — https://tailscale.com/download
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. **The iPad** — install "Tailscale" from the App Store, sign in.
3. **Your phone** — install "Tailscale" from the App Store / Play Store, sign in.

In the Tailscale admin console (https://login.tailscale.com/admin/machines)
you should now see all three devices.

---

## Step 3 — Give the server an HTTPS address

The iPad's browser will only allow camera access over **HTTPS**. There are two
ways to get HTTPS in front of the server — use **Option A** unless you hit the
iOS WebSocket issue described below, in which case switch to **Option B**.

1. In the admin console, enable **MagicDNS** and **HTTPS Certificates**
   (DNS settings page → "Enable HTTPS").
2. On the always-on computer, find its Tailscale name:
   ```bash
   tailscale status      # shows something like  dogcam-box.tailXXXX.ts.net
   ```

### Option A — `tailscale serve` HTTP forward (simplest)

```bash
tailscale serve --bg 3000
```
Your server is now reachable at `https://dogcam-box.tailXXXX.ts.net`.

> **Known issue:** Tailscale's HTTP forward negotiates HTTP/2 with the
> browser. iOS Safari/WebKit doesn't support WebSocket-over-HTTP/2 (RFC 8441
> Extended CONNECT), so on an iPad the page can load fine (plain HTTP works)
> but the WebSocket never connects — the status dot stays grey/"Disconnected"
> with no console error. Desktop Chrome is unaffected because it falls back
> correctly. **If this happens to you, use Option B instead.**

### Option B — raw TCP forward + TLS in Node (fixes the iOS issue)

This has the server terminate TLS itself, so the connection only ever speaks
plain HTTP/1.1 — no HTTP/2, no Extended CONNECT problem, works on every
browser including iOS Safari.

1. Get a certificate for your Tailscale hostname (run once; renews itself):
   ```bash
   tailscale cert dogcam-box.tailXXXX.ts.net
   ```
   This writes `dogcam-box.tailXXXX.ts.net.crt` and `.key` in the current
   folder. Move them somewhere stable, e.g. `C:\dogcam-certs\` on Windows or
   `~/dogcam-certs/` on Mac/Linux.

2. Reset any previous HTTP forward and switch to a raw TCP forward instead:
   ```bash
   tailscale serve reset
   tailscale serve --bg --tcp 443 tcp://127.0.0.1:3443
   ```

3. Restart the server pointed at the cert, listening on the port you just
   forwarded to (3443):
   ```bash
   # Windows PowerShell
   $env:STREAM_SECRET="YOUR_SECRET"
   $env:PORT="3443"
   $env:TLS_CERT_FILE="C:\dogcam-certs\dogcam-box.tailXXXX.ts.net.crt"
   $env:TLS_KEY_FILE="C:\dogcam-certs\dogcam-box.tailXXXX.ts.net.key"
   npm start
   ```
   ```bash
   # Mac/Linux
   STREAM_SECRET=YOUR_SECRET PORT=3443 \
   TLS_CERT_FILE=~/dogcam-certs/dogcam-box.tailXXXX.ts.net.crt \
   TLS_KEY_FILE=~/dogcam-certs/dogcam-box.tailXXXX.ts.net.key \
   npm start
   ```
   The console will print `(https)` confirming TLS is on.

4. Your server is reachable the same way as before, at
   `https://dogcam-box.tailXXXX.ts.net` — Tailscale just forwards the raw
   bytes through to port 3443 now instead of proxying HTTP itself.

---

## Step 4 — Open the links

Replace the hostname and secret with yours.

- **On the iPad (the camera):**
  ```
  https://dogcam-box.tailXXXX.ts.net/camera.html?secret=ChangeMeToSomethingLong
  ```
  Tap **Start Camera**, allow camera + microphone, prop the iPad up facing your
  dog. Leave Safari open and the screen on (Settings → Display → Auto-Lock →
  Never helps).

- **On your phone (the viewer):**
  ```
  https://dogcam-box.tailXXXX.ts.net/?secret=ChangeMeToSomethingLong
  ```
  You should see your dog. This now works on **cellular too**, as long as
  Tailscale is connected on your phone.

Bookmark the phone link or add it to your home screen.

---

## Everyday use

- Keep the **always-on computer** and the **iPad** running.
- Make sure **Tailscale is on** on your phone (it can stay on in the
  background).
- Open your bookmark. Done.

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| iPad won't allow the camera | You must use the **https://** Tailscale URL, not an IP or `http://`. |
| Phone shows "Connecting…" forever | Check Tailscale is **connected** on the phone, and the iPad page is open and streaming. |
| Black screen but "Live" | The iPad's Safari tab may have been backgrounded — reopen it. |
| Works on wifi, not cellular | Confirm Tailscale is on on the phone. If you ever move off Tailscale, you'd need a TURN server (see below). |
| Server stopped after reboot | Use the `pm2` steps in Step 1 so it auto-starts. |

---

## Optional: cellular without Tailscale (TURN)

If you later want a public link (e.g. to share with a dog-sitter) instead of a
VPN, you'd expose the server through an HTTPS tunnel **and** add a TURN relay,
because cellular networks block direct peer-to-peer video. The server already
supports it — just set these environment variables and restart:

```bash
TURN_URL=turn:your-turn-host:3478 \
TURN_USERNAME=youruser \
TURN_CREDENTIAL=yourpass \
STREAM_SECRET=ChangeMeToSomethingLong npm start
```

Managed TURN providers (Metered, Twilio, etc.) give you those three values.
For a personal "just me" setup you don't need this — Tailscale handles it.

---

## No home computer: host on Render

This is the simplest way to run the cam with **no always-on computer at home**.
The signaling server lives in the cloud on [Render](https://render.com); the
video still flows directly **iPad → phone**, so Render only ever sees the tiny
handshake, never your video. Render gives you free HTTPS automatically, which is
exactly what the iPad needs to allow the camera — no certificates to manage.

You'll need just **two devices**: the **iPad** (camera) and your **phone**
(viewer). It works on **wifi and cellular**.

### Step 1 — Deploy the server to Render

1. Push this repo to your own GitHub account (fork it or push a copy).
2. Go to <https://dashboard.render.com> → **New** → **Blueprint**, and pick your
   `dogcam` repo. Render reads the included `render.yaml` and creates the
   service on the **free** plan.
3. Click **Apply** and wait for the first deploy to finish. Your cam is now at a
   URL like `https://dogcam-xxxx.onrender.com`.

### Step 2 — Get your secret

Render generated a random `STREAM_SECRET` for you. Open the service →
**Environment** tab → copy the `STREAM_SECRET` value. You'll paste it into the
links below as `?secret=...`.

### Step 3 — Turn on cellular support (TURN)

Cellular networks block direct phone-to-phone video, so you need a **TURN
relay**. The free tier of a managed provider is plenty for one dog cam:

1. Sign up at <https://www.metered.ca/tools/openrelay/> (or
   <https://dashboard.metered.ca>) and create a free TURN app. It gives you a
   **username**, a **credential/password**, and a set of URLs.
2. Back in Render → your service → **Environment**, set:
   - `TURN_USERNAME` = the username they gave you
   - `TURN_CREDENTIAL` = the password they gave you
   - `TURN_URL` = a **comma-separated** list covering every transport, e.g.:
     ```
     turn:a.relay.metered.ca:80,turn:a.relay.metered.ca:80?transport=tcp,turn:a.relay.metered.ca:443,turns:a.relay.metered.ca:443?transport=tcp
     ```
     (Use the exact hostnames from your provider. Including the `:443` /
     `?transport=tcp` / `turns:` variants is what makes it work on locked-down
     cellular and public wifi.)
3. **Save** — Render redeploys automatically.

> Only ever watch on your home wifi? You can skip this step entirely; STUN
> (built in) is enough on the same network.

### Step 4 — Open the links

Replace the hostname and secret with yours.

- **iPad (camera):**
  ```
  https://dogcam-xxxx.onrender.com/camera.html?secret=YOUR_SECRET
  ```
  Tap **Start Camera**, allow camera + microphone, prop the iPad facing your
  dog, leave Safari open (Settings → Display → Auto-Lock → Never helps).
- **Phone (viewer):**
  ```
  https://dogcam-xxxx.onrender.com/?secret=YOUR_SECRET
  ```
  Works on wifi and, with Step 3 done, on cellular. Bookmark it / add to home
  screen.

### Good to know about the free plan

- Render's free web service **spins down after ~15 minutes of no traffic** and
  cold-starts (~30–60s) on the next request. While the iPad is connected it
  holds an open WebSocket, which counts as traffic and keeps the service awake —
  so as long as your camera is running, viewers connect instantly. If you ever
  see "Connecting…" right after opening the camera page, give it a minute for
  the first wake-up, or upgrade to Render's cheapest paid plan to keep it always
  on.
- Free TURN tiers have a monthly data cap (Metered's is generous for one cam).
  Note that TURN is only used as a fallback when direct P2P fails — much of the
  time on wifi you won't touch it at all.
