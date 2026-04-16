-- OpenGeo — core multi-tenant schema.
-- Organizations own everything. Members are users scoped to an org with a role.
-- Projects group datasets, layers, maps, and drone flights.

create schema if not exists opengeo;

-- --- orgs ---
create table if not exists opengeo.orgs (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  name text not null,
  plan text not null default 'free' check (plan in ('free','pro','team','enterprise')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --- members ---
create type opengeo.member_role as enum ('owner','admin','editor','viewer');

create table if not exists opengeo.members (
  org_id uuid not null references opengeo.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role opengeo.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists members_user_id_idx on opengeo.members (user_id);

-- --- projects ---
create table if not exists opengeo.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references opengeo.orgs(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$'),
  name text not null,
  visibility text not null default 'private' check (visibility in ('private','org','public')),
  site_geom geometry(Polygon, 4326),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, slug)
);
create index if not exists projects_org_idx on opengeo.projects (org_id);
create index if not exists projects_site_gix on opengeo.projects using gist (site_geom);

-- --- api_keys ---
create table if not exists opengeo.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references opengeo.orgs(id) on delete cascade,
  prefix text not null unique,
  hashed_key text not null,
  scopes text[] not null default array['read']::text[],
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz
);
create index if not exists api_keys_org_idx on opengeo.api_keys (org_id);
