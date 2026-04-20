-- OpenGeo — Phase 2 review fixes.
--
-- This migration closes the correctness/security gaps found after the Phase 2
-- membership, share-link, and diff work:
--   1. Public share routes need the exact matched token row, not just project_id.
--   2. SECURITY DEFINER write RPCs must honor project_members, not org-only roles.
--   3. Server invite routes need controlled auth.users reads without exposing the
--      auth schema through PostgREST.

-- ---------------------------------------------------------------------------
-- 1. Share-token detail resolver
-- ---------------------------------------------------------------------------

create or replace function opengeo.resolve_share_token_detail(p_token text)
returns table (
  token_id uuid,
  project_id uuid,
  scopes text[],
  expires_at timestamptz
)
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
    return;
  end if;

  v_prefix := split_part(p_token, '.', 1);
  if length(v_prefix) = 0 then
    return;
  end if;

  v_hash := encode(digest(p_token, 'sha256'), 'hex');

  select pst.id, pst.project_id, pst.token_hash, pst.scopes, pst.expires_at, pst.revoked_at
    into v_row
    from opengeo.project_share_tokens pst
   where pst.token_prefix = v_prefix
   limit 1;

  if not found then
    return;
  end if;
  if v_row.revoked_at is not null then
    return;
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return;
  end if;
  if v_row.token_hash <> v_hash then
    return;
  end if;

  begin
    update opengeo.project_share_tokens
       set last_used_at = clock_timestamp()
     where id = v_row.id;
  exception when others then
    null;
  end;

  token_id := v_row.id;
  project_id := v_row.project_id;
  scopes := coalesce(v_row.scopes, array[]::text[]);
  expires_at := v_row.expires_at;
  return next;
end;
$$;

grant execute on function opengeo.resolve_share_token_detail(text)
  to anon, authenticated, service_role;

-- Keep the legacy project-id-only RPC working for any callers that have not
-- moved to the scoped/detail contract yet.
create or replace function opengeo.resolve_share_token(p_token text)
returns uuid
language sql
volatile
security definer
set search_path = public, opengeo, extensions
as $$
  select detail.project_id
    from opengeo.resolve_share_token_detail(p_token) detail
   limit 1;
$$;

grant execute on function opengeo.resolve_share_token(text)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Project-level authorization for write RPCs
-- ---------------------------------------------------------------------------

create or replace function opengeo.ingest_geojson(
  p_project_id uuid,
  p_name text,
  p_feature_collection jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, opengeo
as $$
declare
  v_project_exists boolean;
  v_dataset_id uuid;
  v_layer_id uuid;
  v_kind opengeo.geometry_kind;
  v_geom_type text;
  v_features jsonb;
  v_inserted bigint;
begin
  select exists (select 1 from opengeo.projects p where p.id = p_project_id)
    into v_project_exists;
  if not v_project_exists then
    raise exception 'Project % not found.', p_project_id using errcode = '22023';
  end if;
  if not opengeo.has_project_access(p_project_id, 'editor') then
    raise exception 'Not authorized to write to project %.', p_project_id using errcode = '42501';
  end if;

  if p_feature_collection is null
     or p_feature_collection->>'type' <> 'FeatureCollection'
     or jsonb_typeof(p_feature_collection->'features') <> 'array' then
    raise exception 'Input must be a GeoJSON FeatureCollection.' using errcode = '22023';
  end if;

  v_features := p_feature_collection->'features';
  if jsonb_array_length(v_features) = 0 then
    raise exception 'FeatureCollection has no features.' using errcode = '22023';
  end if;

  v_geom_type := lower(coalesce(
    v_features->0->'geometry'->>'type',
    'geometrycollection'
  ));
  v_kind := case v_geom_type
    when 'point' then 'point'::opengeo.geometry_kind
    when 'multipoint' then 'multipoint'::opengeo.geometry_kind
    when 'linestring' then 'linestring'::opengeo.geometry_kind
    when 'multilinestring' then 'multilinestring'::opengeo.geometry_kind
    when 'polygon' then 'polygon'::opengeo.geometry_kind
    when 'multipolygon' then 'multipolygon'::opengeo.geometry_kind
    else 'geometrycollection'::opengeo.geometry_kind
  end;

  insert into opengeo.datasets (project_id, name, kind, crs)
  values (p_project_id, p_name, 'geojson'::opengeo.dataset_kind, 4326)
  returning id into v_dataset_id;

  insert into opengeo.layers (dataset_id, name, geometry_kind)
  values (v_dataset_id, p_name, v_kind)
  returning id into v_layer_id;

  with incoming as (
    select
      elem->'geometry' as geometry,
      coalesce(elem->'properties', '{}'::jsonb) as properties
    from jsonb_array_elements(v_features) elem
    where jsonb_typeof(elem->'geometry') = 'object'
  ),
  parsed as (
    select
      st_setsrid(st_geomfromgeojson(geometry::text), 4326) as geom,
      properties
    from incoming
  )
  insert into opengeo.features (layer_id, geom, properties)
  select v_layer_id, geom, properties
  from parsed
  where geom is not null;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    raise exception 'No valid features parsed from FeatureCollection.' using errcode = '22023';
  end if;

  update opengeo.layers set feature_count = v_inserted where id = v_layer_id;

  update opengeo.datasets
  set bbox = (
    with extent as (
      select st_extent(geom)::box2d as box
      from opengeo.features
      where layer_id = v_layer_id
    )
    select case
      when box is null then null
      else st_makeenvelope(
        st_xmin(box),
        st_ymin(box),
        st_xmax(box),
        st_ymax(box),
        4326
      )::geometry(Polygon, 4326)
    end
    from extent
  )
  where id = v_dataset_id;

  return v_layer_id;
end;
$$;

grant execute on function opengeo.ingest_geojson(uuid, text, jsonb)
  to authenticated, service_role;

create or replace function opengeo.set_extraction_qa(
  p_extraction_id uuid,
  p_qa_status text
)
returns uuid
language plpgsql
security definer
set search_path = opengeo, public
as $$
declare
  v_project_id uuid;
  v_layer_id uuid;
begin
  if p_qa_status not in ('pending','ai_ok','human_reviewed','rejected') then
    raise exception 'Invalid qa_status: %', p_qa_status using errcode = '22023';
  end if;

  select df.project_id, e.output_layer_id
    into v_project_id, v_layer_id
    from opengeo.extractions e
    join opengeo.orthomosaics o on o.id = e.orthomosaic_id
    join opengeo.drone_flights df on df.id = o.flight_id
   where e.id = p_extraction_id;

  if v_project_id is null then
    raise exception 'Extraction % not found.', p_extraction_id using errcode = 'P0002';
  end if;

  if not opengeo.has_project_access(v_project_id, 'editor') then
    raise exception 'Not authorized to review extractions in project %.', v_project_id
      using errcode = '42501';
  end if;

  update opengeo.extractions
     set qa_status = p_qa_status::opengeo.extraction_qa
   where id = p_extraction_id;

  return v_layer_id;
end;
$$;

revoke all on function opengeo.set_extraction_qa(uuid, text) from public;
grant execute on function opengeo.set_extraction_qa(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Controlled auth.users lookups for server routes
-- ---------------------------------------------------------------------------

create or replace function opengeo.auth_user_by_email(p_email text)
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, opengeo, auth
as $$
  select u.id, u.email::text
    from auth.users u
   where lower(u.email) = lower(p_email)
   order by u.created_at asc
   limit 1;
$$;

create or replace function opengeo.auth_users_by_ids(p_user_ids uuid[])
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, opengeo, auth
as $$
  select u.id, u.email::text
    from auth.users u
   where p_user_ids is not null
     and u.id = any(p_user_ids);
$$;

revoke all on function opengeo.auth_user_by_email(text) from public, anon, authenticated;
revoke all on function opengeo.auth_users_by_ids(uuid[]) from public, anon, authenticated;
grant execute on function opengeo.auth_user_by_email(text) to service_role;
grant execute on function opengeo.auth_users_by_ids(uuid[]) to service_role;
