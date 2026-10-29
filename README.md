# Liquid Glass Remote

Control a paired Windows 11 laptop from the existing Android-friendly website, including when the phone and laptop are on different networks.

The frontend stays on Vercel. A separate HTTPS relay authenticates devices and forwards approved commands. The Windows receiver makes an outbound connection, so the laptop needs no public listening port, manually installed phone certificate, inbound firewall rule, or port forwarding. The receiver and phone reconnect their WebSocket heartbeat connections automatically.

## Normal use

1. Install the Windows receiver and leave its sign-in startup option enabled.
2. Open the receiver. It shows a three-digit, two-minute pairing code.
3. Enter the code on the phone website.
4. Approve the phone in the receiver window.
5. Select the saved laptop in future sessions. The receiver starts again when Windows signs in. Authorized phone associations and revocation history live in Supabase Postgres; live WebSocket routing uses Cloudflare Durable Objects.

The laptop must be powered on, signed in, awake, and online. The pairing code only starts a request; the laptop user must approve the phone. Paired phones can be removed in the website or revoked in the receiver window.

## Project parts

- `src/` - React/Vite interface. Existing touchpad, keyboard, media, volume, and built-in app controls are retained.
- `cloudflare/` - Cloudflare Worker and SQLite-backed Durable Object for HTTPS APIs and real-time WebSocket routing.
- `supabase/migrations/` - Postgres schema and restricted server-side functions for durable phone associations and revocation history.
- `relay/` - Local development Express relay and SQLite store.
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

Deploy the relay as a Cloudflare Worker with a SQLite Durable Object and connect it to a Supabase Free Postgres project. Apply the migration, store both secrets in Cloudflare, set `VITE_RELAY_URL` in the existing Vercel project, then build the Windows installer. See the guide for exact steps and free-tier limitations.

## Security notes

- The three-digit code expires after two minutes and is single-use. A laptop user must approve each phone.
- The Worker stores receiver/code credentials as keyed hashes in Durable Object SQLite. Supabase stores keyed phone-token hashes and append-only revocation events. The relay pepper and Supabase service-role key are Cloudflare secrets only.
- Windows receiver identity is protected with the current Windows user's DPAPI. The phone stores its device token encrypted with Web Crypto in IndexedDB.
- Relay and receiver both validate a closed command schema. No shell, PowerShell, arbitrary app launch, screen streaming, microphone, camera, or file transfer is exposed.
- The receiver runs in the signed-in user's session rather than Windows Session 0, so mouse and keyboard actions can reach that user's desktop.
- Sending typed text uses the Windows clipboard and replaces its current contents; the phone app does not save the typed text.
- `server/index.js` remains available as the previous direct-Wi-Fi receiver under `npm run start:legacy`. That legacy mode still requires its previous certificate and firewall setup; the new installer uses the relay receiver instead.

## Current deployment state

The website is already hosted at `https://lapcontroller.vercel.app/`, but this updated relay has not yet been deployed or configured in Vercel. The site needs `VITE_RELAY_URL` set to the deployed `workers.dev` URL and a redeploy. Supabase Free can pause after a week with low activity; the stored associations remain, but API access is interrupted until resumed. Cloudflare free quotas and service interruptions can also interrupt control. Build the Windows installer with the open-source Inno Setup 6 compiler; the installer is unsigned and may show an unknown-publisher warning.
