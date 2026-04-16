-- OpenGeo — datasets, layers, features.
-- A dataset is a logical handle for source data (a shapefile, a drone orthomosaic,
-- an API feed). A layer is a rendered view over a dataset. Features are the
-- individual geometries — stored in a per-layer partition to keep indexes small.

-- --- datasets ---
create type opengeo.dataset_kind as enum (
  'geojson','shapefile','geopackage','csv','parquet',
  'cog','pmtiles','stac',
  'drone_orthomosaic','drone_dsm','drone_dtm','drone_pointcloud'
);

create table if not exists opengeo.datasets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  name text not null,
  kind opengeo.dataset_kind not null,
  source_uri text,
  crs integer,
  bbox geometry(Polygon, 4326),
  metadata jsonb not null default '{}'::jsonb,
  license text,
  attribution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists datasets_project_idx on opengeo.datasets (project_id);
create index if not exists datasets_bbox_gix on opengeo.datasets using gist (bbox);
create index if not exists datasets_metadata_gin on opengeo.datasets using gin (metadata jsonb_path_ops);

-- --- layers ---
create type opengeo.geometry_kind as enum ('point','multipoint','linestring','multilinestring','polygon','multipolygon','geometrycollection','raster');

create table if not exists opengeo.layers (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references opengeo.datasets(id) on delete cascade,
  name text not null,
  geometry_kind opengeo.geometry_kind not null,
  style jsonb not null default '{}'::jsonb,
  feature_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists layers_dataset_idx on opengeo.layers (dataset_id);

-- --- features ---
-- All vector features live in one partition-less table with a layer_id FK.
-- Martin queries this table directly via `layer_id` filter.
create table if not exists opengeo.features (
  id uuid primary key default gen_random_uuid(),
  layer_id uuid not null references opengeo.layers(id) on delete cascade,
  geom geometry(Geometry, 4326) not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists features_layer_idx on opengeo.features (layer_id);
create index if not exists features_gix on opengeo.features using gist (geom);
create index if not exists features_props_gin on opengeo.features using gin (properties jsonb_path_ops);

-- Keep layer.feature_count approximately accurate without blocking inserts.
create or replace function opengeo.bump_layer_feature_count()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update opengeo.layers set feature_count = feature_count + 1, updated_at = now() where id = new.layer_id;
  elsif tg_op = 'DELETE' then
    update opengeo.layers set feature_count = greatest(feature_count - 1, 0), updated_at = now() where id = old.layer_id;
  end if;
  return null;
end
$$;

drop trigger if exists features_count_trg on opengeo.features;
create trigger features_count_trg
after insert or delete on opengeo.features
for each row execute function opengeo.bump_layer_feature_count();
