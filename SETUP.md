# 📡 Setup: watch your dog from anywhere (cellular) with Tailscale

This guide gets you from "it works on my home wifi" to "I can open my phone on
cellular and see my dog." It uses **Tailscale**, a free private VPN, so your
camera is never exposed to the public internet and works over cellular without
any extra relay server.

You'll set up three devices once. After that you just open a link.

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
