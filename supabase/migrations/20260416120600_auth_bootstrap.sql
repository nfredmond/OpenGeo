-- OpenGeo — auto-provision an org + default project for each new auth user.
-- Without this bootstrap, RLS policies block every write because the user has
-- no membership rows to join against. The trigger runs as SECURITY DEFINER so
-- it bypasses RLS on the opengeo.* tables during the seed write.

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
begin
  -- Derive a slug from the email local-part; fall back to the user id.
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

  -- Retry with a numeric suffix if the slug is already taken.
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

-- Drop and recreate the trigger defensively so re-running the migration is safe
-- against environments where it was partially applied.
drop trigger if exists opengeo_on_auth_user_created on auth.users;
create trigger opengeo_on_auth_user_created
  after insert on auth.users
  for each row execute function opengeo.handle_new_auth_user();

-- Helpers the API layer uses to resolve "the user's primary project" without
-- asking the client to know about org ids. Returns null when the user has no
-- membership (should not happen post-trigger, but defensive).
create or replace function opengeo.default_project_for(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, opengeo
as $$
  select p.id
  from opengeo.projects p
  join opengeo.members m on m.org_id = p.org_id
  where m.user_id = p_user_id
    and m.role in ('owner','admin','editor')
  order by p.created_at asc
  limit 1;
$$;

grant execute on function opengeo.default_project_for(uuid) to authenticated, service_role;
