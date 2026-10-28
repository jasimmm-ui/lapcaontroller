import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class RelayStore {
  constructor(filename, pepper) {
    if (!filename) throw new Error('RELAY_DB_PATH is required.');
    if (!pepper || Buffer.byteLength(pepper) < 32) throw new Error('RELAY_PEPPER must contain at least 32 bytes.');
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.pepper = pepper;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS receivers (
        id TEXT PRIMARY KEY,
        credential_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0,
        mock_mode INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code_hash TEXT PRIMARY KEY,
        receiver_id TEXT NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pair_codes_expiry ON pair_codes(expires_at);
      CREATE TABLE IF NOT EXISTS pair_requests (
        id TEXT PRIMARY KEY,
        receiver_id TEXT NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        phone_id TEXT NOT NULL,
        phone_name TEXT NOT NULL,
        phone_token_hash TEXT NOT NULL,
        nonce_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pair_requests_receiver ON pair_requests(receiver_id,status,expires_at);
      CREATE TABLE IF NOT EXISTS phones (
        id TEXT NOT NULL,
        receiver_id TEXT NOT NULL REFERENCES receivers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY(id, receiver_id)
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        scope TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        PRIMARY KEY(scope,key_hash)
      );
    `);
    this.statements = {
      receiver: this.db.prepare('SELECT * FROM receivers WHERE id = ?'),
      insertReceiver: this.db.prepare('INSERT INTO receivers(id,credential_hash,name,created_at,last_seen) VALUES(?,?,?,?,?)'),
      updateReceiver: this.db.prepare('UPDATE receivers SET name=?, last_seen=? WHERE id=?'),
      seen: this.db.prepare('UPDATE receivers SET last_seen=?,mock_mode=? WHERE id=?'),
      pairCodeDeleteReceiver: this.db.prepare('DELETE FROM pair_codes WHERE receiver_id=?'),
      pairCodeInsert: this.db.prepare('INSERT INTO pair_codes(code_hash,receiver_id,expires_at) VALUES(?,?,?)'),
      pairCodeConsume: this.db.prepare('DELETE FROM pair_codes WHERE code_hash=? AND expires_at>? RETURNING receiver_id'),
      pendingPairRequests: this.db.prepare("SELECT id,phone_id,phone_name,created_at,expires_at FROM pair_requests WHERE receiver_id=? AND status='pending' AND expires_at>? ORDER BY created_at"),
      pairRequest: this.db.prepare('SELECT * FROM pair_requests WHERE id=?'),
      newPairRequest: this.db.prepare('INSERT INTO pair_requests(id,receiver_id,phone_id,phone_name,phone_token_hash,nonce_hash,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)'),
      approvePair: this.db.prepare("UPDATE pair_requests SET status=? WHERE id=? AND receiver_id=? AND status='pending' AND expires_at>?"),
      expirePair: this.db.prepare("UPDATE pair_requests SET status='expired' WHERE id=? AND status='pending' AND expires_at<=?"),
      phoneUpsert: this.db.prepare('INSERT INTO phones(id,receiver_id,token_hash,name,created_at,revoked_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(id,receiver_id) DO UPDATE SET token_hash=excluded.token_hash,name=excluded.name,created_at=excluded.created_at,revoked_at=NULL'),
      phoneByToken: this.db.prepare('SELECT * FROM phones WHERE id=? AND receiver_id=? AND token_hash=? AND revoked_at IS NULL'),
      phoneByAnyToken: this.db.prepare('SELECT * FROM phones WHERE receiver_id=? AND token_hash=? AND revoked_at IS NULL'),
      phoneList: this.db.prepare('SELECT id,name,created_at FROM phones WHERE receiver_id=? AND revoked_at IS NULL ORDER BY created_at'),
      revokePhone: this.db.prepare('UPDATE phones SET revoked_at=? WHERE id=? AND receiver_id=? AND revoked_at IS NULL'),
      rateLimit: this.db.prepare('SELECT window_start,attempts FROM rate_limits WHERE scope=? AND key_hash=?'),
      rateLimitSet: this.db.prepare('INSERT INTO rate_limits(scope,key_hash,window_start,attempts) VALUES(?,?,?,?) ON CONFLICT(scope,key_hash) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts'),
      cleanup: this.db.prepare('DELETE FROM rate_limits WHERE window_start < ?'),
      cleanupRequests: this.db.prepare('DELETE FROM pair_requests WHERE expires_at < ?'),
      cleanupPhones: this.db.prepare('DELETE FROM phones WHERE revoked_at IS NOT NULL AND revoked_at < ?'),
    };
  }

  hash(value, scope = 'secret') {
    return crypto.createHmac('sha256', this.pepper).update(scope).update('\0').update(String(value)).digest('hex');
  }

  registerReceiver(id, credential, name, now) {
    const credentialHash = this.hash(credential, 'receiver');
    const existing = this.statements.receiver.get(id);
    if (existing) {
      if (!safeHashEqual(existing.credential_hash, credentialHash)) return false;
      this.statements.updateReceiver.run(cleanName(name), now, id);
      return true;
    }
    this.statements.insertReceiver.run(id, credentialHash, cleanName(name), now, now);
    return true;
  }

  receiverHasCredential(id, credential) {
    const row = this.statements.receiver.get(id);
    return Boolean(row && safeHashEqual(row.credential_hash, this.hash(credential, 'receiver')));
  }

  receiver(id) { return this.statements.receiver.get(id) || null; }
  touchReceiver(id, now, mock = true) { this.statements.seen.run(now, mock ? 1 : 0, id); }

  issuePairCode(receiverId, code, expiresAt) {
    this.statements.pairCodeDeleteReceiver.run(receiverId);
    this.statements.pairCodeInsert.run(this.hash(code, 'pair-code'), receiverId, expiresAt);
  }

  consumePairCode(code, now) {
    return this.statements.pairCodeConsume.get(this.hash(code, 'pair-code'), now)?.receiver_id || null;
  }

  createPairRequest({ id, receiverId, phoneId, phoneName, phoneToken, nonce, now, expiresAt }) {
    this.statements.newPairRequest.run(id, receiverId, phoneId, cleanName(phoneName), this.hash(phoneToken, 'phone-token'), this.hash(nonce, 'pair-nonce'), 'pending', now, expiresAt);
  }

  pendingPairRequests(receiverId, now) { return this.statements.pendingPairRequests.all(receiverId, now); }

  pairRequestStatus(id, nonce, now) {
    const row = this.statements.pairRequest.get(id);
    if (!row || !safeHashEqual(row.nonce_hash, this.hash(nonce, 'pair-nonce'))) return null;
    if (row.status === 'pending' && row.expires_at <= now) {
      this.statements.expirePair.run(row.id, now);
      return { status: 'expired' };
    }
    if (row.status !== 'approved') return { status: row.status };
    const receiver = this.receiver(row.receiver_id);
    return { status: 'approved', receiverId: row.receiver_id, receiverName: receiver?.name || 'Windows laptop' };
  }

  decidePairRequest(id, receiverId, approve, now) {
    const row = this.statements.pairRequest.get(id);
    if (!row || row.receiver_id !== receiverId || row.status !== 'pending' || row.expires_at <= now) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (approve) this.statements.phoneUpsert.run(row.phone_id, receiverId, row.phone_token_hash, row.phone_name, now);
      const result = this.statements.approvePair.run(approve ? 'approved' : 'rejected', id, receiverId, now);
      if (Number(result.changes) !== 1) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  phoneHasAccess(receiverId, phoneId, token) {
    return Boolean(this.statements.phoneByToken.get(phoneId, receiverId, this.hash(token, 'phone-token')));
  }

  phoneByToken(receiverId, token) {
    return this.statements.phoneByAnyToken.get(receiverId, this.hash(token, 'phone-token')) || null;
  }

  phones(receiverId) { return this.statements.phoneList.all(receiverId); }
  revokePhone(receiverId, phoneId, now) { return Number(this.statements.revokePhone.run(now, phoneId, receiverId).changes) === 1; }

  allowAttempt(scope, key, { limit, windowMs, now }) {
    const keyHash = this.hash(key, `rate:${scope}`);
    const row = this.statements.rateLimit.get(scope, keyHash);
    const windowStart = row && now - row.window_start < windowMs ? row.window_start : now;
    const attempts = windowStart === row?.window_start ? row.attempts + 1 : 1;
    this.statements.rateLimitSet.run(scope, keyHash, windowStart, attempts);
    return attempts <= limit;
  }

  cleanup(now) {
    this.db.prepare("DELETE FROM pair_codes WHERE expires_at <= ?").run(now);
    this.db.prepare("UPDATE pair_requests SET status='expired' WHERE status='pending' AND expires_at <= ?").run(now);
    this.statements.cleanup.run(now - 24 * 60 * 60 * 1000);
    this.statements.cleanupRequests.run(now - 24 * 60 * 60 * 1000);
    this.statements.cleanupPhones.run(now - 30 * 24 * 60 * 60 * 1000);
  }

  close() { this.db.close(); }
}

function cleanName(value) {
  return String(value || 'Device').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'Device';
}

function safeHashEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
