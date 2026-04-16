-- OpenGeo — dedicated read-only role for AI-generated SQL execution.
-- The NL→SQL endpoint connects under this role, so any hallucination that
-- tries to INSERT/UPDATE/DELETE is rejected at the database level.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'opengeo_ai_reader') then
    create role opengeo_ai_reader nologin;
  end if;
end
$$;

-- Allow the AI reader to use the schema and read everything in it.
grant usage on schema opengeo to opengeo_ai_reader;
grant select on all tables in schema opengeo to opengeo_ai_reader;
alter default privileges in schema opengeo grant select on tables to opengeo_ai_reader;

-- Explicitly deny writes — redundant given role has no write grants, but
-- documents intent.
revoke insert, update, delete, truncate on all tables in schema opengeo from opengeo_ai_reader;
