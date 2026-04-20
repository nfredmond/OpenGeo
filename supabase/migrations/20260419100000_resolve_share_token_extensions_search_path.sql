-- OpenGeo — 2026-04-19 hosted-Supabase bug: resolve_share_token can't find digest().
--
-- On local docker-compose Postgres, `create extension pgcrypto` installs into
-- `public` by default, so `digest()` is always reachable through the function's
-- `search_path = public, opengeo`. Hosted Supabase installs pgcrypto into the
-- `extensions` schema instead — which isn't in our search path — so the very
-- first resolve call hits:
--
--   ERROR 42883: function digest(text, unknown) does not exist
--
-- The inner `exception when others` block on the `last_used_at` update masked
-- nothing here; the `digest` call happens before that, so the function bubbles
-- the error back to PostgREST as a 500. Anon visitors at /p/<token> never get
-- past resolve → the whole public share flow is broken in production.
--
-- Fix: add `extensions` to the function's search path. Safe because it's the
-- Supabase-managed schema that ships pgcrypto (and citext, uuid-ossp, etc.).
-- Local dev still works because Postgres silently ignores missing schemas in
-- `search_path`.

create or replace function opengeo.resolve_share_token(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, opengeo, extensions
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
  if v_row.token_hash <> v_hash then
    return null;
  end if;

  begin
    update opengeo.project_share_tokens
       set last_used_at = clock_timestamp()
     where id = v_row.id;
  exception when others then
    null;
  end;

  return v_row.project_id;
end;
$$;

grant execute on function opengeo.resolve_share_token(text)
  to anon, authenticated, service_role;
