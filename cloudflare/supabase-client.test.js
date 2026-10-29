import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabaseClient } from './supabase-client.js';

const receiverId = '2a655011-e2c0-4d63-9a0e-2de7433f4210';
const phoneId = '9adc1cde-7468-4d38-8e36-8cfdcae4410e';
const digest = 'a'.repeat(64);

test('Supabase client accepts only a project HTTPS URL and keeps service key on server requests', async () => {
  const calls = [];
  const client = createSupabaseClient({
    url: 'https://example-ref.supabase.co/',
    serviceRoleKey: 'server-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ phone_id: phoneId, name: 'Phone', created_at: '2026-10-28T00:00:00Z' }]));
    },
  });
  const result = await client.byTokenHash(receiverId, digest);
  assert.equal(result[0].phone_id, phoneId);
  assert.equal(calls[0].url, `https://example-ref.supabase.co/rest/v1/device_associations?receiver_id=eq.${receiverId}&token_hash=eq.${digest}&revoked_at=is.null&select=phone_id,name,created_at&limit=1`);
  assert.equal(calls[0].init.headers.apikey, 'server-secret');
  assert.equal(calls[0].init.headers.authorization, 'Bearer server-secret');
  assert.equal(calls[0].init.body, undefined);
  assert.throws(() => createSupabaseClient({ url: 'http://example-ref.supabase.co', serviceRoleKey: 'x' }), /HTTPS/);
  assert.throws(() => createSupabaseClient({ url: 'https://example.com', serviceRoleKey: 'x' }), /Supabase HTTPS/);
  assert.throws(() => createSupabaseClient({ url: 'https://user@example-ref.supabase.co', serviceRoleKey: 'x' }), /Supabase HTTPS/);
});

test('association and revocation use server-side RPCs with only token hashes', async () => {
  const calls = [];
  const client = createSupabaseClient({
    url: 'https://example-ref.supabase.co',
    serviceRoleKey: 'secret',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('true'); },
  });
  await client.upsert(receiverId, phoneId, digest, 'Phone');
  assert.equal(await client.revoke(receiverId, phoneId, 'receiver'), true);
  const upsert = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url.endsWith('/rpc/upsert_device_association'), true);
  assert.equal(upsert.p_token_hash, digest);
  assert.equal(Object.hasOwn(upsert, 'token'), false);
  assert.equal(calls[1].url.endsWith('/rpc/revoke_device_association'), true);
  assert.throws(() => client.revoke(receiverId, phoneId, 'arbitrary'), /Invalid device revocation/);
});

test('migration protects association tables and preserves revocation events', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20261028000000_device_associations.sql', import.meta.url), 'utf8');
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /device_revocations/i);
  assert.match(migration, /revoke all on public\.device_associations, public\.device_revocations from anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.upsert_device_association[\s\S]+to service_role/i);
  assert.match(migration, /grant execute on function public\.revoke_device_association[\s\S]+to service_role/i);
  assert.match(migration, /insert into public\.device_revocations/i);
});
