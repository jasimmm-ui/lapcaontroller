import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { loadOrCreateIdentity, defaultIdentityPath } from './credential-store.js';
import { acquireInstanceLock } from './single-instance.js';
import { executeWindows, shutdownWindows } from '../server/windows.js';
import { validateCommand } from '../server/validation.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function readSimpleEnv(filename) {
  if (!fs.existsSync(filename)) return {};
  const result = {};
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

function config() {
  const file = process.env.LG_CONFIG_PATH || path.join(here, 'config.json');
  let json = {};
  if (fs.existsSync(file)) {
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error(`Receiver configuration is not valid JSON: ${file}`); }
  }
  const local = readSimpleEnv(path.resolve(process.cwd(), '.env'));
  const relayUrl = process.env.RELAY_URL || local.RELAY_URL || json.relayUrl || '';
  if (!relayUrl) throw new Error('Set RELAY_URL in receiver/config.json or the project .env file.');
  let url;
  try { url = new URL(relayUrl); } catch { throw new Error('RELAY_URL must be an HTTPS relay address.'); }
  const localDev = ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!localDev && url.protocol !== 'https:') || (localDev && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('RELAY_URL must be a trusted HTTPS origin in production. HTTP is allowed only for localhost development.');
  const mockValue = process.env.MOCK_MODE ?? local.MOCK_MODE ?? String(json.mockMode ?? true);
  return { relayBase: url.origin, mock: mockValue !== 'false' };
}

const settings = config();
const identityPath = defaultIdentityPath();
let instanceLock;
try { instanceLock = acquireInstanceLock(identityPath); }
catch (error) { console.error(error.message); process.exit(0); }
process.once('exit', () => instanceLock?.release());
const identity = loadOrCreateIdentity(identityPath);
const pendingPairs = new Map();
const promptedPairs = new Set();
const pairTimers = new Map();
let stopping = false;
let retryDelay = 1000;
let wasOffline = false;
const controller = new AbortController();
let heartbeatSocket = null;
let heartbeatConnected = false;

function websocketAddress() {
  const url = new URL(settings.relayBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/ws/receiver';
  return url.toString();
}

async function websocketHeartbeatLoop() {
  let delay = 1000;
  while (!stopping) {
    await new Promise(resolve => {
      const socket = new WebSocket(websocketAddress());
      heartbeatSocket = socket;
      let authenticated = false;
      let timer;
      const finish = () => { clearInterval(timer); if (heartbeatSocket === socket) heartbeatSocket = null; resolve(); };
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'auth', deviceId: identity.deviceId, credential: identity.credential }));
      }, { once: true });
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { socket.close(); return; }
        if (message.type === 'authenticated' && !authenticated) {
          authenticated = true;
          delay = 1000;
          heartbeatConnected = true;
          console.log('Secure relay heartbeat connected.');
          const beat = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' })); };
          beat();
          timer = setInterval(beat, 20_000);
          timer.unref?.();
          return;
        }
        if (!authenticated) return;
        if (message.type === 'pair_request' && message.pair && typeof message.pair.id === 'string') receivePairs([message.pair]);
        else if (message.type === 'command' && typeof message.id === 'string' && message.command && typeof message.command === 'object') void executeQueued({ id: message.id, ...message.command });
      });
      socket.addEventListener('error', () => {});
      socket.addEventListener('close', () => {
        if (heartbeatConnected) console.log('Relay heartbeat interrupted; reconnecting automatically.');
        heartbeatConnected = false;
        finish();
      }, { once: true });
      if (stopping) socket.close();
    });
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
rl.setPrompt('remote> ');

async function api(route, { method = 'GET', body, timeout = 10_000, signal } = {}) {
  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), timeout);
  const abort = () => localController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${settings.relayBase}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': identity.deviceId,
        Authorization: `Bearer ${identity.credential}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: localController.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Relay returned ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function announce() {
  const response = await fetch(`${settings.relayBase}/v1/receiver/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: identity.deviceId, credential: identity.credential, name: os.hostname(), mock: settings.mock }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Relay registration failed (${response.status}).`);
  console.log(`Registered this laptop as ${os.hostname()}.`);
}

async function showPairingCode() {
  try {
    const { code, expiresAt } = await api('/v1/receiver/pair-code', { method: 'POST', body: {} });
    console.log(`Pairing code: ${code} (expires in about 2 minutes; one use only).`);
    console.log(`This code only starts a request. Approve each phone here before it can control this laptop.`);
    setTimeout(() => console.log('That pairing code has expired. Type pair to create a new one.'), Math.max(0, expiresAt - Date.now())).unref();
  } catch (error) { console.log(`Could not create a pairing code: ${error.message}`); }
}

async function answerPair(approve) {
  const [id, pair] = pendingPairs.entries().next().value || [];
  if (!id) { console.log('There is no waiting phone request.'); return; }
  try {
    await api('/v1/receiver/decision', { method: 'POST', body: { requestId: id, approve } });
    pendingPairs.delete(id);
    promptedPairs.delete(id);
    clearTimeout(pairTimers.get(id));
    pairTimers.delete(id);
    console.log(`${approve ? 'Approved' : 'Rejected'} ${pair.phoneName}.`);
  } catch (error) { console.log(`Could not update pairing request: ${error.message}`); }
}

async function listPhones() {
  try {
    const { phones } = await api('/v1/receiver/phones');
    if (!phones.length) console.log('No phones are paired with this laptop.');
    else for (const phone of phones) console.log(`${phone.name}  ID: ${phone.id}`);
  } catch (error) { console.log(`Could not list paired phones: ${error.message}`); }
}

async function revokePhone(id) {
  try {
    await api(`/v1/receiver/phones/${encodeURIComponent(id)}`, { method: 'DELETE' });
    console.log(`Revoked phone access: ${id}`);
  } catch (error) { console.log(`Could not revoke phone: ${error.message}`); }
}

rl.on('line', line => {
  const [command, value] = line.trim().split(/\s+/, 2);
  if (command === 'approve' || command === 'yes' || command === 'y') void answerPair(true);
  else if (command === 'reject' || command === 'no' || command === 'n') void answerPair(false);
  else if (command === 'pair' || command === 'p') void showPairingCode();
  else if (command === 'phones' || command === 'list') void listPhones();
  else if (command === 'revoke' && value) void revokePhone(value);
  else if (command === 'quit' || command === 'exit') shutdown();
  else if (command === 'help') console.log('Commands: approve, reject, pair, phones, revoke <phone-id>, quit');
  else console.log('Commands: approve, reject, pair, phones, revoke <phone-id>, quit');
  if (!stopping) rl.prompt();
});

function receivePairs(pairs) {
  for (const pair of pairs) {
    if (promptedPairs.has(pair.id)) continue;
    promptedPairs.add(pair.id);
    pendingPairs.set(pair.id, pair);
    console.log(`\nPhone request: ${pair.phoneName}. Approving grants remote mouse, keyboard, media, and supported app control. Type approve or reject (the first waiting request is selected).`);
    const timer = setTimeout(() => {
      pendingPairs.delete(pair.id);
      promptedPairs.delete(pair.id);
      pairTimers.delete(pair.id);
      console.log(`Pairing request from ${pair.phoneName} expired.`);
    }, Math.max(0, pair.expires_at - Date.now()));
    timer.unref();
    pairTimers.set(pair.id, timer);
  }
  if (pairs.length) rl.prompt();
}

async function executeQueued(command) {
  const { id, ...payload } = command;
  let ok = false;
  try {
    if (!validateCommand(payload)) throw new Error('Invalid remote action.');
    if (!settings.mock) await executeWindows(payload.command, payload);
    ok = true;
  } catch (error) {
    if (!settings.mock) console.log(`Windows action failed: ${error.message}`);
  }
  try { await api('/v1/receiver/result', { method: 'POST', body: { id, ok } }); }
  catch { /* The phone request expires safely if the relay is temporarily unavailable. */ }
}

async function reconnectLoop() {
  while (!stopping) {
    try {
      const data = await api('/v1/receiver/poll', { timeout: 27_000, signal: controller.signal });
      if (wasOffline) console.log('Connection to relay restored.');
      wasOffline = false;
      retryDelay = 1000;
      receivePairs(data.pairs || []);
      for (const command of data.commands || []) await executeQueued(command);
    } catch (error) {
      if (stopping) break;
      if (!wasOffline) console.log(`Relay connection interrupted. Retrying automatically: ${error.message}`);
      wasOffline = true;
      if (error.status === 401) {
        console.log('The saved receiver identity is no longer recognized. Stop and contact the person managing the relay; do not delete the saved identity yet.');
        retryDelay = 30_000;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }
}

let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopping = true;
  controller.abort();
  heartbeatSocket?.close(1000, 'Receiver shutting down');
  console.log('\nStopping Liquid Glass Remote...');
  rl.close();
  shutdownWindows();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  console.log('Liquid Glass Remote receiver');
  console.log(`Saved device identity: ${identityPath}`);
  console.log(`Relay: ${settings.relayBase}`);
  console.log(`Mode: ${settings.mock ? 'Preview only' : 'LIVE laptop control'}`);
  await announce();
  void websocketHeartbeatLoop();
  await showPairingCode();
  console.log('Type help for receiver commands. Keep this window open while you use the phone.');
  rl.prompt();
  await reconnectLoop();
} catch (error) {
  console.error(`Receiver could not start: ${error.message}`);
  shutdown();
  process.exitCode = 1;
}
