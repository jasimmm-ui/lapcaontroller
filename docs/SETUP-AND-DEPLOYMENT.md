# Liquid Glass Remote: installation and deployment

This guide covers the relay-based version, including an optional ₹0 Render free-tier setup. The Windows laptop connects outward over HTTPS. The phone and laptop can be on different Wi-Fi networks. You do not install certificates on Android or open an inbound laptop firewall port.

## What you need

- The project in GitHub and access to its Vercel project.
- A Render account for the free web-service option, or another relay host.
- Node.js 22.13 or newer and the open-source Inno Setup 6 compiler on the build computer.
- An Android phone and the Windows 11 laptop you want to pair.

The relay is separate from Vercel. The Render blueprint in this repository selects the **Free** service plan and uses Render-provided HTTPS. This keeps the hosting cost at ₹0 while within free quotas; it does not guarantee availability or durable storage. Do not select a paid plan, add a payment method, or enable a paid resource as part of this setup.

## 1. Deploy the relay on Render Free

1. Push this project to the GitHub repository connected to your Render account (or connect it from the Render dashboard).
2. In Render, choose **New > Blueprint**, select this repository, and review `render.yaml`.
3. Before applying, confirm the service says **Free** and the blueprint contains only the `liquid-glass-remote-relay` web service. Do not choose an upgrade or add a paid disk/database.
4. Create the Blueprint. Render generates `RELAY_PEPPER`; keep the generated value unchanged. Wait for the service to finish deploying.
5. Copy its `https://...onrender.com` address and check that `/healthz` returns `{"ok":true}`.

Render provides HTTPS for its `onrender.com` service address. The receiver and browser use secure WebSockets with two-way heartbeats and reconnect with backoff. A running receiver sends a heartbeat every 20 seconds; it normally keeps the free service awake while the laptop is online.

### Free-tier limits you need to know

- Render Free services sleep after 15 minutes without incoming HTTP requests or WebSocket messages. A sleeping service takes about a minute to start when next contacted. It can restart for platform maintenance at any time.
- The SQLite file for this blueprint lives on Render's **ephemeral filesystem**. Render deletes that file when the service sleeps, restarts, or redeploys. If it is deleted, saved relay registrations and phone pairings are lost; you will need to pair again. The receiver's DPAPI identity and the phone's encrypted browser token remain on those devices, but they will no longer be recognized by the empty relay database.
- Render does not offer a persistent disk on a Free web service. Its Free Postgres expires after 30 days, and its Free Key Value data is in-memory and can be lost on restart. Those are not durable substitutes for this setup.
- Free web services share a 750-hour monthly allowance in a workspace. One service kept awake for a 31-day month can use up to 744 hours; any other free services in the same workspace use part of that allowance. If the allowance runs out, Render suspends free services until the next month.
- Therefore this Render Free configuration costs ₹0 within the quota, but **does not guarantee always-on access or pairing persistence after relay sleep/restart**. It is suitable for a zero-cost trial, not a reliable permanent pairing service.

To retain pairings at ₹0, the relay needs a separate free database with durable storage and a compatible adapter. Upstash Redis currently lists a free tier with fixed request, data, and bandwidth quotas; it is not wired into this relay yet. If you use it later, stay on its Free plan and do not add a payment method: Upstash says adding a payment method switches all free resources on that account to Pay-as-You-Go. The zero-cost alternative that works today is self-hosting the relay and SQLite on a computer or server with durable storage that you already own, but it is available only while that host and internet connection are running.

## 2. Configure the Vercel website

In Vercel, open the existing Liquid Glass Remote project and set this environment variable for Production:

```text
VITE_RELAY_URL=https://your-render-service.onrender.com
```

Use the Render origin only, with no trailing slash. Then redeploy Vercel. The relay allows `https://lapcontroller.vercel.app` through `FRONTEND_ORIGINS` in `render.yaml`.

The website link is `https://lapcontroller.vercel.app/`. It will not connect to a relay until this environment value is deployed.

## Alternative: self-host with Docker and durable storage

The included Docker Compose setup listens on `127.0.0.1:8788` on the relay host and stores its SQLite database in the persistent Docker volume `relay-data`. This is durable only if the host's disk and Docker volume are durable and the host remains available. Put a trusted HTTPS reverse proxy in front and route the relay domain to that local port. Keep the direct container port private; only the HTTPS proxy should be publicly reachable. This path may have hosting or domain costs; check before provisioning anything.

On a clean checkout, create the local environment file:

```powershell
Copy-Item .env.example .env
```

Do not overwrite an existing `.env`; add the new relay entries to it instead. Generate the relay pepper on the relay host or in a trusted password manager. In PowerShell, this command prints a random value:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Set these values in the relay deployment environment (or the relay host's private `.env` file):

| Variable | Value |
|---|---|
| `RELAY_PEPPER` | The generated random value. Keep it secret and unchanged between deploys. |
| `FRONTEND_ORIGINS` | `https://lapcontroller.vercel.app` (no trailing slash). Add a local development origin only if needed. |
| `TRUST_PROXY_HOPS` | `1` only when one trusted HTTPS proxy is in front of the relay. Use the correct count for your host. |
| `RELAY_DB_PATH` | `/data/relay.sqlite` in the container. |

`relay/compose.yaml` supplies the other container settings. From the repository root, start it with:

```powershell
docker compose -f relay/compose.yaml up -d --build
docker compose -f relay/compose.yaml logs -f relay
```

Configure the proxy to present HTTPS for your relay domain and route requests to `http://127.0.0.1:8788`. Check `https://your-relay-domain/healthz` returns `{"ok":true}`. Do not place the pepper in Vercel or in the frontend.

The Docker volume must survive container recreation. Back up the SQLite file and preserve the same pepper. If the database or pepper is lost, existing phone/laptop pairings cannot authenticate.

## 3. Build the Windows installer

On the build computer, install Node.js 22.13 or newer. Set `RELAY_URL` to the deployed HTTPS relay address and run:

```powershell
$env:RELAY_URL = 'https://your-relay-domain'
npm install
npm run build:windows-installer
```

The installer is written to:

```text
dist\installer\LiquidGlassRemoteSetup.exe
```

The staging files are under `dist\windows\`. To prepare and inspect the stage without Inno Setup:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -StageOnly -RelayUrl 'https://your-relay-domain'
```

The installer includes the Node runtime, so the laptop user does not need to install Node.js. It installs per-user, starts the receiver at sign-in, and does not need administrator access. It is unsigned; Windows may show an unknown-publisher warning.

Publish the finished installer as a GitHub Release asset after checking it. Do not distribute staging files or a build configured with a placeholder relay URL.

## 4. Install and pair a laptop

1. Download and run `LiquidGlassRemoteSetup.exe` on the laptop. Choose the sign-in startup option.
2. Let the receiver open. Keep its console window available; it shows online/offline status and a three-digit code that expires after two minutes.
3. On the Android phone, open `https://lapcontroller.vercel.app/` in Chrome.
4. Enter the three-digit code. The code only identifies the request; it does not authorize control by itself.
5. In the receiver window on the laptop, confirm the phone name and type `approve`. Type `reject` if you did not initiate the request.
6. After approval, the laptop appears in the phone's saved device list. Select it when it is online.

The phone stores the paired credential encrypted in its browser profile. The laptop identity is protected by Windows DPAPI under the signed-in Windows account and survives normal receiver updates and Windows restarts. Pairing also requires the relay database to remain durable: Render Free may erase its ephemeral database after sleep or restart, in which case you must pair again. Clearing browser site data, using a different phone/browser profile, losing the Windows user profile, or choosing to delete the saved identity during uninstall can also require pairing again.

The receiver runs as the signed-in user so Windows can accept mouse, keyboard, and media actions. It is not installed as a Session 0 service. The laptop must be powered on, signed in, awake, and connected to the internet. It will not turn on a shut-down computer.

## 5. Use, reconnect, and revoke

- On a later visit, open the website and select the saved laptop. With durable relay storage, no pairing code is required again after a normal Windows restart. On Render Free, relay sleep or restart can erase pairings.
- If the laptop is offline, open its receiver or check that Windows is signed in, awake, and online. The receiver retries with increasing delays, capped at 30 seconds.
- To pair another phone, type `pair` in the receiver window to get a fresh code. Approve each new phone at the laptop.
- In the receiver window, type `phones` to list paired phone names and IDs. Revoke one with `revoke <phone-id>`.
- On a phone you still have, choose **Remove** beside the saved laptop to revoke that phone's credential and remove the local entry.
- To stop the receiver, type `quit` or close its console. It starts again at the next Windows sign-in if the startup option is enabled.
- Uninstall from Windows Settings > Apps. The uninstaller asks whether to remove the saved laptop identity and app data. Removing it means this laptop will register as a new device if installed again.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `RELAY_URL` | Receiver | HTTPS relay origin. Localhost HTTP is allowed for development only. |
| `MOCK_MODE` | Receiver | `true` disables real Windows input; `false` enables it after pairing approval. Development defaults to mock. |
| `PORT` | Relay | Internal HTTP port behind the TLS proxy; default `8788`. |
| `RELAY_HOST` | Relay | Bind address; Docker uses `0.0.0.0` inside the container. |
| `RELAY_DB_PATH` | Relay | SQLite file path. On Render Free it is ephemeral and can be erased; on Docker use `/data/relay.sqlite` on a persistent volume. |
| `RELAY_PEPPER` | Relay | Stable secret used to HMAC credentials, code, and rate-limit keys. Minimum 32 bytes. |
| `FRONTEND_ORIGINS` | Relay | Exact allowed browser origins, comma-separated. Never use `*`. |
| `TRUST_PROXY_HOPS` | Relay | Number of trusted proxies, used to determine client IP for rate limiting. |
| `VITE_RELAY_URL` | Vercel build | Public HTTPS relay origin embedded in the frontend. It is not a secret. |

The relay uses one SQLite writer and should run as one instance. It stores keyed hashes rather than raw phone/receiver credentials. Commands pass through relay memory and are removed after completion or timeout. Render Free local files are ephemeral, so pairing data can disappear as described above.

## Local development and checks

Start a local relay and Vite frontend with the `.env.example` development values:

```powershell
npm install
npm run dev:all
```

Then start the receiver in another terminal:

```powershell
npm run dev:receiver
```

The example uses mock mode. To run checks:

```powershell
npm test
npm run build
```

Automated checks do not prove the public relay host is correctly configured, that Android Chrome can connect over a real mobile network, that the Vercel environment was redeployed, that the installer is signed, or that an actual Windows restart was completed. Those checks require the deployed relay, Android phone, and installed receiver.

## Troubleshooting

- **Pairing code rejected:** type `pair` in the laptop receiver window and use the new code promptly. Codes are one-use and expire after two minutes. Too many guesses are blocked for one minute.
- **Phone request stays waiting:** make sure the receiver window is open and the laptop is online, then check that the laptop owner approved the pending request.
- **Laptop offline after reboot:** sign in to the same Windows user account and check that the installer startup option was enabled. Receiver actions need the interactive user session.
- **Relay does not start:** check `RELAY_PEPPER` length and stability, database volume write access, and that only one relay instance is using the SQLite file.
- **Website says relay is not set up:** set `VITE_RELAY_URL` in Vercel and redeploy.
- **Browser says network error:** confirm relay HTTPS certificate validity, `FRONTEND_ORIGINS`, proxy routing to port 8788, and proxy request timeout. The laptop itself does not need a public inbound port.
- **Phone says access revoked:** remove the stale device entry and pair again only if the laptop owner intends to grant access.

## Legacy direct-Wi-Fi receiver

The previous receiver remains available as `npm run start:legacy`. It listens directly on the laptop and still needs the old LAN certificate, Android CA trust, same Wi-Fi, and Windows firewall configuration. The new installer does not use this legacy path.
