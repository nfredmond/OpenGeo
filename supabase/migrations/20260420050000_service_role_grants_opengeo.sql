-- `20260418100000_schema_grants_and_resolve_fix.sql` granted USAGE on the
-- `opengeo` schema to service_role but forgot the table/sequence grants.
-- Server routes that bypass RLS via `supabaseService()` (e.g. share-link
-- minting in `/api/projects/[slug]/share-links`) therefore failed with
-- `permission denied for table project_share_tokens` when the `opengeo`
-- schema is exposed via PostgREST. This closes the gap so service_role has
-- the same CRUD surface on `opengeo` that `authenticated` already has.

grant select, insert, update, delete on all tables in schema opengeo
  to service_role;
grant usage, select on all sequences in schema opengeo to service_role;
grant execute on all functions in schema opengeo to service_role;

alter default privileges in schema opengeo
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema opengeo
  grant usage, select on sequences to service_role;
alter default privileges in schema opengeo
  grant execute on functions to service_role;
