import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadOrCreateIdentity } from './credential-store.js';

test('receiver identity is DPAPI-protected and survives application restarts', { skip: process.platform !== 'win32' }, t => {
  const testTemp = path.resolve('tmp');
  fs.mkdirSync(testTemp, { recursive: true });
  const root = fs.mkdtempSync(path.join(testTemp, 'liquid-glass-identity-'));
  const filename = path.join(root, 'identity.dpapi');
  t.after(() => {
    const resolvedRoot = path.resolve(root);
    const tempRoot = `${path.resolve('tmp')}${path.sep}`;
    if (resolvedRoot.startsWith(tempRoot)) fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });
  const first = loadOrCreateIdentity(filename);
  const stored = fs.readFileSync(filename, 'utf8');
  assert.equal(stored.includes(first.credential), false);
  const second = loadOrCreateIdentity(filename);
  assert.deepEqual(second, first);
});
