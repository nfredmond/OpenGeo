-- OpenGeo — drone pipeline and AI audit log.

-- --- drone_flights ---
create table if not exists opengeo.drone_flights (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references opengeo.projects(id) on delete cascade,
  flown_at timestamptz not null,
  pilot text,
  aircraft text,
  site_geom geometry(Polygon, 4326),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists drone_flights_project_idx on opengeo.drone_flights (project_id);
create index if not exists drone_flights_site_gix on opengeo.drone_flights using gist (site_geom);

-- --- orthomosaics ---
create type opengeo.ortho_status as enum ('queued','processing','ready','failed');

create table if not exists opengeo.orthomosaics (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references opengeo.drone_flights(id) on delete cascade,
  status opengeo.ortho_status not null default 'queued',
  cog_url text,
  dsm_url text,
  dtm_url text,
  pointcloud_url text,
  resolution_cm numeric,
  bbox geometry(Polygon, 4326),
  odm_job_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orthomosaics_flight_idx on opengeo.orthomosaics (flight_id);
create index if not exists orthomosaics_bbox_gix on opengeo.orthomosaics using gist (bbox);

-- --- extractions (AI feature extraction from imagery) ---
create type opengeo.extraction_qa as enum ('pending','ai_ok','human_reviewed','rejected');

create table if not exists opengeo.extractions (
  id uuid primary key default gen_random_uuid(),
  orthomosaic_id uuid not null references opengeo.orthomosaics(id) on delete cascade,
  model text not null,
  prompt text,
  output_layer_id uuid references opengeo.layers(id) on delete set null,
  qa_status opengeo.extraction_qa not null default 'pending',
  metrics jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists extractions_ortho_idx on opengeo.extractions (orthomosaic_id);

-- --- embeddings (pgvector) ---
-- Subject polymorphism: either a dataset, a feature, or a raster tile.
create type opengeo.embedding_subject as enum ('dataset','feature','tile','document');

create table if not exists opengeo.embeddings (
  id uuid primary key default gen_random_uuid(),
  subject_kind opengeo.embedding_subject not null,
  subject_id uuid not null,
  model text not null,
  -- Clay v1 emits 768-dim embeddings; SAM/OpenAI use varying sizes. Store a fixed
  -- 768 and project/pad others during ingest.
  embedding vector(768) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists embeddings_subject_idx on opengeo.embeddings (subject_kind, subject_id);
-- HNSW index is the modern pgvector default.
create index if not exists embeddings_hnsw_cos on opengeo.embeddings
  using hnsw (embedding vector_cosine_ops);

-- --- ai_events (audit trail for every LLM / AI call) ---
create table if not exists opengeo.ai_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references opengeo.orgs(id) on delete set null,
  actor uuid references auth.users(id) on delete set null,
  kind text not null, -- 'nl_sql','style_gen','extract','embed','agent_step'
  model text not null,
  prompt text,
  response_summary text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 6),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ai_events_org_idx on opengeo.ai_events (org_id, created_at desc);
create index if not exists ai_events_kind_idx on opengeo.ai_events (kind, created_at desc);
