import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const worker = fileURLToPath(new URL('./index.js', import.meta.url));
let current;
let stopping = false;

function stop() {
  stopping = true;
  if (current && current.exitCode === null) current.kill('SIGTERM');
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

let delay = 1000;
while (!stopping) {
  const exitCode = await new Promise(resolve => {
    current = spawn(process.execPath, [worker], { stdio: 'inherit', windowsHide: false });
    current.once('error', error => { console.error(`Receiver could not launch: ${error.message}`); resolve(1); });
    current.once('exit', code => resolve(code ?? 1));
  });
  current = undefined;
  if (stopping || exitCode === 0) break;
  console.error(`Receiver stopped unexpectedly. Restarting in ${Math.ceil(delay / 1000)} second(s).`);
  await sleep(delay);
  delay = Math.min(delay * 2, 30_000);
}
