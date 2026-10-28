import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// The worker accepts JSON data and dispatches a closed set of actions. Payloads
// are never interpolated into PowerShell source, and the process is not elevated.
const workerSource = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$null = Add-Type -AssemblyName System.Windows.Forms
$null = Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LGInput { [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e); [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e); }'
$keys = @{ ENTER='~'; BACKSPACE='{BACKSPACE}'; TAB='{TAB}'; ESCAPE='{ESC}'; ARROWUP='{UP}'; ARROWDOWN='{DOWN}'; ARROWLEFT='{LEFT}'; ARROWRIGHT='{RIGHT}'; SPACE=' '; DELETE='{DELETE}' }
$shortcuts = @{ 'CTRL+C'='^c'; 'CTRL+V'='^v'; 'ALT+TAB'='%{TAB}'; 'WIN+D'='#{d}' }
$apps = @{ notepad='notepad.exe'; calculator='calc.exe'; explorer='explorer.exe' }
while ($line = [Console]::In.ReadLine()) {
  $request = $null
  try {
    $request = ConvertFrom-Json -InputObject $line
    switch ($request.command) {
      'mouse.move' { $p=[System.Windows.Forms.Cursor]::Position; [System.Windows.Forms.Cursor]::Position=[System.Drawing.Point]::new($p.X+[int]$request.dx,$p.Y+[int]$request.dy) }
      'mouse.click' { [LGInput]::mouse_event(0x0002,0,0,0,0); [LGInput]::mouse_event(0x0004,0,0,0,0) }
      'mouse.doubleClick' { 1..2 | ForEach-Object { [LGInput]::mouse_event(0x0002,0,0,0,0); [LGInput]::mouse_event(0x0004,0,0,0,0) } }
      'mouse.rightClick' { [LGInput]::mouse_event(0x0008,0,0,0,0); [LGInput]::mouse_event(0x0010,0,0,0,0) }
      'mouse.scroll' { [LGInput]::mouse_event(0x0800,0,0,[int]$request.delta,0) }
      'keyboard.text' { Set-Clipboard -Value ([string]$request.text); [LGInput]::keybd_event(0x11,0,0,0); [LGInput]::keybd_event(0x56,0,0,0); [LGInput]::keybd_event(0x56,0,2,0); [LGInput]::keybd_event(0x11,0,2,0) }
      'keyboard.key' { [System.Windows.Forms.SendKeys]::SendWait($keys[[string]$request.key]) }
      'keyboard.shortcut' { [System.Windows.Forms.SendKeys]::SendWait($shortcuts[[string]$request.shortcut]) }
      'media.playPause' { [LGInput]::keybd_event(0xB3,0,0,0); [LGInput]::keybd_event(0xB3,0,2,0) }
      'media.previous' { [LGInput]::keybd_event(0xB1,0,0,0); [LGInput]::keybd_event(0xB1,0,2,0) }
      'media.next' { [LGInput]::keybd_event(0xB0,0,0,0); [LGInput]::keybd_event(0xB0,0,2,0) }
      'volume.up' { [LGInput]::keybd_event(0xAF,0,0,0); [LGInput]::keybd_event(0xAF,0,2,0) }
      'volume.down' { [LGInput]::keybd_event(0xAE,0,0,0); [LGInput]::keybd_event(0xAE,0,2,0) }
      'volume.mute' { [LGInput]::keybd_event(0xAD,0,0,0); [LGInput]::keybd_event(0xAD,0,2,0) }
      'app.launch' { $exe=$apps[[string]$request.app]; $appPath=Join-Path $env:WINDIR "System32\$exe"; if(-not (Test-Path -LiteralPath $appPath)){throw "$exe is not available at its standard Windows path."}; Start-Process -FilePath $appPath }
      default { throw 'Unsupported Windows action.' }
    }
    $response = @{ id=$request.id; ok=$true } | ConvertTo-Json -Compress
  } catch { $response = @{ id=$request.id; ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress }
  [Console]::Out.WriteLine($response)
}
`;

let worker; let workerReady = false; let requestNumber = 0;
const pending = new Map();
function startWorker() {
  if (worker) return;
  const encoded=Buffer.from(workerSource,'utf16le').toString('base64');
  worker = spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',encoded],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  workerReady = true;
  const lines=createInterface({input:worker.stdout});
  lines.on('line',line=>{
    let result; try { result=JSON.parse(line); } catch { return; }
    const entry=pending.get(result.id); if(!entry)return; pending.delete(result.id);
    if(result.ok)entry.resolve(); else entry.reject(new Error(result.error||'Windows action failed.'));
  });
  worker.stderr.on('data',()=>{});
  const fail=error=>{for(const item of pending.values())item.reject(error);pending.clear();workerReady=false;worker=undefined;};
  worker.once('error',fail); worker.once('close',code=>fail(new Error(`PowerShell worker stopped (code ${code}).`)));
}

export function executeWindows(command,payload={}) {
  if(process.platform!=='win32')return Promise.reject(new Error('Windows automation is available only on Windows. Enable mock mode to preview commands here.'));
  startWorker(); const id=++requestNumber; const message=JSON.stringify({id,command,...payload});
  return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    const timer=setTimeout(()=>{if(pending.delete(id))reject(new Error('Windows action timed out.'));},5000);
    const entry=pending.get(id); if(entry){const done=entry.resolve;entry.resolve=()=>{clearTimeout(timer);done();};const fail=entry.reject;entry.reject=error=>{clearTimeout(timer);fail(error);};}
    try {
      if(!workerReady||worker.stdin.destroyed)throw new Error('Windows automation worker is unavailable.');
      worker.stdin.write(message+'\n',error=>{if(error&&pending.delete(id)){clearTimeout(timer);reject(error);}});
    } catch(error) { if(pending.delete(id)){clearTimeout(timer);reject(error);} }
  });
}

export function shutdownWindows() {
  workerReady=false;
  for(const entry of pending.values())entry.reject(new Error('Receiver is shutting down.'));
  pending.clear(); if(worker){worker.stdin.end();worker=undefined;}
}
