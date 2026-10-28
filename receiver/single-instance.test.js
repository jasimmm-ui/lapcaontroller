import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acquireInstanceLock } from './single-instance.js';

test('receiver lock rejects a second instance and releases cleanly', t => {
  const testTemp = path.resolve('tmp');
  fs.mkdirSync(testTemp, { recursive: true });
  const root = fs.mkdtempSync(path.join(testTemp, 'liquid-glass-lock-'));
  const identityPath = path.join(root, 'identity.dpapi');
  const first = acquireInstanceLock(identityPath);
  t.after(() => {
    first.release();
    const resolvedRoot = path.resolve(root);
    if (resolvedRoot.startsWith(`${path.resolve('tmp')}${path.sep}`)) fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });
  assert.throws(() => acquireInstanceLock(identityPath), /already running/);
  first.release();
  const second = acquireInstanceLock(identityPath);
  second.release();
  assert.equal(fs.existsSync(first.path), false);
});
