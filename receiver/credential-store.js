import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const powershell = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LiquidGlassDpapi {
  [StructLayout(LayoutKind.Sequential)] private struct BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool CryptProtectData(ref BLOB input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out BLOB output);
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool CryptUnprotectData(ref BLOB input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out BLOB output);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr LocalFree(IntPtr memory);
  public static byte[] Transform(byte[] data, bool protect) {
    BLOB input = new BLOB { cbData = data.Length, pbData = Marshal.AllocHGlobal(data.Length) };
    try {
      Marshal.Copy(data, 0, input.pbData, data.Length);
      BLOB output; IntPtr description = IntPtr.Zero;
      bool ok = protect
        ? CryptProtectData(ref input, "Liquid Glass Remote", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
        : CryptUnprotectData(ref input, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { byte[] result = new byte[output.cbData]; Marshal.Copy(output.pbData, result, 0, output.cbData); return result; }
      finally { LocalFree(output.pbData); if (description != IntPtr.Zero) LocalFree(description); }
    } finally { Marshal.FreeHGlobal(input.pbData); }
  }
}
'@
Add-Type -TypeDefinition $source
$bytes = [Convert]::FromBase64String([Console]::In.ReadLine())
$result = [LiquidGlassDpapi]::Transform($bytes, $env:LG_DPAPI_ACTION -eq 'protect')
[Console]::WriteLine([Convert]::ToBase64String($result))
`;
const encodedPowerShell = Buffer.from(powershell, 'utf16le').toString('base64');

function dpapi(action, value) {
  if (process.platform !== 'win32') throw new Error('The receiver identity store requires Windows DPAPI.');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell], {
    input: Buffer.from(value).toString('base64') + '\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: { ...process.env, LG_DPAPI_ACTION: action },
  });
  if (result.error || result.status !== 0) throw new Error(`Windows DPAPI operation failed: ${(result.stderr || result.error?.message || 'unknown error').trim().split(/\r?\n/)[0]}`);
  const output = result.stdout.trim().split(/\r?\n/).at(-1);
  try { return Buffer.from(output, 'base64'); }
  catch { throw new Error('Windows returned an invalid protected identity.'); }
}

export function defaultIdentityPath(env = process.env) {
  const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Liquid Glass Remote', 'identity.dpapi');
}

export function loadOrCreateIdentity(filename = defaultIdentityPath()) {
  if (fs.existsSync(filename)) {
    const encrypted = Buffer.from(fs.readFileSync(filename, 'utf8').trim(), 'base64');
    let identity;
    try { identity = JSON.parse(dpapi('unprotect', encrypted).toString('utf8')); }
    catch { throw new Error(`Could not unlock the saved receiver identity at ${filename}. Do not delete it unless you intend to register this laptop as a new device.`); }
    if (!identity || typeof identity.deviceId !== 'string' || typeof identity.credential !== 'string') throw new Error('Saved receiver identity is incomplete.');
    return identity;
  }
  const identity = { deviceId: crypto.randomUUID(), credential: crypto.randomBytes(32).toString('base64url') };
  const encrypted = dpapi('protect', Buffer.from(JSON.stringify(identity)));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temp, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, filename);
  return identity;
}
