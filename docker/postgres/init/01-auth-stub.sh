#!/usr/bin/env bash
# Stub the pieces of the `auth` schema our migrations reference. Hosted
# Supabase ships a real implementation via GoTrue; local Postgres does not.
# We only need enough surface area for foreign keys to resolve and for the
# seed/login flows to work end-to-end. This is a DEV-ONLY convenience —
# production/staging should point at real Supabase.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    encrypted_password text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  -- Authenticated role that RLS policies expect. The migrations grant
  -- execute on helper functions to this role.
  do \$\$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
  end
  \$\$;

  grant usage on schema auth to authenticated, service_role, anon;
EOSQL
