# Liquid Glass Remote

Control a paired Windows 11 laptop from the existing Android-friendly website, including when the phone and laptop are on different networks.

The frontend stays on Vercel. A separate HTTPS relay authenticates devices and forwards approved commands. The Windows receiver makes an outbound connection, so the laptop needs no public listening port, manually installed phone certificate, inbound firewall rule, or port forwarding. The receiver and phone reconnect their WebSocket heartbeat connections automatically.

## Normal use

1. Install the Windows receiver and leave its sign-in startup option enabled.
2. Open the receiver. It shows a three-digit, two-minute pairing code.
3. Enter the code on the phone website.
4. Approve the phone in the receiver window.
5. With relay data retained, select the saved laptop in future sessions. The receiver starts again when the Windows user signs in and reconnects without pairing again. Render Free can erase relay data after sleep or a restart, which forces pairing again.

The laptop must be powered on, signed in, awake, and online. The pairing code only starts a request; the laptop user must approve the phone. Paired phones can be removed in the website or revoked in the receiver window.

## Project parts

- `src/` - React/Vite interface. Existing touchpad, keyboard, media, volume, and built-in app controls are retained.
- `relay/` - HTTPS Express relay, SQLite storage, WebSocket heartbeat endpoints, code exchange, presence, and bounded command forwarding.
- `receiver/` - Outbound relay client, Windows DPAPI identity storage, console approval/status, WebSocket heartbeat, and crash-restarting launcher.
- `server/windows.js` and `server/validation.js` - Same-user-session Windows input worker and the shared strict action allowlist.
- `installer/` and `scripts/package-windows.ps1` - Per-user Inno Setup installer staging and build configuration.
- [Beginner installation and deployment guide](docs/SETUP-AND-DEPLOYMENT.md).

## Local development

Requires Node.js 22.13 or newer. On a fresh checkout, copy `.env.example` to `.env`. If `.env` already exists, add the new settings to it without overwriting existing machine-specific values. Set a private `RELAY_PEPPER` with at least 32 random bytes, keep `MOCK_MODE=true`, and use `RELAY_URL=http://127.0.0.1:8788` for local development.

```powershell
npm install
npm run dev:all
```

In a second PowerShell window in the project folder:

```powershell
npm run dev:receiver
```

The receiver prints a code and waits for explicit approval. In development it stays in preview mode and does not send real Windows input. The relay creates its local database under `relay/data/`.

## Build and test

```powershell
npm test
npm run build
```

The automated tests cover code expiry and reuse, attempt limits, explicit approval, command allowlisting, receiver and phone authentication, reconnect behavior, relay database persistence, phone revocation, receiver credential protection, and website-origin checks.

## Production setup

Deploy the relay as a single always-on Node container with a persistent disk mounted at `/data`, terminate public HTTPS at a trusted host/reverse proxy, set the Vercel `VITE_RELAY_URL`, then build the Windows installer with that relay URL. See the deployment guide for exact environment variables and commands.

The repository includes `render.yaml` for a Render **Free** web service with platform HTTPS. This is ₹0 within Render's quotas, but its SQLite path is ephemeral: Render can erase the database when the free service sleeps, restarts, or redeploys. Existing phone pairings then need to be created again. Render Free can also cold-start in about a minute, restart during maintenance, and suspend free services when the workspace's 750 monthly free instance-hours are exhausted. The heartbeat is intended to keep the service awake while the receiver is connected; it cannot guarantee uptime when the laptop or network is offline. Render Free therefore does not meet the durable, always-available pairing requirement by itself. The exact free-tier limits and the durable-storage alternatives are documented in [the setup guide](docs/SETUP-AND-DEPLOYMENT.md).

## Security notes

- The three-digit code expires after two minutes and is single-use. A laptop user must approve each phone.
- Relay-side receiver, phone, and code credentials are stored as keyed hashes. The relay pepper must stay secret and stable across deploys.
- Windows receiver identity is protected with the current Windows user's DPAPI. The phone stores its device token encrypted with Web Crypto in IndexedDB.
- Relay and receiver both validate a closed command schema. No shell, PowerShell, arbitrary app launch, screen streaming, microphone, camera, or file transfer is exposed.
- The receiver runs in the signed-in user's session rather than Windows Session 0, so mouse and keyboard actions can reach that user's desktop.
- Sending typed text uses the Windows clipboard and replaces its current contents; the phone app does not save the typed text.
- `server/index.js` remains available as the previous direct-Wi-Fi receiver under `npm run start:legacy`. That legacy mode still requires its previous certificate and firewall setup; the new installer uses the relay receiver instead.

## Current deployment state

The code in this workspace has not yet been deployed to Render or Vercel. The website needs `VITE_RELAY_URL` set in Vercel and a redeploy before it can connect. Build the Windows installer with the open-source Inno Setup 6 compiler; the installer is unsigned and may show an unknown-publisher warning.
