-- Durable phone credentials and append-only revocation history.
-- The Cloudflare Worker is the only application component allowed to use service_role.
create table if not exists public.device_associations (
  receiver_id uuid not null,
  phone_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) between 1 and 48),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (receiver_id, phone_id)
);

create index if not exists device_associations_active_token
  on public.device_associations (receiver_id, token_hash)
  where revoked_at is null;

create table if not exists public.device_revocations (
  id bigint generated always as identity primary key,
  receiver_id uuid not null,
  phone_id uuid not null,
  revoked_at timestamptz not null default now(),
  source text not null check (source in ('phone', 'receiver'))
);

alter table public.device_associations enable row level security;
alter table public.device_revocations enable row level security;
revoke all on public.device_associations, public.device_revocations from anon, authenticated;
revoke all on public.device_associations, public.device_revocations from public;
grant select on public.device_associations to service_role;

create or replace function public.upsert_device_association(
  p_receiver_id uuid,
  p_phone_id uuid,
  p_token_hash text,
  p_name text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or char_length(p_name) not between 1 and 48 then
    raise exception 'invalid association';
  end if;
  insert into public.device_associations(receiver_id, phone_id, token_hash, name, created_at, revoked_at)
  values (p_receiver_id, p_phone_id, p_token_hash, p_name, now(), null)
  on conflict (receiver_id, phone_id) do update
    set token_hash = excluded.token_hash, name = excluded.name,
        created_at = excluded.created_at, revoked_at = null;
end;
$$;

create or replace function public.revoke_device_association(
  p_receiver_id uuid,
  p_phone_id uuid,
  p_source text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare changed integer;
declare revocation_time timestamptz := now();
begin
  if p_source not in ('phone', 'receiver') then raise exception 'invalid source'; end if;
  update public.device_associations
    set revoked_at = revocation_time
    where receiver_id = p_receiver_id and phone_id = p_phone_id and revoked_at is null;
  get diagnostics changed = row_count;
  if changed > 0 then
    insert into public.device_revocations(receiver_id, phone_id, revoked_at, source)
      values (p_receiver_id, p_phone_id, revocation_time, p_source);
  end if;
  return changed > 0;
end;
$$;

revoke all on function public.upsert_device_association(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.revoke_device_association(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_device_association(uuid, uuid, text, text) to service_role;
grant execute on function public.revoke_device_association(uuid, uuid, text) to service_role;
