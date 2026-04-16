-- OpenGeo — 00 extensions.
-- Enable the four database extensions the platform depends on.
-- Run order matters: postgis before postgis_raster; pgcrypto for gen_random_uuid();
-- vector for semantic search.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists postgis;
create extension if not exists postgis_raster;
create extension if not exists vector;

-- PostGIS spatial_ref_sys should already be populated; assert EPSG:4326 is present.
do $$
begin
  if not exists (select 1 from public.spatial_ref_sys where srid = 4326) then
    raise exception 'EPSG:4326 missing from spatial_ref_sys — PostGIS install is incomplete';
  end if;
end
$$;
