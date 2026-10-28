import fs from 'node:fs';
import path from 'node:path';

export function acquireInstanceLock(identityPath) {
  const lockPath = path.join(path.dirname(identityPath), 'receiver.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fs.closeSync(fd);
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) fs.unlinkSync(lockPath);
          } catch { /* A second process may already have cleaned up a stale lock. */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existingPid = 0;
      try { existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch {}
      let processExists = false;
      if (Number.isInteger(existingPid) && existingPid > 0) {
        try { process.kill(existingPid, 0); processExists = true; }
        catch (probeError) { processExists = probeError.code === 'EPERM'; }
      }
      if (processExists) throw new Error('Another Liquid Glass Remote receiver is already running for this Windows user.');
      try { fs.unlinkSync(lockPath); } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError; }
    }
  }
  throw new Error('Could not acquire the receiver startup lock.');
}
