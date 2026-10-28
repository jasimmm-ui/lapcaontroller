import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function isPrivateIPv4(ip) {
  const parts = String(ip).replace(/^::ffff:/, '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

export function inCidr(ip, cidr) {
  if (!cidr) return true;
  const [net, prefixText] = cidr.split('/'); const prefix = Number(prefixText);
  const toInt = value => value.split('.').reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

export function makeLimiter({ limit = 5, windowMs = 60000 } = {}) {
  const attempts = new Map();
  return key => {
    const now = Date.now(); const recent = (attempts.get(key) || []).filter(time => now - time < windowMs);
    recent.push(now); attempts.set(key, recent);
    return recent.length <= limit;
  };
}
