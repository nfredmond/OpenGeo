-- OpenGeo — single-call GeoJSON ingest.
-- PostgREST can't easily express batched geometry inserts (needs
-- ST_GeomFromGeoJSON). This RPC accepts a GeoJSON FeatureCollection and writes
-- the dataset, layer, and features in one transaction. Runs as SECURITY
-- DEFINER but self-authorizes via opengeo.can_edit() so the caller must still
-- have an editor+ role on the target project.

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
  v_org uuid;
  v_dataset_id uuid;
  v_layer_id uuid;
  v_kind opengeo.geometry_kind;
  v_geom_type text;
  v_features jsonb;
  v_inserted bigint;
begin
  v_org := opengeo.org_of_project(p_project_id);
  if v_org is null then
    raise exception 'Project % not found.', p_project_id using errcode = '22023';
  end if;
  if not opengeo.can_edit(v_org) then
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

  -- Derive a representative geometry kind from the first feature.
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

  -- Batch insert all features. Skip rows where the geometry is missing or
  -- fails to parse rather than aborting the whole upload.
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
    -- Roll back the empty dataset/layer — nothing usable landed.
    raise exception 'No valid features parsed from FeatureCollection.' using errcode = '22023';
  end if;

  -- Maintain the running count even though the trigger keeps it in sync;
  -- set it explicitly so the row reflects the bulk insert immediately.
  update opengeo.layers set feature_count = v_inserted where id = v_layer_id;

  -- Derive dataset bbox from feature extents.
  update opengeo.datasets
  set bbox = (
    select st_envelope(st_collect(geom))::geometry(Polygon, 4326)
    from opengeo.features
    where layer_id = v_layer_id
  )
  where id = v_dataset_id;

  return v_layer_id;
end;
$$;

grant execute on function opengeo.ingest_geojson(uuid, text, jsonb) to authenticated;

-- And the flip side: stream a layer back as a FeatureCollection for the
-- map viewer. Runs through RLS because we do NOT use security definer — the
-- query relies on the caller's policies on opengeo.features.
create or replace function opengeo.layer_as_geojson(p_layer_id uuid)
returns jsonb
language sql
stable
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

grant execute on function opengeo.layer_as_geojson(uuid) to authenticated, service_role;
