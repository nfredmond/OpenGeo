-- OpenGeo - narrow dashboard widget foundation.
--
-- Keep one dashboard definition per project, but make the definition explicit:
-- exactly one PMTiles map widget plus one or more constrained feature-count
-- chart widgets. This avoids introducing a generic dashboard builder while
-- giving the API and public share path a versioned widget payload.

alter table opengeo.project_dashboards
  add column if not exists schema_version integer not null default 1,
  add column if not exists widgets jsonb not null default '[]'::jsonb;

update opengeo.project_dashboards
   set widgets = jsonb_build_array(
     jsonb_build_object(
       'id', 'map',
       'type', 'pmtiles_map',
       'title', 'Map',
       'layerId', layer_id,
       'zoomToLayer', true
     ),
     jsonb_build_object(
       'id', 'feature-count',
       'type', 'feature_count_chart',
       'title', 'Features',
       'layerId', layer_id,
       'display', 'stat'
     )
   )
 where widgets = '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'project_dashboards_widgets_array'
       and conrelid = 'opengeo.project_dashboards'::regclass
  ) then
    alter table opengeo.project_dashboards
      add constraint project_dashboards_widgets_array
      check (jsonb_typeof(widgets) = 'array');
  end if;
end
$$;

comment on column opengeo.project_dashboards.widgets is
  'Versioned narrow dashboard widgets: one pmtiles_map plus feature_count_chart widgets.';
