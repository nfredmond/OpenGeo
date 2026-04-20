-- OpenGeo — 2026-04-19 pin `search_path` on every function the Supabase
-- advisor flagged under `function_search_path_mutable`.
--
-- Why this matters
-- ----------------
-- A function without an explicit `set search_path` clause resolves
-- unqualified schema references through the caller's runtime search_path.
-- That opens two failure modes:
--
--   1. Hosted-vs-local drift. Local docker-compose Postgres installs
--      pgcrypto into `public` by default; hosted Supabase installs it into
--      the `extensions` schema. A SECURITY DEFINER function whose search
--      path doesn't include `extensions` can't see `digest()` on hosted.
--      We already hit this: `resolve_share_token` silently 500'd on the
--      public share path because its search_path was `public, opengeo`
--      and the anon caller never got past the `digest(..., 'sha256')` call.
--      Fixed separately in commit `dd52f11` + migration
--      `20260419100000_resolve_share_token_extensions_search_path.sql`.
--
--   2. Function-hijacking via schema shadowing. A caller with CREATE on
--      a schema ahead of ours in the search path can shadow
--      `opengeo.features` (or similar) with a malicious view. For the
--      helpers below, this is currently mitigated because every table
--      reference is already schema-qualified (`opengeo.foo`), so this
--      pass is defense in depth rather than a live fix — but the advisor
--      is right that the pattern is unsafe and one refactor away from
--      being exploitable.
--
-- Why `public, opengeo` and not empty
-- ------------------------------------
-- The helpers below use `auth.uid()` (schema-qualified already) and
-- `opengeo.foo` (schema-qualified already). Setting `search_path = ''`
-- would work functionally but force any future maintainer who adds an
-- unqualified reference inside one of these helpers to get a cryptic
-- "function does not exist" error. `public, opengeo` is the pattern the
-- rest of the codebase uses (see `auth_bootstrap.sql`, `share_tokens.sql`,
-- `schema_grants_and_resolve_fix.sql`) and matches the default privilege
-- surface on hosted Supabase.
--
-- What's intentionally not in this sweep
-- --------------------------------------
-- - `resolve_share_token` — already fixed in `20260419100000_...sql` with
--   a wider search_path of `public, opengeo, extensions` because it
--   calls `digest()`.
-- - Extensions-in-public warnings (`postgis`, `postgis_raster`, `vector`).
--   Moving an installed extension between schemas breaks every index,
--   policy, and function that references its functions. Deferred until
--   we have a migration strategy that doesn't disrupt hosted storage.
-- - `public.spatial_ref_sys` RLS — PostGIS system table. Read-only
--   reference data; anon read is safe and expected.

-- ---------------------------------------------------------------------------
-- Helpers from `20260416120400_rls.sql`
-- ---------------------------------------------------------------------------

create or replace function opengeo.is_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org and user_id = auth.uid()
  );
$$;

create or replace function opengeo.can_edit(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org
      and user_id = auth.uid()
      and role in ('owner','admin','editor')
  );
$$;

create or replace function opengeo.is_admin(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org
      and user_id = auth.uid()
      and role in ('owner','admin')
  );
$$;

create or replace function opengeo.org_of_project(target_project uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select org_id from opengeo.projects where id = target_project;
$$;

create or replace function opengeo.org_of_dataset(target_dataset uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select p.org_id
    from opengeo.datasets d
    join opengeo.projects p on p.id = d.project_id
   where d.id = target_dataset;
$$;

create or replace function opengeo.org_of_layer(target_layer uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select p.org_id
    from opengeo.layers l
    join opengeo.datasets d on d.id = l.dataset_id
    join opengeo.projects p on p.id = d.project_id
   where l.id = target_layer;
$$;

-- ---------------------------------------------------------------------------
-- Helpers from `20260417120100_project_membership.sql`
-- ---------------------------------------------------------------------------

create or replace function opengeo.project_of_dataset(target_dataset uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select project_id from opengeo.datasets where id = target_dataset;
$$;

create or replace function opengeo.project_of_layer(target_layer uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select d.project_id
    from opengeo.layers l
    join opengeo.datasets d on d.id = l.dataset_id
   where l.id = target_layer;
$$;

create or replace function opengeo.project_of_flight(target_flight uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select project_id from opengeo.drone_flights where id = target_flight;
$$;

create or replace function opengeo.project_of_orthomosaic(target_ortho uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select df.project_id
    from opengeo.orthomosaics o
    join opengeo.drone_flights df on df.id = o.flight_id
   where o.id = target_ortho;
$$;

create or replace function opengeo.project_of_extraction(target_extraction uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select df.project_id
    from opengeo.extractions e
    join opengeo.orthomosaics o on o.id = e.orthomosaic_id
    join opengeo.drone_flights df on df.id = o.flight_id
   where e.id = target_extraction;
$$;

create or replace function opengeo.has_project_access(
  target_project uuid,
  min_role opengeo.member_role default 'viewer'
) returns boolean
language sql
stable
security definer
set search_path = public, opengeo
as $$
  with required as (
    select case min_role
      when 'viewer' then 1
      when 'editor' then 2
      when 'admin'  then 3
      when 'owner'  then 4
    end as rank
  ),
  caller_org as (
    select m.role,
      case m.role
        when 'viewer' then 1
        when 'editor' then 2
        when 'admin'  then 3
        when 'owner'  then 4
      end as rank
      from opengeo.members m
      join opengeo.projects p on p.org_id = m.org_id
     where p.id = target_project and m.user_id = auth.uid()
  ),
  caller_project as (
    select pm.role,
      case pm.role
        when 'viewer' then 1
        when 'editor' then 2
        when 'admin'  then 3
        when 'owner'  then 4
      end as rank
      from opengeo.project_members pm
     where pm.project_id = target_project and pm.user_id = auth.uid()
  )
  select exists (
    select 1 from caller_org, required where caller_org.rank >= required.rank
  ) or exists (
    select 1 from caller_project, required where caller_project.rank >= required.rank
  );
$$;

-- ---------------------------------------------------------------------------
-- SECURITY INVOKER functions also flagged (low-risk but pinned for parity)
-- ---------------------------------------------------------------------------

-- From `20260416120200_data_plane.sql` — trigger function that maintains
-- `layers.feature_count` on `opengeo.features` insert/delete.
create or replace function opengeo.bump_layer_feature_count()
returns trigger
language plpgsql
set search_path = public, opengeo
as $$
begin
  if tg_op = 'INSERT' then
    update opengeo.layers set feature_count = feature_count + 1, updated_at = now() where id = new.layer_id;
  elsif tg_op = 'DELETE' then
    update opengeo.layers set feature_count = greatest(feature_count - 1, 0), updated_at = now() where id = old.layer_id;
  end if;
  return null;
end
$$;

-- From `20260416120700_dataset_upload_rpc.sql` — RLS-bound read helper
-- used by the map viewer. Runs as the caller so RLS still gates access.
create or replace function opengeo.layer_as_geojson(p_layer_id uuid)
returns jsonb
language sql
stable
set search_path = public, opengeo
as $$
  select coalesce(
    jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', f.id,
          'geometry', st_asgeojson(f.geom)::jsonb,
          'properties', f.properties
        )
      ), '[]'::jsonb)
    ),
    jsonb_build_object('type','FeatureCollection','features','[]'::jsonb)
  )
  from opengeo.features f
  where f.layer_id = p_layer_id;
$$;

-- From `20260416120800_mvt_function.sql` — Martin vector-tile entry point.
-- Lives in `public` so Martin's auto-discovery finds it.
create or replace function public.opengeo_layer_mvt(
  z integer,
  x integer,
  y integer,
  query_params json
)
returns bytea
language plpgsql
stable
parallel safe
set search_path = public, opengeo
as $$
declare
  p_layer_id uuid;
  tile_env geometry;
  mvt bytea;
begin
  p_layer_id := nullif(query_params->>'layer_id', '')::uuid;
  if p_layer_id is null then
    return null;
  end if;

  tile_env := st_tileenvelope(z, x, y);

  select into mvt st_asmvt(t, 'layer', 4096, 'geom')
  from (
    select
      st_asmvtgeom(
        st_transform(f.geom, 3857),
        tile_env,
        4096,
        256,
        true
      ) as geom,
      f.id::text as id,
      f.properties
    from opengeo.features f
    where f.layer_id = p_layer_id
      and f.geom && st_transform(tile_env, 4326)
  ) as t
  where t.geom is not null;

  return mvt;
end
$$;
