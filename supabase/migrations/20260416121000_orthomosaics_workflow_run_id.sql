-- Track the Workflow DevKit run that owns an orthomosaic's polling lifecycle.
-- Populated when FEATURE_DURABLE_PIPELINE=true and the ODM submit route kicks
-- off orthomosaicPipelineWorkflow. Null for legacy rows and for rows created
-- with the flag off (where the client drives /refresh directly).
alter table opengeo.orthomosaics
  add column if not exists workflow_run_id text;

-- Lets operators pivot from "which run is stuck?" straight to the trace
-- without a table scan. Partial index so the common null-filled state stays
-- cheap on writes.
create index if not exists orthomosaics_workflow_run_idx
  on opengeo.orthomosaics (workflow_run_id)
  where workflow_run_id is not null;
