-- OpenGeo — Phase 2 Step 2: public per-project share tokens.
--
-- A share token is a capability: possession == read access to a specific
-- project's layers and orthomosaics (scoped). No account required. Use case:
-- a planner sends "here's the draft RTP buildout map" to an anon audience.
--
-- Design mirrors `opengeo.api_keys` (existing precedent): we store a short
-- `token_prefix` (displayed in the admin UI) + a sha256 hash of the full
-- token. The secret itself is shown exactly once at mint time. Lookups go
-- by prefix (indexed) and compare the hash in constant time.
--
-- All token resolution goes through the SECURITY DEFINER RPC
-- `resolve_share_token(p_token text)` which also checks expiry + revocation.
-- Mint / list / revoke are gated at `has_project_access(project_id, 'admin')`.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table if not exists opengeo.project_share_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  token_prefix text not null unique,
  token_hash text not null,
  scopes text[] not null default array['read:layers','read:orthomosaics']::text[],
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists project_share_tokens_project_idx
  on opengeo.project_share_tokens (project_id);
create index if not exists project_share_tokens_active_idx
  on opengeo.project_share_tokens (project_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- 2. Token resolver (anon-callable; bypasses RLS via SECURITY DEFINER)
-- ---------------------------------------------------------------------------
-- Token format: "<prefix>.<secret>" where prefix is 10 chars of url-safe
-- base64 and secret is 32 bytes base64url-encoded. We split on the dot, look
-- up by prefix, then compare the sha256 of the full token in constant time.
create or replace function opengeo.resolve_share_token(p_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, opengeo
as $$
declare
  v_prefix text;
  v_hash text;
  v_row record;
begin
  if p_token is null or length(p_token) < 12 then
    return null;
  end if;

  v_prefix := split_part(p_token, '.', 1);
  if length(v_prefix) = 0 then
    return null;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select id, project_id, token_hash, expires_at, revoked_at
    into v_row
    from opengeo.project_share_tokens
   where token_prefix = v_prefix
   limit 1;

  if not found then
    return null;
  end if;
  if v_row.revoked_at is not null then
    return null;
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return null;
  end if;
  -- Constant-time-ish compare: Postgres string equality short-circuits, but
  -- since we only reach this after a prefix match the timing leak is minimal
  -- and doesn't grant any useful oracle.
  if v_row.token_hash <> v_hash then
    return null;
  end if;

  -- Best-effort last_used touch. Swallow errors (e.g. read-only replica).
  begin
    update opengeo.project_share_tokens
       set last_used_at = now()
     where id = v_row.id;
  exception when others then
    null;
  end;

  return v_row.project_id;
end;
$$;

grant execute on function opengeo.resolve_share_token(text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. RLS — mint / list / revoke gated to project admins
-- ---------------------------------------------------------------------------

alter table opengeo.project_share_tokens enable row level security;

drop policy if exists project_share_tokens_admin on opengeo.project_share_tokens;
create policy project_share_tokens_admin on opengeo.project_share_tokens for all
  using (opengeo.has_project_access(project_id, 'admin'))
  with check (opengeo.has_project_access(project_id, 'admin'));
