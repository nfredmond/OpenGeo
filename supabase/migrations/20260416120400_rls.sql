-- OpenGeo — Row Level Security.
-- Baseline: a user can see a row iff they are a member of the row's org.
-- Writes are gated by role (owner/admin/editor, viewer cannot write).

-- Helper: is the current user a member of this org?
create or replace function opengeo.is_member(target_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org and user_id = auth.uid()
  );
$$;

-- Helper: does the current user have at least editor role?
create or replace function opengeo.can_edit(target_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org
      and user_id = auth.uid()
      and role in ('owner','admin','editor')
  );
$$;

-- Helper: owner/admin-only (for org settings, API keys, billing).
create or replace function opengeo.is_admin(target_org uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from opengeo.members
    where org_id = target_org
      and user_id = auth.uid()
      and role in ('owner','admin')
  );
$$;

-- Helper: resolve org_id from a project_id (used by downstream RLS policies).
create or replace function opengeo.org_of_project(target_project uuid)
returns uuid language sql stable security definer as $$
  select org_id from opengeo.projects where id = target_project;
$$;

-- Helper: resolve org_id from a dataset_id.
create or replace function opengeo.org_of_dataset(target_dataset uuid)
returns uuid language sql stable security definer as $$
  select p.org_id
    from opengeo.datasets d
    join opengeo.projects p on p.id = d.project_id
   where d.id = target_dataset;
$$;

-- Helper: resolve org_id from a layer_id.
create or replace function opengeo.org_of_layer(target_layer uuid)
returns uuid language sql stable security definer as $$
  select p.org_id
    from opengeo.layers l
    join opengeo.datasets d on d.id = l.dataset_id
    join opengeo.projects p on p.id = d.project_id
   where l.id = target_layer;
$$;

-- Enable RLS on every tenant table.
alter table opengeo.orgs enable row level security;
alter table opengeo.members enable row level security;
alter table opengeo.projects enable row level security;
alter table opengeo.api_keys enable row level security;
alter table opengeo.datasets enable row level security;
alter table opengeo.layers enable row level security;
alter table opengeo.features enable row level security;
alter table opengeo.drone_flights enable row level security;
alter table opengeo.orthomosaics enable row level security;
alter table opengeo.extractions enable row level security;
alter table opengeo.embeddings enable row level security;
alter table opengeo.ai_events enable row level security;

-- --- orgs ---
-- Members can read their orgs. Only admins can write.
drop policy if exists orgs_select on opengeo.orgs;
create policy orgs_select on opengeo.orgs for select
  using (opengeo.is_member(id));

drop policy if exists orgs_update on opengeo.orgs;
create policy orgs_update on opengeo.orgs for update
  using (opengeo.is_admin(id));

-- Signup flow creates the org server-side with the service-role key;
-- no INSERT policy for end users.

-- --- members ---
drop policy if exists members_select on opengeo.members;
create policy members_select on opengeo.members for select
  using (user_id = auth.uid() or opengeo.is_member(org_id));

drop policy if exists members_admin_write on opengeo.members;
create policy members_admin_write on opengeo.members for all
  using (opengeo.is_admin(org_id))
  with check (opengeo.is_admin(org_id));

-- --- projects ---
drop policy if exists projects_select on opengeo.projects;
create policy projects_select on opengeo.projects for select
  using (
    visibility = 'public'
    or (visibility = 'org' and opengeo.is_member(org_id))
    or (visibility = 'private' and opengeo.is_member(org_id))
  );

drop policy if exists projects_write on opengeo.projects;
create policy projects_write on opengeo.projects for all
  using (opengeo.can_edit(org_id))
  with check (opengeo.can_edit(org_id));

-- --- api_keys ---
-- Only admins see or mutate API keys.
drop policy if exists api_keys_admin on opengeo.api_keys;
create policy api_keys_admin on opengeo.api_keys for all
  using (opengeo.is_admin(org_id))
  with check (opengeo.is_admin(org_id));

-- --- datasets ---
drop policy if exists datasets_select on opengeo.datasets;
create policy datasets_select on opengeo.datasets for select
  using (opengeo.is_member(opengeo.org_of_project(project_id)));

drop policy if exists datasets_write on opengeo.datasets;
create policy datasets_write on opengeo.datasets for all
  using (opengeo.can_edit(opengeo.org_of_project(project_id)))
  with check (opengeo.can_edit(opengeo.org_of_project(project_id)));

-- --- layers ---
drop policy if exists layers_select on opengeo.layers;
create policy layers_select on opengeo.layers for select
  using (opengeo.is_member(opengeo.org_of_dataset(dataset_id)));

drop policy if exists layers_write on opengeo.layers;
create policy layers_write on opengeo.layers for all
  using (opengeo.can_edit(opengeo.org_of_dataset(dataset_id)))
  with check (opengeo.can_edit(opengeo.org_of_dataset(dataset_id)));

-- --- features ---
drop policy if exists features_select on opengeo.features;
create policy features_select on opengeo.features for select
  using (opengeo.is_member(opengeo.org_of_layer(layer_id)));

drop policy if exists features_write on opengeo.features;
create policy features_write on opengeo.features for all
  using (opengeo.can_edit(opengeo.org_of_layer(layer_id)))
  with check (opengeo.can_edit(opengeo.org_of_layer(layer_id)));

-- --- drone_flights ---
drop policy if exists drone_flights_select on opengeo.drone_flights;
create policy drone_flights_select on opengeo.drone_flights for select
  using (opengeo.is_member(opengeo.org_of_project(project_id)));

drop policy if exists drone_flights_write on opengeo.drone_flights;
create policy drone_flights_write on opengeo.drone_flights for all
  using (opengeo.can_edit(opengeo.org_of_project(project_id)))
  with check (opengeo.can_edit(opengeo.org_of_project(project_id)));

-- --- orthomosaics ---
drop policy if exists orthomosaics_select on opengeo.orthomosaics;
create policy orthomosaics_select on opengeo.orthomosaics for select
  using (
    opengeo.is_member(
      opengeo.org_of_project(
        (select project_id from opengeo.drone_flights where id = flight_id)
      )
    )
  );

drop policy if exists orthomosaics_write on opengeo.orthomosaics;
create policy orthomosaics_write on opengeo.orthomosaics for all
  using (
    opengeo.can_edit(
      opengeo.org_of_project(
        (select project_id from opengeo.drone_flights where id = flight_id)
      )
    )
  )
  with check (
    opengeo.can_edit(
      opengeo.org_of_project(
        (select project_id from opengeo.drone_flights where id = flight_id)
      )
    )
  );

-- --- extractions ---
drop policy if exists extractions_select on opengeo.extractions;
create policy extractions_select on opengeo.extractions for select
  using (
    opengeo.is_member(
      opengeo.org_of_project(
        (select df.project_id
           from opengeo.orthomosaics o
           join opengeo.drone_flights df on df.id = o.flight_id
          where o.id = orthomosaic_id)
      )
    )
  );

-- Writes on extractions go through the service role (workers), not end users.

-- --- embeddings ---
-- Embeddings do not carry an org_id directly; writes via service role only.
drop policy if exists embeddings_read on opengeo.embeddings;
create policy embeddings_read on opengeo.embeddings for select using (true);

-- --- ai_events ---
drop policy if exists ai_events_read on opengeo.ai_events;
create policy ai_events_read on opengeo.ai_events for select
  using (opengeo.is_admin(org_id));
-- Writes via service role only.
