# Liquid Glass Remote

A React PWA and Windows 11 receiver for controlling your laptop from an Android phone on the same private Wi-Fi. The receiver starts in **mock mode**: it accepts commands but never touches the mouse, keyboard, media keys, or apps. Real input requires an explicit `MOCK_MODE=false` setting.

## Requirements

- Windows 11, Node.js 20 or newer, and npm.
- Android phone and laptop on the same trusted private Wi-Fi for live LAN use.
- For live LAN use: a trusted HTTPS certificate with the laptop's LAN IP in its Subject Alternative Name, trusted by the phone.

## Install and preview

In PowerShell, open this folder and run:

```powershell
npm install
npm run dev:all
```

The receiver listens only on `127.0.0.1:8787` by default and prints a ten-digit, one-use code that expires after ten minutes. The Vite interface listens on `127.0.0.1:5173`; open that address on the laptop. In this default loopback mode, phone pairing is not available. `?mock=true` shows the preview UI, and no commands are sent unless a phone is paired with a receiver.

To run unit tests and build the production UI:

```powershell
npm test
npm run build
```

## Secure LAN setup

The LAN receiver requires HTTPS. Do not expose plain HTTP to Wi-Fi clients. It does not change Windows network profiles, open router ports, install a Windows service, or start automatically. If Windows Firewall blocks the phone, an administrator can run `scripts/enable-firewall.ps1`; it creates one rule for `node.exe`, TCP 8787, this laptop address, and the configured Wi-Fi subnet only.

1. Choose a private IPv4 address for the laptop (for example, `192.168.1.25`) and your Wi-Fi subnet (for example, `192.168.1.0/24`). Reserve the address in your router if it supports DHCP reservations.
2. Copy `.env.example` to `.env`. Set `REMOTE_HOST` to the laptop's private IPv4 address and `ALLOWED_CIDR` to its Wi-Fi subnet. For example, use `192.168.1.25` and `192.168.1.0/24` only if those match your network.
3. Create a trusted local certificate with an IP Subject Alternative Name. For example, use [mkcert](https://github.com/FiloSottile/mkcert): run `mkcert -install`, create a certificate for the laptop IP, and place the certificate and key under `certs/`. Set `TLS_CERT` and `TLS_KEY` in `.env` to those files. Transfer only mkcert's public `rootCA.pem` to Android (rename it to `.crt` if Android requires that); never transfer `rootCA-key.pem`.
4. Verify the root certificate fingerprint before installing it as a CA certificate in Android's Security settings; labels vary by manufacturer. This adds a user CA trust anchor on that phone. Remove it from Android settings when you stop using this remote.
5. Run `npm run build`, then `npm start`. Keep `MOCK_MODE=true` while checking the UI; set it to `false` only when ready for real input. Open `https://<laptop-ip>:8787` on the phone and enter the temporary code shown in the receiver window.
6. If Windows Firewall blocks the phone, open PowerShell as Administrator and run `& '<project-folder>\scripts\enable-firewall.ps1'`. The helper reads `REMOTE_HOST` and `ALLOWED_CIDR` from `.env` and limits the rule to that subnet; it does not change the network profile.
7. Press Ctrl+C in the receiver window to stop. Sessions and the one-time code are cleared when the process stops.

Use a narrow `ALLOWED_CIDR` and avoid guest Wi-Fi and networks you do not control. Browser origins and Host headers must match the configured laptop address, preventing arbitrary-origin requests and DNS rebinding. The session token lives only in the browser tab's `sessionStorage`, expires after eight hours, and is discarded when the receiver is restarted or the user disconnects. The certificate files, `.env`, and local firewall configuration are machine-specific and excluded from Git.

## Android PWA

Open the receiver's HTTPS URL in Chrome on Android, pair, then use **Add to Home screen** from the browser menu. Static UI files only are eligible for service-worker caching; `/api/` endpoints are never cached. Offline use cannot control the laptop. Reconnect by reloading the page and pairing again after a receiver restart.

## Features and limits

- Touchpad movement, tap/double-tap, right click, and two-finger scroll; browser gestures are suppressed only inside the touch surface.
- Text insertion uses the Windows clipboard and Ctrl+V, so clipboard contents are replaced. The app does not keep typed text. Mobile keyboards may not send physical function keys, key combinations, or some Unicode sequences consistently.
- Enter, Backspace, Tab, Escape, arrows, Ctrl+C, Ctrl+V, Alt+Tab, and Win+D are supported.
- Media keys and volume up/down/mute are sent as Windows system key events. Precise volume slider and media-session metadata are not implemented.
- Notepad, Calculator, and File Explorer are the only launch targets. Windows resolves these built-in app names; no received shell command is ever executed.
- Laptop name is shown. Battery level and active media status are not currently available.
- `MOCK_MODE=true` is the default and can be used with a paired phone to exercise validated commands without real system input. The UI also has an unpaired preview state.

## Troubleshooting

- **Cannot connect:** confirm both devices use the same Wi-Fi, `REMOTE_HOST` is the laptop's current IPv4, the receiver is running, and Windows Firewall has a rule for TCP 8787 limited to the configured address and subnet.
- **TLS warning:** make sure the certificate has the exact IP in its SAN and its CA is trusted by Android. Do not proceed through an unknown or unexpected certificate warning.
- **Pairing fails:** use the newest code in the receiver console before its ten-minute expiry. Pairing is limited to five attempts per client per minute; wait a minute after repeated failures.
- **App reports receiver errors:** confirm the receiver console is open and inspect its diagnostic message. On non-Windows systems, leave mock mode enabled.
- **Receiver says address unavailable:** update the laptop's IP after a DHCP change and restart the server.
- **Controls seem delayed:** browser touch events are sent over Wi-Fi; cursor movement uses relative pointer deltas and may need sensitivity adjustment.

## Security model

HTTP is used only for loopback development. Production LAN mode refuses to start unless bound to a private IPv4 address, a configured subnet, and TLS certificate material (PFX or PEM). TLS protects pairing and commands in transit; network isolation, a trusted phone, a narrow subnet rule, and safe certificate handling are still required. There is no public discovery, arbitrary command execution, administrator elevation, automatic startup, or UAC bypass.
