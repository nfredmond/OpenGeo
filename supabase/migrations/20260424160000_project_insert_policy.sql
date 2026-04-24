-- Allow org editors to create additional projects.
--
-- `has_project_access(project_id, ...)` is correct for existing project rows,
-- but it cannot authorize INSERT because the project id is not present in
-- `opengeo.projects` until after the row is accepted by RLS. Gate inserts on
-- the target org instead, while preserving project-scoped checks for updates
-- and deletes.

drop policy if exists projects_write on opengeo.projects;
drop policy if exists projects_insert on opengeo.projects;
drop policy if exists projects_update on opengeo.projects;
drop policy if exists projects_delete on opengeo.projects;

create policy projects_insert on opengeo.projects for insert
  with check (opengeo.can_edit(org_id));

create policy projects_update on opengeo.projects for update
  using (opengeo.has_project_access(id, 'editor'))
  with check (opengeo.can_edit(org_id));

create policy projects_delete on opengeo.projects for delete
  using (opengeo.has_project_access(id, 'editor'));
