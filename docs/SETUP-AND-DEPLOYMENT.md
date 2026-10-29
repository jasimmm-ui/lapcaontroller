# Liquid Glass Remote: Cloudflare + Supabase setup

This guide deploys the relay for ₹0 using Cloudflare Workers Free and Supabase Free, within their quotas. The React website remains on Vercel. The Windows receiver remains a separate app. No Render, paid database, paid relay, custom domain, or billing upgrade is required.

## What is durable and what can pause

- Supabase Postgres holds approved phone associations and an append-only revocation history. Only the Cloudflare Worker uses its service-role key. The browser and receiver never receive that key.
- Cloudflare Durable Object SQLite holds receiver registrations, short-lived pairing codes/requests, and rate limits. It survives Worker restarts and deploys. WebSockets carry live receiver/phone traffic and hibernate when idle.
- Cloudflare provides HTTPS/WSS on the free `workers.dev` address. The phone and receiver reconnect after interruptions; that does not guarantee uninterrupted availability.
- Supabase Free has 500 MB database storage and 5 GB egress; a project with too little activity over a week can be paused. Data remains, but the relay cannot validate phone credentials until you resume the project in Supabase. Do not upgrade to prevent pausing.
- Cloudflare Workers Free allows 100,000 Worker requests/day. SQLite Durable Objects have free daily request/compute/storage quotas. If quotas are exceeded, requests may fail until reset. Do not enable paid billing or a paid plan.
- Free plans do not provide a production uptime guarantee, automatic Supabase database backups, or always-on database availability. For sensitive or irreplaceable associations, export a backup from Supabase periodically. If you need guaranteed availability/backups, that cannot be promised at ₹0 with these plans.

## 1. Create the Supabase Free project

1. Sign in at [Supabase](https://supabase.com/dashboard/) with your GitHub account.
2. Create a new organization only if Supabase asks for one. Select the Free plan.
3. Create a project. Pick a region near you, a project name, and a strong database password. Keep the password in a password manager; it is not used by the phone or receiver.
4. Confirm the project is on **Free** and do not add a paid compute add-on, custom domain, or billing upgrade.
5. Open **SQL Editor > New query**. Open `supabase/migrations/20261028000000_device_associations.sql` in this repository, copy all of its contents into the SQL Editor, and run it.
6. Open **Project Settings > API** (or **API Keys**). Copy the Project URL and the `service_role` secret key. Treat the service-role key like a password. Never put it in Vercel, source files, chat, or the Windows receiver. It will be entered directly into a Cloudflare secret in Step 3.

The migration enables row-level security, denies browser roles access to both tables, and permits the private Worker key to call only the two association functions. Phone tokens are stored as keyed hashes; revocation events remain recorded after the phone is removed and later paired again.

## 2. Sign in to Cloudflare and configure the Worker

From PowerShell in the repository folder:

```powershell
npm install
npx wrangler login
```

A browser tab opens for Cloudflare authorization. Complete that sign-in yourself if asked. The CLI is the open-source Wrangler tool. Keep the Cloudflare account on the **Workers Free** plan; do not add a paid subscription or turn on billing.

Generate a random relay pepper locally (it is a secret; do not send it to anyone):

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Store the pepper as a Cloudflare Worker secret:

```powershell
npx wrangler secret put RELAY_PEPPER --config cloudflare/wrangler.jsonc
```

Paste the generated value into the CLI prompt. Then add the Supabase URL and service-role key as Worker secrets. Replace the URL with the Project URL from Step 1:

```powershell
npx wrangler secret put SUPABASE_URL --config cloudflare/wrangler.jsonc
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config cloudflare/wrangler.jsonc
```

Paste each value only into its corresponding prompt. Wrangler encrypts secrets for the Worker. These values are not part of `wrangler.jsonc` or Vercel's environment.

Deploy the Worker and its Durable Object migration:

```powershell
npm run cf:deploy
```

The first deploy prints an HTTPS URL like `https://liquid-glass-remote-relay.<your-account>.workers.dev`. Save that exact origin. Confirm `https://...workers.dev/healthz` shows `{"ok":true,"configured":true}`. This checks that the Worker bindings and secrets exist; it does not test Supabase database availability or detect a paused Supabase project. If you see a billing, Workers Paid, or paid resource prompt, stop and do not accept it.

For local development, copy `cloudflare/.dev.vars.example` to `cloudflare/.dev.vars`, fill it with test secrets, and run `npm run cf:dev`. Do not commit `.dev.vars`.

## 3. Point Vercel at the relay

1. In the Vercel project for `lapcontroller.vercel.app`, open **Settings > Environment Variables**.
2. Add `VITE_RELAY_URL` with the exact `https://...workers.dev` origin from Step 2. Do not add a trailing slash or any secret.
3. Apply it to Production and redeploy the project.
4. Open [https://lapcontroller.vercel.app/](https://lapcontroller.vercel.app/) and check that the site loads without a relay configuration error.

The Worker allows that exact site origin by default. If you use another frontend URL, update `FRONTEND_ORIGINS` in `cloudflare/wrangler.jsonc` before deploying.

## 4. Build the Windows installer

On the build computer, install Node.js 22.13 or newer and the free/open-source Inno Setup 6 compiler. In PowerShell, set the public relay origin and build:

```powershell
$env:RELAY_URL = 'https://liquid-glass-remote-relay.<your-account>.workers.dev'
npm run build:windows-installer
```

The installer is created at `dist\installer\LiquidGlassRemoteSetup.exe`. It contains the receiver and Node runtime, but no Supabase key or Cloudflare secret. It is unsigned, so Windows may show an unknown-publisher prompt. Check the relay URL in the installer build command before sharing the file.

## 5. Install and pair each Windows laptop

1. Run the installer on the Windows laptop and choose the sign-in startup option.
2. Open the receiver. It connects outward using HTTPS/WSS, creates its own secure identity, and displays a temporary three-digit code. No inbound firewall rule, certificate installation, or router port-forward is needed.
3. On the phone, open `https://lapcontroller.vercel.app/` and enter that code before it expires (two minutes, one use).
4. Read the phone name shown in the receiver window. Type `approve` only if you initiated that pairing; otherwise type `reject`.
5. After approval, the phone is saved in its browser. Reopen the site and select it next time; pairing survives Windows/receiver/Worker restarts.

The laptop must be powered on, awake, signed in to the same Windows user, and online. The receiver retries automatically after interruptions. A sleeping or shut-down laptop cannot be controlled.

## 6. Remove a phone or revoke access

On the phone website, use **Remove** for that laptop, or in the Windows receiver window type `phones`, then `revoke <phone-id>`. Either route revokes the credential in Supabase and appends a permanent revocation record. If a phone is lost, revoke it from the laptop receiver. Do not delete the Supabase revocation table or association history.

## 7. Verify, test, and troubleshoot

Run local tests and the website build from the repository:

```powershell
npm test
npm run build
```

When Wrangler is installed, check the Worker bundle without deploying:

```powershell
npx wrangler deploy --dry-run --config cloudflare/wrangler.jsonc
```

- **The site cannot connect:** check that Vercel has the correct `VITE_RELAY_URL` and was redeployed.
- **Worker says relay is not configured:** set all three Cloudflare secrets: `RELAY_PEPPER`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.
- **Supabase responds with errors:** check that the migration ran successfully, the URL is the project URL ending in `.supabase.co`, and the key is the server-side `service_role` key.
- **Supabase project is paused:** in the Supabase dashboard, resume it. Pairings remain stored; access returns after the project is active.
- **Pairing code is invalid:** generate a fresh code in the receiver (`pair`) and enter it within two minutes. There are strict per-IP attempt limits.
- **Laptop appears offline:** sign in to Windows, open the receiver, and confirm its internet connection. The receiver retries with backoff; Cloudflare and Supabase free-tier limits or maintenance can still interrupt control.
- **A quota is reached:** wait for the free quota to reset or lower request frequency. Do not enable paid billing. Stored Supabase associations remain durable if the database is active, but the service may temporarily be unavailable.

## Environment and secret boundaries

| Value | Location | Secret? |
|---|---|---|
| `VITE_RELAY_URL` | Vercel frontend build | No; public HTTPS origin |
| `FRONTEND_ORIGINS` | `cloudflare/wrangler.jsonc` | No; website origin allowlist |
| `RELAY_PEPPER` | Cloudflare Worker secret | Yes; HMAC key for receiver/pair credentials |
| `SUPABASE_URL` | Cloudflare Worker secret | Configuration value; used only server-side |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret | Yes; privileged database credential; never expose to browser/receiver |
| `RELAY_URL` | Windows installer build only | No; public HTTPS origin embedded in installer |
| `MOCK_MODE` | Receiver config | No; `false` enables allowed Windows input after pairing |

The receiver accepts only the predefined mouse, keyboard, media, volume, and built-in app actions. It does not run arbitrary shell commands or PowerShell. The phone and receiver credentials are revocable; the Supabase service-role key is never sent to either client.
