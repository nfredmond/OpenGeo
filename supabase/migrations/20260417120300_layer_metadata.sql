-- OpenGeo — Phase 2 Step 3 (feature change detection).
-- Add a free-form metadata JSON column on layers so non-styling context (like
-- an AI-generated change-detection narrative) has a home. `style` is already
-- spoken for by MapLibre paint/layout; mixing prose into it invites bugs where
-- the style editor round-trips and drops the narrative.

alter table opengeo.layers
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists layers_metadata_gin
  on opengeo.layers using gin (metadata jsonb_path_ops);
