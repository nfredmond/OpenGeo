-- Make project INSERT ... RETURNING work through PostgREST.
--
-- `projects_select` previously relied only on `has_project_access(id, ...)`.
-- That helper is correct for already-persisted rows, but during
-- `INSERT ... RETURNING` it has to look the new project up by id and can miss
-- the row in the same statement. A direct org-membership check is equivalent
-- for org members and keeps project-member access for invited users.

drop policy if exists projects_select on opengeo.projects;
create policy projects_select on opengeo.projects for select
  using (
    visibility = 'public'
    or opengeo.is_member(org_id)
    or opengeo.has_project_access(id, 'viewer')
  );
