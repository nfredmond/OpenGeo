-- OpenGeo — 2026-04-18 Phase 2 follow-up fixes surfaced by integration tests.
--
-- Two unrelated bugs came out of walking the Phase 1 + Phase 2 runbook:
--
-- 1. `resolve_share_token(text)` was declared `stable`, which blocks the
--    internal `update ... set last_used_at = now()` statement. Postgres raises
--    (paraphrased) "UPDATE is not allowed in a non-volatile function", the
--    function's own exception handler swallows it, and `last_used_at` silently
--    never moves. Users can still mint + resolve tokens, but operators lose
--    "last resolved" telemetry. Fix: switch to the default volatility.
--
-- 2. The `anon` and `authenticated` roles had no `USAGE` on the `opengeo`
--    schema. Hosted Supabase auto-grants this when you create a new schema
--    via the dashboard, so the remote path has been working by accident.
--    But local docker-compose Postgres (used by the LOCAL_DB_URL-gated
--    integration tests) does not. Result: any role-based RLS test against
--    `opengeo.*` hits "permission denied for schema opengeo" before RLS ever
--    runs. Make the grants explicit so local ≡ production.

-- ---------------------------------------------------------------------------
-- 1. Schema usage + default privileges
-- ---------------------------------------------------------------------------

grant usage on schema opengeo to anon, authenticated, service_role;

-- Every table in `opengeo` already has RLS enabled; granting SELECT /
-- INSERT / UPDATE / DELETE to `authenticated` is safe because policies still
-- govern which rows any given caller can actually touch. `anon` gets SELECT
-- only — the public share path goes through `resolve_share_token` +
-- `supabaseService()`, but keeping anon able to `select` means future anon
-- RPCs don't silently hit a permission wall before RLS runs.
grant select, insert, update, delete on all tables in schema opengeo
  to authenticated;
grant select on all tables in schema opengeo to anon;

-- Sequences backing bigserial / identity columns follow the same rule.
grant usage, select on all sequences in schema opengeo to authenticated;

-- New tables added in later migrations inherit the same default grants so
-- we don't have to remember to re-run this block each time.
alter default privileges in schema opengeo
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema opengeo
  grant select on tables to anon;
alter default privileges in schema opengeo
  grant usage, select on sequences to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rewrite resolve_share_token as volatile so the last_used_at touch sticks
--
-- Also swap `now()` for `clock_timestamp()` when stamping last_used_at.
-- `now()` returns *transaction start time*, which is fine for web requests
-- (each HTTP handler runs its own short transaction) but breaks under test
-- harnesses that wrap every test in a single long-running transaction: every
-- resolve in the suite would stamp the same transaction-start instant, and
-- assertions comparing `last_used_at` against a per-test `new Date()` flake.
-- `clock_timestamp()` reads wall clock on every call, so both shapes agree.
-- We still use `now()` in the `expires_at <= now()` check — comparing against
-- transaction start is the safer read-stability choice there.
-- ---------------------------------------------------------------------------

create or replace function opengeo.resolve_share_token(p_token text)
returns uuid
language plpgsql
volatile
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
