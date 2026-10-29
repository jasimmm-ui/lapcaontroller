export function createSupabaseClient({ url, serviceRoleKey, fetchImpl = fetch }) {
  if (typeof url !== 'string' || typeof serviceRoleKey !== 'string' || !serviceRoleKey) throw new Error('Supabase service credentials are required.');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.supabase.co') || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Supabase URL must be a trusted Supabase HTTPS project URL.');
  }
  async function request(path, options = {}) {
    const response = await fetchImpl(`${endpoint.origin}${path}`, {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase request failed (${response.status}).`);
    return text ? JSON.parse(text) : [];
  }
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  return Object.freeze({
    byTokenHash(receiverId, tokenHash) {
      if (!uuid(receiverId) || !/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('Invalid phone credential lookup.');
      return request(`/rest/v1/device_associations?receiver_id=eq.${receiverId}&token_hash=eq.${tokenHash}&revoked_at=is.null&select=phone_id,name,created_at&limit=1`);
    },
    listActive(receiverId) {
      if (!uuid(receiverId)) throw new Error('Invalid receiver identity.');
      return request(`/rest/v1/device_associations?receiver_id=eq.${receiverId}&revoked_at=is.null&select=phone_id,name,created_at&order=created_at.asc`);
    },
    upsert(receiverId, phoneId, tokenHash, name) {
      if (!uuid(receiverId) || !uuid(phoneId) || !/^[0-9a-f]{64}$/.test(tokenHash) || typeof name !== 'string' || name.length < 1 || name.length > 48) throw new Error('Invalid device association.');
      return request('/rest/v1/rpc/upsert_device_association', {
        method: 'POST',
        body: JSON.stringify({ p_receiver_id: receiverId, p_phone_id: phoneId, p_token_hash: tokenHash, p_name: name }),
      });
    },
    revoke(receiverId, phoneId, source) {
      if (!uuid(receiverId) || !uuid(phoneId) || !['phone', 'receiver'].includes(source)) throw new Error('Invalid device revocation.');
      return request('/rest/v1/rpc/revoke_device_association', {
        method: 'POST',
        body: JSON.stringify({ p_receiver_id: receiverId, p_phone_id: phoneId, p_source: source }),
      });
    },
  });
}
