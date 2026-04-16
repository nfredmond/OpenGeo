-- --- extraction_qa ---
-- SECURITY DEFINER RPC that lets a planner set the QA status on an AI
-- extraction (pending → ai_ok | human_reviewed | rejected). Mirrors the
-- ingest_geojson pattern: runs as owner so the caller can sidestep the
-- "service role only" policy on extractions, but self-authorizes via
-- opengeo.can_edit() so only editors/admins in the owning org can act.

set search_path = opengeo, public;

create or replace function opengeo.set_extraction_qa(
  p_extraction_id uuid,
  p_qa_status text
)
returns uuid
language plpgsql
security definer
set search_path = opengeo, public
as $$
declare
  v_project_id uuid;
  v_org uuid;
  v_layer_id uuid;
begin
  if p_qa_status not in ('pending','ai_ok','human_reviewed','rejected') then
    raise exception 'Invalid qa_status: %', p_qa_status using errcode = '22023';
  end if;

  -- Resolve the extraction → orthomosaic → flight → project → org chain so
  -- authorization uses the same helpers as the rest of the schema.
  select df.project_id, e.output_layer_id
    into v_project_id, v_layer_id
    from opengeo.extractions e
    join opengeo.orthomosaics o on o.id = e.orthomosaic_id
    join opengeo.drone_flights df on df.id = o.flight_id
   where e.id = p_extraction_id;

  if v_project_id is null then
    raise exception 'Extraction % not found.', p_extraction_id using errcode = 'P0002';
  end if;

  v_org := opengeo.org_of_project(v_project_id);
  if not opengeo.can_edit(v_org) then
    raise exception 'Not authorized to review extractions in project %.', v_project_id
      using errcode = '42501';
  end if;

  update opengeo.extractions
     set qa_status = p_qa_status::opengeo.extraction_qa
   where id = p_extraction_id;

  return v_layer_id;
end;
$$;

revoke all on function opengeo.set_extraction_qa(uuid, text) from public;
grant execute on function opengeo.set_extraction_qa(uuid, text) to authenticated;

comment on function opengeo.set_extraction_qa(uuid, text) is
  'Planner-in-the-loop QA: set an extraction''s qa_status. Requires editor+ role.';
