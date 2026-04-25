-- OpenGeo — minimal project dashboard slice.
--
-- This is intentionally not a generic dashboard builder. A project gets at
-- most one public dashboard definition: a PMTiles-backed map layer plus one
-- feature-count metric widget exposed through the existing share-token path.

create table if not exists opengeo.project_dashboards (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  layer_id uuid not null references opengeo.layers(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  metric_kind text not null default 'feature_count'
    check (metric_kind = 'feature_count'),
  is_published boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id)
);

create index if not exists project_dashboards_layer_idx
  on opengeo.project_dashboards (layer_id);
create index if not exists project_dashboards_published_idx
  on opengeo.project_dashboards (project_id)
  where is_published;

alter table opengeo.project_dashboards enable row level security;

drop policy if exists project_dashboards_select on opengeo.project_dashboards;
create policy project_dashboards_select on opengeo.project_dashboards for select
  using (
    opengeo.has_project_access(project_id, 'viewer')
    and opengeo.project_of_layer(layer_id) = project_id
  );

drop policy if exists project_dashboards_admin_write on opengeo.project_dashboards;
create policy project_dashboards_admin_write on opengeo.project_dashboards for all
  using (
    opengeo.has_project_access(project_id, 'admin')
    and opengeo.project_of_layer(layer_id) = project_id
  )
  with check (
    opengeo.has_project_access(project_id, 'admin')
    and opengeo.project_of_layer(layer_id) = project_id
  );

grant select, insert, update, delete on opengeo.project_dashboards
  to authenticated, service_role;
grant select on opengeo.project_dashboards to anon;
