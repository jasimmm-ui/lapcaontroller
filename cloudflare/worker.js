import { validateCommand } from '../server/validation.js';
import { createSupabaseClient } from './supabase-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9_-]{40,64}$/;
const PAIR_TTL = 120_000;
const ONLINE_TTL = 45_000;
const COMMAND_TTL = 12_000;
const MAX_BODY = 8192;
const encoder = new TextEncoder();

function idOk(value) { return typeof value === 'string' && UUID.test(value); }
function opaque(value) { return typeof value === 'string' && OPAQUE.test(value); }
function safeName(value, fallback) { return (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || fallback; }
function bearer(request) { const value = request.headers.get('authorization') || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
function json(body, status = 200, origin = '') {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    headers.set('access-control-allow-headers', 'Authorization,Content-Type,X-Device-Id');
    headers.set('access-control-max-age', '600');
    headers.set('vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}
function randomBytes(size) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return bytes; }
function randomOpaque() { return btoa(String.fromCharCode(...randomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function randomCode() {
  const number = new Uint16Array(1);
  do { crypto.getRandomValues(number); } while (number[0] >= 65000);
  return String(number[0] % 1000).padStart(3, '0');
}
async function hash(pepper, scope, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${scope}\0${String(value)}`));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function sameHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      const configured = Boolean(env.RELAY && env.RELAY_PEPPER?.length >= 32 && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
      return json({ ok: configured, configured }, configured ? 200 : 503);
    }
    if (!url.pathname.startsWith('/v1/')) return json({ error: 'Not found.' }, 404);
    if (!env.RELAY || !env.RELAY_PEPPER || env.RELAY_PEPPER.length < 32 || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Relay is not configured.' }, 503);
    const id = env.RELAY.idFromName('personal-use-relay');
    return env.RELAY.get(id).fetch(request);
  },
};

export class RelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.db = createSupabaseClient({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY });
    this.pendingCommands = new Map();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS receivers (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, mock_mode INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS pair_codes (code_hash TEXT PRIMARY KEY, receiver_id TEXT NOT NULL REFERENCES receivers(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_requests (id TEXT PRIMARY KEY, receiver_id TEXT NOT NULL REFERENCES receivers(id) ON DELETE CASCADE, phone_id TEXT NOT NULL, phone_name TEXT NOT NULL, phone_token_hash TEXT NOT NULL, nonce_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pair_requests_receiver ON pair_requests(receiver_id,status,expires_at);
      CREATE TABLE IF NOT EXISTS rate_limits (scope TEXT NOT NULL, key_hash TEXT NOT NULL, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(scope,key_hash));
    `);
  }

  rows(query, ...values) { return this.sql.exec(query, ...values).toArray(); }
  row(query, ...values) { return this.rows(query, ...values)[0] || null; }
  async ensureCleanupAlarm() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
  }
  async alarm() {
    const now = Date.now();
    this.sql.exec('DELETE FROM pair_codes WHERE expires_at<=?', now);
    this.sql.exec("UPDATE pair_requests SET status='expired' WHERE status='pending' AND expires_at<=?", now);
    this.sql.exec('DELETE FROM pair_requests WHERE expires_at<?', now - 24 * 60 * 60_000);
    this.sql.exec('DELETE FROM rate_limits WHERE window_start<?', now - 24 * 60 * 60_000);
    await this.ctx.storage.setAlarm(now + 60 * 60_000);
  }
  origin(request) {
    const origin = request.headers.get('origin') || '';
    const allowed = (this.env.FRONTEND_ORIGINS || 'https://lapcontroller.vercel.app').split(',').map(value => value.trim()).filter(Boolean);
    return { origin, allowed: !origin || allowed.includes(origin) };
  }
  async body(request) {
    const text = await request.text();
    if (text.length > MAX_BODY) throw new Error('Request body is too large.');
    return text ? JSON.parse(text) : {};
  }
  receiver(id) { return this.row('SELECT * FROM receivers WHERE id=?', id); }
  async receiverAuth(request) {
    const id = request.headers.get('x-device-id');
    const credential = bearer(request);
    if (!idOk(id) || !opaque(credential)) return null;
    const row = this.receiver(id);
    const digest = await hash(this.env.RELAY_PEPPER, 'receiver', credential);
    return row && sameHash(row.credential_hash, digest) ? row : null;
  }
  async phoneAuth(receiverId, token) {
    if (!idOk(receiverId) || !opaque(token)) return null;
    const digest = await hash(this.env.RELAY_PEPPER, 'phone-token', token);
    const rows = await this.db.byTokenHash(receiverId, digest);
    return rows[0] ? { id: rows[0].phone_id, name: rows[0].name, created_at: Date.parse(rows[0].created_at) } : null;
  }
  async association(receiverId, phoneId, tokenHash, name) {
    return this.db.upsert(receiverId, phoneId, tokenHash, name);
  }
  async revokeAssociation(receiverId, phoneId, source) {
    const rows = await this.db.revoke(receiverId, phoneId, source);
    return rows === true || rows?.[0] === true || rows?.[0]?.revoke_device_association === true;
  }
  async allowedAttempt(scope, key, limit, windowMs) {
    const keyHash = await hash(this.env.RELAY_PEPPER, `rate:${scope}`, key);
    const now = Date.now();
    const result = this.row(`INSERT INTO rate_limits(scope,key_hash,window_start,attempts) VALUES(?,?,?,1)
      ON CONFLICT(scope,key_hash) DO UPDATE SET
        window_start=CASE WHEN ?-rate_limits.window_start>=? THEN ? ELSE rate_limits.window_start END,
        attempts=CASE WHEN ?-rate_limits.window_start>=? THEN 1 ELSE rate_limits.attempts+1 END
      RETURNING attempts`, scope, keyHash, now, now, windowMs, now, now, windowMs);
    return Number(result?.attempts || 0) <= limit;
  }
  async limited(request, scope, key, limit, windowMs) {
    if (await this.allowedAttempt(scope, key, limit, windowMs)) return false;
    const { origin } = this.origin(request);
    json({ error: 'Too many attempts. Wait and try again.' }, 429, origin);
    return true;
  }
  clientIp(request) { return request.headers.get('cf-connecting-ip') || 'unknown'; }
  cors(request, status, body) { return json(body, status, this.origin(request).origin); }

  async fetch(request) {
    await this.ensureCleanupAlarm();
    const url = new URL(request.url);
    const { origin, allowed } = this.origin(request);
    if (!allowed) return json({ error: 'This website is not allowed to use the relay.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type,X-Device-Id', 'access-control-max-age': '600', vary: 'Origin' } });
    if (url.pathname === '/v1/ws/receiver' || url.pathname === '/v1/ws/phone') return this.acceptSocket(request, url.pathname.endsWith('/receiver') ? 'receiver' : 'phone');
    try {
      const result = await this.route(request, url);
      return result instanceof Response ? result : json(result.body, result.status || 200, origin);
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
      return json({ error: status >= 500 ? 'The relay could not complete the request.' : error.message }, status, origin);
    }
  }

  async route(request, url) {
    const path = url.pathname;
    const method = request.method;
    const now = Date.now();
    if (path === '/v1/receiver/register' && method === 'POST') {
      if (await this.limited(request, 'register', this.clientIp(request), 10, 60_000)) return { body: { error: 'Too many attempts. Wait and try again.' }, status: 429 };
      const body = await this.body(request);
      if (!idOk(body.deviceId) || !opaque(body.credential)) return { body: { error: 'Invalid receiver registration.' }, status: 400 };
      const digest = await hash(this.env.RELAY_PEPPER, 'receiver', body.credential);
      const existing = this.receiver(body.deviceId);
      if (existing && !sameHash(existing.credential_hash, digest)) return { body: { error: 'This receiver identity is already registered with different credentials.' }, status: 401 };
      if (existing) this.sql.exec('UPDATE receivers SET name=?,last_seen=?,mock_mode=? WHERE id=?', safeName(body.name, 'Windows laptop'), now, body.mock ? 1 : 0, body.deviceId);
      else this.sql.exec('INSERT INTO receivers(id,credential_hash,name,created_at,last_seen,mock_mode) VALUES(?,?,?,?,?,?)', body.deviceId, digest, safeName(body.name, 'Windows laptop'), now, now, body.mock ? 1 : 0);
      return { body: { ok: true, deviceId: body.deviceId } };
    }

    if (path === '/v1/receiver/pair-code' && method === 'POST') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      if (await this.limited(request, 'pair-code', receiver.id, 6, 10 * 60_000)) return { body: { error: 'Too many attempts. Wait and try again.' }, status: 429 };
      let code;
      for (let i = 0; i < 20; i++) {
        const candidate = randomCode();
        const digest = await hash(this.env.RELAY_PEPPER, 'pair-code', candidate);
        if (!this.row('SELECT 1 AS found FROM pair_codes WHERE code_hash=? AND expires_at>?', digest, now)) { code = candidate; break; }
      }
      if (!code) return { body: { error: 'Could not create a pairing code. Try again shortly.' }, status: 503 };
      const digest = await hash(this.env.RELAY_PEPPER, 'pair-code', code);
      this.sql.exec('DELETE FROM pair_codes WHERE receiver_id=?', receiver.id);
      this.sql.exec('INSERT INTO pair_codes(code_hash,receiver_id,expires_at) VALUES(?,?,?)', digest, receiver.id, now + PAIR_TTL);
      return { body: { code, expiresAt: now + PAIR_TTL } };
    }

    if (path === '/v1/pair' && method === 'POST') {
      if (await this.limited(request, 'pair', this.clientIp(request), 5, 60_000)) return { body: { error: 'Too many attempts. Wait and try again.' }, status: 429 };
      const body = await this.body(request);
      if (typeof body.code !== 'string' || !/^\d{3}$/.test(body.code) || !idOk(body.phoneId) || !opaque(body.phoneToken) || !opaque(body.nonce)) return { body: { error: 'Enter the three-digit code shown by the Windows receiver.' }, status: 400 };
      const codeHash = await hash(this.env.RELAY_PEPPER, 'pair-code', body.code);
      const consumed = this.row('DELETE FROM pair_codes WHERE code_hash=? AND expires_at>? RETURNING receiver_id', codeHash, now);
      if (!consumed) return { body: { error: 'That code is incorrect, expired, or already used.' }, status: 401 };
      const id = randomOpaque();
      const phoneTokenHash = await hash(this.env.RELAY_PEPPER, 'phone-token', body.phoneToken);
      const nonceHash = await hash(this.env.RELAY_PEPPER, 'pair-nonce', body.nonce);
      this.sql.exec('INSERT INTO pair_requests(id,receiver_id,phone_id,phone_name,phone_token_hash,nonce_hash,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', id, consumed.receiver_id, body.phoneId, safeName(body.phoneName, 'Android phone'), phoneTokenHash, nonceHash, 'pending', now, now + PAIR_TTL);
      this.sendToReceiver(consumed.receiver_id, { type: 'pair_request', pair: { id, phone_id: body.phoneId, phone_name: safeName(body.phoneName, 'Android phone'), created_at: now, expires_at: now + PAIR_TTL } });
      return { body: { requestId: id, expiresAt: now + PAIR_TTL }, status: 202 };
    }

    const pairStatus = path.match(/^\/v1\/pair\/([A-Za-z0-9_-]{40,64})$/);
    if (pairStatus && method === 'GET') {
      const nonce = bearer(request);
      if (!opaque(nonce)) return { body: { error: 'Pairing request authentication failed.' }, status: 401 };
      const row = this.row('SELECT * FROM pair_requests WHERE id=?', pairStatus[1]);
      if (!row || !sameHash(row.nonce_hash, await hash(this.env.RELAY_PEPPER, 'pair-nonce', nonce))) return { body: { error: 'Pairing request was not found or has expired.' }, status: 404 };
      if (row.status === 'pending' && row.expires_at <= now) {
        this.sql.exec("UPDATE pair_requests SET status='expired' WHERE id=? AND status='pending'", row.id);
        return { body: { status: 'expired' } };
      }
      if (row.status !== 'approved') return { body: { status: row.status } };
      const laptop = this.receiver(row.receiver_id);
      return { body: { status: 'approved', receiverId: row.receiver_id, receiverName: laptop?.name || 'Windows laptop' } };
    }

    if (path === '/v1/receiver/poll' && method === 'GET') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      this.sql.exec('UPDATE receivers SET last_seen=? WHERE id=?', now, receiver.id);
      const pairs = this.rows("SELECT id,phone_id,phone_name,created_at,expires_at FROM pair_requests WHERE receiver_id=? AND status='pending' AND expires_at>? ORDER BY created_at", receiver.id, now);
      return { body: { pairs, commands: [] } };
    }

    if (path === '/v1/receiver/decision' && method === 'POST') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      const body = await this.body(request);
      if (!opaque(body.requestId) || typeof body.approve !== 'boolean') return { body: { error: 'Invalid pairing decision.' }, status: 400 };
      const pair = this.row('SELECT * FROM pair_requests WHERE id=? AND receiver_id=? AND status=? AND expires_at>?', body.requestId, receiver.id, 'pending', now);
      if (!pair) return { body: { error: 'This pairing request has expired or was already handled.' }, status: 409 };
      if (body.approve) await this.association(receiver.id, pair.phone_id, pair.phone_token_hash, pair.phone_name);
      const changed = this.row('UPDATE pair_requests SET status=? WHERE id=? AND receiver_id=? AND status=? AND expires_at>? RETURNING id', body.approve ? 'approved' : 'rejected', body.requestId, receiver.id, 'pending', now);
      if (!changed) return { body: { error: 'This pairing request has expired or was already handled.' }, status: 409 };
      return { body: { ok: true } };
    }

    if (path === '/v1/receiver/phones' && method === 'GET') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      const phones = await this.db.listActive(receiver.id);
      return { body: { phones: phones.map(phone => ({ id: phone.phone_id, name: phone.name, created_at: Date.parse(phone.created_at) })) } };
    }
    const revokeByReceiver = path.match(/^\/v1\/receiver\/phones\/([0-9a-f-]{36})$/i);
    if (revokeByReceiver && method === 'DELETE') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      if (!idOk(revokeByReceiver[1])) return { body: { error: 'Invalid phone identity.' }, status: 400 };
      const removed = await this.revokeAssociation(receiver.id, revokeByReceiver[1], 'receiver');
      return removed ? { body: { ok: true } } : { body: { error: 'Paired phone was not found.' }, status: 404 };
    }

    if (path === '/v1/receiver/result' && method === 'POST') {
      const receiver = await this.receiverAuth(request);
      if (!receiver) return { body: { error: 'Receiver authentication failed.' }, status: 401 };
      const body = await this.body(request);
      const pending = this.pendingCommands.get(body.id);
      if (!opaque(body.id) || typeof body.ok !== 'boolean' || !pending || pending.receiverId !== receiver.id) return { body: { error: 'Command request was not found.' }, status: 404 };
      pending.finish(body.ok ? { ok: true } : { ok: false, error: 'The Windows action could not be completed.' });
      return { body: { ok: true } };
    }

    const phonePath = path.match(/^\/v1\/phones\/([0-9a-f-]{36})(?:\/(status|access|commands))?$/i);
    if (phonePath) {
      const receiverId = phonePath[1];
      const action = phonePath[2] || '';
      const phone = await this.phoneAuth(receiverId, bearer(request));
      if (!phone) return { body: { error: 'Device authentication failed. Revoke and pair this phone again if needed.' }, status: 401 };
      if (action === 'status' && method === 'GET') {
        const laptop = this.receiver(receiverId);
        if (!laptop) return { body: { error: 'Laptop is no longer registered.' }, status: 404 };
        return { body: { receiverId, name: laptop.name, online: now - laptop.last_seen < ONLINE_TTL, mock: Boolean(laptop.mock_mode), lastSeen: laptop.last_seen } };
      }
      if (action === 'access' && method === 'DELETE') {
        await this.revokeAssociation(receiverId, phone.id, 'phone');
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': this.origin(request).origin, 'cache-control': 'no-store' } });
      }
      if (action === 'commands' && method === 'POST') {
        if (!await this.allowedAttempt('command', `${phone.id}:${receiverId}`, 6000, 60_000)) return { body: { error: 'Too many attempts. Wait and try again.' }, status: 429 };
        const command = await this.body(request);
        if (!validateCommand(command)) return { body: { error: 'Invalid command or payload.' }, status: 400 };
        const laptop = this.receiver(receiverId);
        if (!laptop || now - laptop.last_seen >= ONLINE_TTL) return { body: { error: 'Laptop is offline. Open the receiver on that laptop and try again.' }, status: 409 };
        const socket = this.findReceiverSocket(receiverId);
        if (!socket) return { body: { error: 'Laptop is reconnecting. Try again in a moment.' }, status: 409 };
        const id = randomOpaque();
        const result = await new Promise(resolve => {
          const timer = setTimeout(() => finish({ ok: false, error: 'The laptop did not respond in time. Try again.' }), COMMAND_TTL);
          const finish = value => { clearTimeout(timer); this.pendingCommands.delete(id); resolve(value); };
          this.pendingCommands.set(id, { receiverId, finish });
          try { socket.send(JSON.stringify({ type: 'command', id, command })); }
          catch { finish({ ok: false, error: 'Laptop connection interrupted. Try again.' }); }
        });
        return result.ok ? { body: { ok: true } } : { body: { error: result.error }, status: 504 };
      }
      return { body: { error: 'Method not allowed.' }, status: 405 };
    }
    return { body: { error: 'Not found.' }, status: 404 };
  }

  acceptSocket(request, kind) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return this.cors(request, 426, { error: 'WebSocket upgrade required.' });
    if (this.ctx.getWebSockets().length >= 50) return this.cors(request, 503, { error: 'Relay connection limit reached.' });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind, authenticated: false, lastHeartbeat: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  findReceiverSocket(receiverId) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.kind === 'receiver' && attachment.authenticated && attachment.deviceId === receiverId && socket.readyState === WebSocket.OPEN) return socket;
    }
    return null;
  }
  sendToReceiver(receiverId, message) {
    const socket = this.findReceiverSocket(receiverId);
    if (socket) { try { socket.send(JSON.stringify(message)); } catch { /* receiver reconnects automatically */ } }
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > 2048) { socket.close(1009, 'Message too large'); return; }
    let message;
    try { message = JSON.parse(raw); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1008, 'Invalid message'); return; }
    const attachment = socket.deserializeAttachment() || { authenticated: false, lastHeartbeat: 0 };
    if (!attachment.authenticated) {
      if (message.type !== 'auth') { socket.close(1008, 'Authentication required'); return; }
      if (attachment.kind === 'receiver') {
        if (Object.keys(message).length !== 3 || !idOk(message.deviceId) || !opaque(message.credential)) { socket.close(1008, 'Invalid authentication'); return; }
        const receiver = this.receiver(message.deviceId);
        const digest = await hash(this.env.RELAY_PEPPER, 'receiver', message.credential);
        if (!receiver || !sameHash(receiver.credential_hash, digest)) { socket.close(1008, 'Authentication failed'); return; }
        attachment.deviceId = receiver.id;
        this.sql.exec('UPDATE receivers SET last_seen=? WHERE id=?', Date.now(), receiver.id);
        socket.serializeAttachment({ ...attachment, authenticated: true });
        socket.send(JSON.stringify({ type: 'authenticated' }));
        const pairs = this.rows("SELECT id,phone_id,phone_name,created_at,expires_at FROM pair_requests WHERE receiver_id=? AND status='pending' AND expires_at>? ORDER BY created_at", receiver.id, Date.now());
        for (const pair of pairs) socket.send(JSON.stringify({ type: 'pair_request', pair }));
        return;
      }
      if (Object.keys(message).length !== 3 || !idOk(message.receiverId) || !opaque(message.token)) { socket.close(1008, 'Invalid authentication'); return; }
      const phone = await this.phoneAuth(message.receiverId, message.token);
      if (!phone) { socket.close(1008, 'Authentication failed'); return; }
      attachment.receiverId = message.receiverId;
      attachment.phoneId = phone.id;
      socket.serializeAttachment({ ...attachment, authenticated: true });
      socket.send(JSON.stringify({ type: 'authenticated' }));
      return;
    }
    if (message.type === 'heartbeat' && Object.keys(message).length === 1) {
      const now = Date.now();
      if (now - Number(attachment.lastHeartbeat || 0) < 10_000) { socket.close(1008, 'Heartbeat rate exceeded'); return; }
      attachment.lastHeartbeat = now;
      socket.serializeAttachment(attachment);
      if (attachment.kind === 'receiver') this.sql.exec('UPDATE receivers SET last_seen=? WHERE id=?', now, attachment.deviceId);
      socket.send(JSON.stringify({ type: 'heartbeat_ack', at: now }));
      return;
    }
    if (attachment.kind === 'receiver' && message.type === 'result' && Object.keys(message).length === 3) {
      const pending = this.pendingCommands.get(message.id);
      if (pending && pending.receiverId === attachment.deviceId && typeof message.ok === 'boolean') pending.finish(message.ok ? { ok: true } : { ok: false, error: 'The Windows action could not be completed.' });
      return;
    }
    socket.close(1008, 'Unsupported message');
  }

  webSocketClose(socket, code, reason) { try { socket.close(code, reason); } catch {} }
  webSocketError(socket) { try { socket.close(1011, 'WebSocket error'); } catch {} }
}
