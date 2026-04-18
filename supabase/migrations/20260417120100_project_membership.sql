-- OpenGeo — Phase 2 Step 1: per-project membership + invitations.
--
-- Today the RLS model is org-scoped: you either belong to an org (viewer+) or
-- you see nothing. Consulting workflows need finer control — a project owner
-- should be able to invite a single collaborator to a single project without
-- granting them access to the rest of the org. This migration adds:
--
--   1. `project_members`     — per-project membership rows (separate from org membership)
--   2. `project_invitations` — pending invitations keyed by email
--   3. `has_project_access(project_id, min_role)` — unified RLS gate that resolves
--      to true when the caller is (a) an org member of the project's org with the
--      required role, OR (b) has a direct project_members row with the required role.
--   4. Widened SELECT/write policies on projects, datasets, layers, features,
--      drone_flights, orthomosaics, extractions so invited collaborators can read
--      and edit within the project they were invited to.
--   5. A patched `handle_new_auth_user` trigger that routes invitees into their
--      invited projects instead of auto-creating a personal org.
--
-- `ai_events` stays org-scoped deliberately (audit log is a privileged read;
-- don't expose cross-org prompts to a single-project collaborator).

-- ---------------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------------

create table if not exists opengeo.project_members (
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role opengeo.member_role not null default 'viewer',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists project_members_user_idx
  on opengeo.project_members (user_id);

create table if not exists opengeo.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  email text not null check (length(email) between 3 and 254),
  role opengeo.member_role not null default 'viewer',
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
-- Normalize email for lookups; the trigger and routes always compare lower().
create index if not exists project_invitations_email_idx
  on opengeo.project_invitations (lower(email));
create index if not exists project_invitations_project_idx
  on opengeo.project_invitations (project_id);
-- One pending invite per (project, email). Accepted invites are historical
-- records so we don't uniq on them.
create unique index if not exists project_invitations_pending_uq
  on opengeo.project_invitations (project_id, lower(email))
  where accepted_at is null;

-- ---------------------------------------------------------------------------
-- 2. Project resolvers (mirror the existing org_of_* pattern)
-- ---------------------------------------------------------------------------

create or replace function opengeo.project_of_dataset(target_dataset uuid)
returns uuid language sql stable security definer as $$
  select project_id from opengeo.datasets where id = target_dataset;
$$;

create or replace function opengeo.project_of_layer(target_layer uuid)
returns uuid language sql stable security definer as $$
  select d.project_id
    from opengeo.layers l
    join opengeo.datasets d on d.id = l.dataset_id
   where l.id = target_layer;
$$;

create or replace function opengeo.project_of_flight(target_flight uuid)
returns uuid language sql stable security definer as $$
  select project_id from opengeo.drone_flights where id = target_flight;
$$;

create or replace function opengeo.project_of_orthomosaic(target_ortho uuid)
returns uuid language sql stable security definer as $$
  select df.project_id
    from opengeo.orthomosaics o
    join opengeo.drone_flights df on df.id = o.flight_id
   where o.id = target_ortho;
$$;

create or replace function opengeo.project_of_extraction(target_extraction uuid)
returns uuid language sql stable security definer as $$
  select df.project_id
    from opengeo.extractions e
    join opengeo.orthomosaics o on o.id = e.orthomosaic_id
    join opengeo.drone_flights df on df.id = o.flight_id
   where e.id = target_extraction;
$$;

-- ---------------------------------------------------------------------------
-- 3. has_project_access — the new unified gate
-- ---------------------------------------------------------------------------
-- Role rank:   owner=4 > admin=3 > editor=2 > viewer=1.
-- Returns true if the caller has a matching-or-higher role via EITHER the
-- org-level membership OR a direct project_members row.
create or replace function opengeo.has_project_access(
  target_project uuid,
  min_role opengeo.member_role default 'viewer'
) returns boolean
language sql stable security definer as $$
  with required as (
    select case min_role
      when 'owner'  then 4
      when 'admin'  then 3
      when 'editor' then 2
      when 'viewer' then 1
    end as rank
  ),
  project_org as (
    select org_id from opengeo.projects where id = target_project
  ),
  effective as (
    select case m.role
      when 'owner'  then 4
      when 'admin'  then 3
      when 'editor' then 2
      when 'viewer' then 1
    end as rank
    from opengeo.members m
    where m.user_id = auth.uid()
      and m.org_id  = (select org_id from project_org)
    union all
    select case pm.role
      when 'owner'  then 4
      when 'admin'  then 3
      when 'editor' then 2
      when 'viewer' then 1
    end
    from opengeo.project_members pm
    where pm.user_id = auth.uid()
      and pm.project_id = target_project
  )
  select exists (
    select 1 from effective, required
     where effective.rank >= required.rank
  );
$$;

grant execute on function opengeo.has_project_access(uuid, opengeo.member_role)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Widen RLS policies to use has_project_access
-- ---------------------------------------------------------------------------

-- --- projects ---
drop policy if exists projects_select on opengeo.projects;
create policy projects_select on opengeo.projects for select
  using (
    visibility = 'public'
    or opengeo.has_project_access(id, 'viewer')
  );

drop policy if exists projects_write on opengeo.projects;
create policy projects_write on opengeo.projects for all
  using (opengeo.has_project_access(id, 'editor'))
  with check (opengeo.has_project_access(id, 'editor'));

-- --- datasets ---
drop policy if exists datasets_select on opengeo.datasets;
create policy datasets_select on opengeo.datasets for select
  using (opengeo.has_project_access(project_id, 'viewer'));

drop policy if exists datasets_write on opengeo.datasets;
create policy datasets_write on opengeo.datasets for all
  using (opengeo.has_project_access(project_id, 'editor'))
  with check (opengeo.has_project_access(project_id, 'editor'));

-- --- layers ---
drop policy if exists layers_select on opengeo.layers;
create policy layers_select on opengeo.layers for select
  using (opengeo.has_project_access(opengeo.project_of_dataset(dataset_id), 'viewer'));

drop policy if exists layers_write on opengeo.layers;
create policy layers_write on opengeo.layers for all
  using (opengeo.has_project_access(opengeo.project_of_dataset(dataset_id), 'editor'))
  with check (opengeo.has_project_access(opengeo.project_of_dataset(dataset_id), 'editor'));

-- --- features ---
drop policy if exists features_select on opengeo.features;
create policy features_select on opengeo.features for select
  using (opengeo.has_project_access(opengeo.project_of_layer(layer_id), 'viewer'));

drop policy if exists features_write on opengeo.features;
create policy features_write on opengeo.features for all
  using (opengeo.has_project_access(opengeo.project_of_layer(layer_id), 'editor'))
  with check (opengeo.has_project_access(opengeo.project_of_layer(layer_id), 'editor'));

-- --- drone_flights ---
drop policy if exists drone_flights_select on opengeo.drone_flights;
create policy drone_flights_select on opengeo.drone_flights for select
  using (opengeo.has_project_access(project_id, 'viewer'));

drop policy if exists drone_flights_write on opengeo.drone_flights;
create policy drone_flights_write on opengeo.drone_flights for all
  using (opengeo.has_project_access(project_id, 'editor'))
  with check (opengeo.has_project_access(project_id, 'editor'));

-- --- orthomosaics ---
drop policy if exists orthomosaics_select on opengeo.orthomosaics;
create policy orthomosaics_select on opengeo.orthomosaics for select
  using (opengeo.has_project_access(opengeo.project_of_flight(flight_id), 'viewer'));

drop policy if exists orthomosaics_write on opengeo.orthomosaics;
create policy orthomosaics_write on opengeo.orthomosaics for all
  using (opengeo.has_project_access(opengeo.project_of_flight(flight_id), 'editor'))
  with check (opengeo.has_project_access(opengeo.project_of_flight(flight_id), 'editor'));

-- --- extractions ---
-- Reads open to viewers; writes still go through the service role (no policy).
drop policy if exists extractions_select on opengeo.extractions;
create policy extractions_select on opengeo.extractions for select
  using (opengeo.has_project_access(opengeo.project_of_orthomosaic(orthomosaic_id), 'viewer'));

-- ---------------------------------------------------------------------------
-- 5. RLS on the new membership + invitation tables
-- ---------------------------------------------------------------------------

alter table opengeo.project_members enable row level security;
alter table opengeo.project_invitations enable row level security;

-- project_members: any member of the project can see fellow members; only
-- admins/owners can mutate.
drop policy if exists project_members_select on opengeo.project_members;
create policy project_members_select on opengeo.project_members for select
  using (opengeo.has_project_access(project_id, 'viewer'));

drop policy if exists project_members_admin_write on opengeo.project_members;
create policy project_members_admin_write on opengeo.project_members for all
  using (opengeo.has_project_access(project_id, 'admin'))
  with check (opengeo.has_project_access(project_id, 'admin'));

-- project_invitations: admins see + mutate. Service role handles the signup-time
-- writes inside the auth trigger (SECURITY DEFINER bypasses RLS).
drop policy if exists project_invitations_admin on opengeo.project_invitations;
create policy project_invitations_admin on opengeo.project_invitations for all
  using (opengeo.has_project_access(project_id, 'admin'))
  with check (opengeo.has_project_access(project_id, 'admin'));

-- ---------------------------------------------------------------------------
-- 6. Patched signup trigger — invitees skip org bootstrap
-- ---------------------------------------------------------------------------

create or replace function opengeo.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, opengeo
as $$
declare
  v_slug_base text;
  v_slug text;
  v_org_id uuid;
  v_suffix int := 0;
  v_normalized_email text;
  v_has_invites boolean;
begin
  v_normalized_email := lower(coalesce(new.email, ''));

  -- Branch A: this email was invited to one or more projects before signup.
  -- Accept the invitations and stop — no personal org for project-only invitees.
  if v_normalized_email <> '' then
    v_has_invites := exists (
      select 1 from opengeo.project_invitations
       where lower(email) = v_normalized_email
         and accepted_at is null
    );

    if v_has_invites then
      insert into opengeo.project_members (project_id, user_id, role, invited_by)
      select pi.project_id, new.id, pi.role, pi.invited_by
        from opengeo.project_invitations pi
       where lower(pi.email) = v_normalized_email
         and pi.accepted_at is null
      on conflict (project_id, user_id) do nothing;

      update opengeo.project_invitations
         set accepted_at = now()
       where lower(email) = v_normalized_email
         and accepted_at is null;

      return new;
    end if;
  end if;

  -- Branch B: standard signup flow (existing behavior).
  v_slug_base := lower(regexp_replace(
    coalesce(split_part(new.email, '@', 1), replace(new.id::text, '-', '')),
    '[^a-z0-9-]', '-', 'g'
  ));
  v_slug_base := regexp_replace(v_slug_base, '-+', '-', 'g');
  v_slug_base := trim(both '-' from v_slug_base);
  if length(v_slug_base) < 3 then
    v_slug_base := 'user-' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  v_slug := v_slug_base;

  while exists (select 1 from opengeo.orgs where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_slug_base || '-' || v_suffix::text;
  end loop;

  insert into opengeo.orgs (slug, name)
  values (v_slug, coalesce(new.email, v_slug))
  returning id into v_org_id;

  insert into opengeo.members (org_id, user_id, role)
  values (v_org_id, new.id, 'owner');

  insert into opengeo.projects (org_id, slug, name, visibility)
  values (v_org_id, 'default', 'Default Project', 'private');

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Update default_project_for to honor project-level membership
-- ---------------------------------------------------------------------------
-- The original only looked at org membership; an invitee who doesn't have any
-- org membership needs their invited project to show up as their "default".
create or replace function opengeo.default_project_for(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  with candidates as (
    select p.id, p.created_at
      from opengeo.projects p
      join opengeo.members m on m.org_id = p.org_id
     where m.user_id = p_user_id
       and m.role in ('owner','admin','editor')
    union all
    select p.id, p.created_at
      from opengeo.projects p
      join opengeo.project_members pm on pm.project_id = p.id
     where pm.user_id = p_user_id
       and pm.role in ('owner','admin','editor')
  )
  select id from candidates order by created_at asc limit 1;
$$;

grant execute on function opengeo.default_project_for(uuid)
  to authenticated, service_role;
