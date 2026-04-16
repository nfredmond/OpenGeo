-- OpenGeo — vector tile function for Martin.
--
-- Martin auto-discovers PL/pgSQL functions with the signature
-- `f(z integer, x integer, y integer, query_params json)` returning `bytea`
-- and exposes them as tile sources. We use one parameterized function keyed
-- by `layer_id` so a single Martin source can serve tiles for every layer
-- the caller is allowed to read.
--
-- Security note: in Supabase/hosted deployments, Martin connects as a role
-- that is NOT the owner of `opengeo.features`, so RLS applies — the tile
-- function only returns rows the Martin role can see. Locally, the
-- `opengeo` role owns the schema and bypasses RLS; that's fine for dev.

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

comment on function public.opengeo_layer_mvt is
  'Martin vector-tile function. Query param: layer_id=<uuid>. Returns MVT bytes of opengeo.features filtered by layer_id, clipped to tile envelope.';

-- Small layers are still served as GeoJSON for editing workflows, but large
-- layers should use Martin. Expose a helper that returns a count so the
-- client can pick a rendering path without a second roundtrip.
create or replace function opengeo.layer_tileable(p_layer_id uuid)
returns table (feature_count bigint, geometry_kind text)
language sql
stable
security definer
set search_path = opengeo, public
as $$
  select coalesce(l.feature_count, 0)::bigint, l.geometry_kind::text
  from opengeo.layers l
  where l.id = p_layer_id
    and opengeo.is_member(opengeo.org_of_layer(l.id))
$$;

grant execute on function opengeo.layer_tileable(uuid) to authenticated, anon;
grant execute on function public.opengeo_layer_mvt(integer, integer, integer, json) to authenticated, anon;
