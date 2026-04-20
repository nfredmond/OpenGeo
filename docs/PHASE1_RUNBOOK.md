# OpenGeo — Phase 1 End-to-End Runbook

A concrete walkthrough a planner can execute from a fresh clone to exercise
every Phase 1 capability. The goal is to prove the covenant-critical loop:
**upload → AI-extract → review → query → audit** — end-to-end, on a developer
laptop, with no proprietary cloud accounts required.

If any step here fails against `main`, that's the bug. File it or fix it.

## How to read this doc

Each step lists:
- **Do** — exact commands or clicks.
- **Expect** — what "worked" looks like.
- **If it fails** — the first place to look.

Steps tagged `(zero external setup)` work with just Docker + Node + pnpm.
Steps tagged `(requires Nathaniel's external account)` are blocked on a Modal
GPU account, a real NodeODM node, or a real drone-imagery bundle; the runbook
calls out the mock path that covers the same code surface without those.

---

## 0. Prereqs

**Do:**

```bash
# Clone + install.
git clone https://github.com/nfredmond/OpenGeo.git && cd OpenGeo
pnpm install

# Copy the env template. No real secrets needed for the local path.
cp .env.example .env.local

# Bring up Postgres + Martin + TiTiler + pg_featureserv.
docker compose up -d

# Apply migrations and seed a demo org/user/project/layers.
pnpm db:migrate:local
pnpm db:seed:local

# Start the app.
pnpm dev
```

**Expect:**
- `docker compose ps` shows `postgres`, `martin`, `titiler`, `pg_featureserv` as `Up`.
- `pnpm db:seed:local` ends with something like `layer parcels → <uuid>` and `extraction pending → <uuid>`.
- `pnpm dev` serves `http://localhost:3000`.

**If it fails:**
- `docker compose logs postgres` — pgvector image sometimes needs a second `up -d` after image pull.
- `pnpm db:migrate:local` failures usually mean the port 5432 container is unhealthy.

---

## 1. Sign in (zero external setup)

The local stack uses Supabase Auth magic links. For local dev, the `auth.uid()`
check is stubbed by `request.jwt.claim.sub`, and the seed script already wired
`demo@opengeo.local` to the demo org.

**Do:**
- Open `http://localhost:3000/login`.
- Submit `demo@opengeo.local`.
- Follow the magic-link URL printed to the `pnpm dev` terminal (local auth
  prints the link instead of emailing it).

**Expect:** redirected to `/` with the four cards (Projects / Map / Review / Status). The top-right shows `demo@opengeo.local`.

**If it fails:** check that `SUPABASE_URL` and `SUPABASE_ANON_KEY` in
`.env.local` point at your local stack, not the remote Supabase project.

---

## 2. Create or select a project (zero external setup)

**Do:**
- Click **Projects**.
- You'll see `Grass Valley demo` already (from the seed). Click it, or use the
  sidebar form to create a new project (`New project name` → submit).

**Expect:** URL becomes `/map/grass-valley-demo`. Map centers near
`[-121.06, 39.22]`. Layer panel on the left shows the seeded layers (buildings,
parcels).

**If it fails:** `pnpm db:seed:local` didn't complete. Re-run it.

---

## 3a. Upload a GeoJSON layer (zero external setup)

**Do:**
- On `/map/grass-valley-demo`, open the upload panel on the left.
- Drop any small `.geojson` file, or use the example below:

```bash
# From the repo root, write a tiny demo file.
cat > /tmp/demo-points.geojson <<'EOF'
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-121.06, 39.22] }, "properties": { "name": "A", "count": 1 } },
    { "type": "Feature", "geometry": { "type": "Point", "coordinates": [-121.07, 39.23] }, "properties": { "name": "B", "count": 2 } }
  ]
}
EOF
```

Drop `/tmp/demo-points.geojson` on the panel.

**Expect:** new layer appears in the layer list; two points render on the
map near Grass Valley.

**If it fails:** watch the `pnpm dev` terminal for the `/api/datasets/upload`
POST — the route returns `{ ok: false, error }` with a precise reason.

---

## 3b. Upload a Shapefile `.zip` (zero external setup — Phase 1 new)

Phase 1 adds pure-JS shapefile decode + CRS auto-detect + column-type
inference. You don't need QGIS or GDAL locally.

**Do (fast path — generate a fixture with `shp-write`):**

```bash
# From the repo root, generate a tiny shapefile zip with 2 points.
node -e '
const w = require("shp-write");
const fs = require("fs");
const fc = { type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "Point", coordinates: [-121.06, 39.22] }, properties: { name: "A", count: 1 } },
  { type: "Feature", geometry: { type: "Point", coordinates: [-121.07, 39.23] }, properties: { name: "B", count: 2 } }
]};
const zip = w.zip(fc, { types: { point: "points", polygon: "polygons", line: "lines" } });
fs.writeFileSync("/tmp/demo-shapefile.zip", zip);
console.log("wrote /tmp/demo-shapefile.zip");
'
```

- Drop `/tmp/demo-shapefile.zip` on the upload panel.

**Expect:**
- Layer appears on the map within ~1s.
- Visit `/review` → **AI audit log** tab → you see two new entries:
  - `CRS detect` (EPSG:4326, coord-bounds heuristic because `shp-write` omits
    `.prj`) — metadata includes `source: coord-bounds-4326`, `fileName: demo-shapefile.zip`.
  - `Column types` (`name: string, count: int`).

**Alternative: a real shapefile with a `.prj`.** Any shapefile you have from
the field works — Nevada County parcels, a Caltrans LRS export, an OpenStreetMap
admin boundary. The zip just needs `.shp`, `.dbf`, and optionally `.prj`,
`.shx`, `.cpg` siblings at the zip root or in one subfolder.

**If it fails:**
- `Shapefile decode failed: No .shp` — the zip structure is wrong (e.g., two
  nested folders deep). Flatten it.
- `CRS detect failed: outside lng/lat range` — the shapefile is projected but
  has no `.prj` sibling. Add the `.prj` before zipping.

---

## 4. Ingest drone imagery → orthomosaic

Phase 1 has the full path wired: `/api/flights` (record a flight) →
`/api/flights/[id]/odm` (submit imagery to a NodeODM node) → the
`orthomosaic-pipeline` workflow polls until ODM finishes and writes a COG
URL. That COG is what AI extraction runs against.

**Blocked on Nathaniel's external account:**
- A real NodeODM node with actual drone imagery.

**Zero-external-setup substitute:** the seed script inserts a flight + a
finished orthomosaic pointing at a synthetic COG URL. That's enough to
exercise extraction end-to-end (Step 5).

**If you have NodeODM running locally** (e.g., `docker run --rm -p 3030:3000 opendronemap/nodeodm`):
1. Set `NODEODM_URL=http://localhost:3030` in `.env.local`, restart `pnpm dev`.
2. Create a flight from the map workspace's ortho panel, then drop your JPEGs on it.
3. Watch the workflow run via `npx workflow web` — `orthomosaic-pipeline`
   polls NodeODM and writes the COG URL when the task completes.

---

## 5. Trigger AI feature extraction (mock path: zero external setup)

Extraction is the ADR-002 path: Next.js (product plane) → HTTP →
`services/extractor` (Python samgeo LangSAM, deployable to Modal). Phase 1
ships with a `MockExtractor` by default so nobody's blocked on a Modal GPU
account.

**Do (mock path, default):**
- On `/map/grass-valley-demo`, open the orthomosaic panel.
- Pick the seeded orthomosaic → click **Extract features**.
- Enter a prompt like `buildings` → submit.

**Expect:**
- A new entry shows up on `/review` in the **Extraction review** tab with
  `qa_status = pending`.
- The extraction carries a synthetic feature collection and a `metrics.model`
  stamp that starts with `mock:`.

**Do (http path, if you want to exercise the real Python service):**

```bash
# In a second terminal, from services/extractor:
cd services/extractor
pip install -r requirements.txt
uvicorn main:app --port 8000

# In your main .env.local, set:
#   OPENGEO_EXTRACTOR=http
#   OPENGEO_EXTRACTOR_URL=http://localhost:8000
#   OPENGEO_EXTRACTOR_TOKEN=dev  (any non-empty value; disable auth in dev)

# Smoke test without hitting the UI:
pnpm gauntlet --extractor=http
```

**Expect (http path):** `pnpm gauntlet --extractor=http` returns exit code 0
with "returned N features" and a `metrics.model` that starts with `langsam:`.

**Blocked on Nathaniel's external account:**
- Deploying `services/extractor` to Modal for the GPU path (ADR-002). The
  `Dockerfile.cpu` works locally without Modal.

---

## 6. Review — approve or reject (zero external setup)

**Do:**
- Visit `/review` → **Extraction review** tab.
- For the extraction from Step 5, click **Approve** (it moves to `human_reviewed`) or **Reject**.

**Expect:**
- The row disappears from the `Needs review` filter and reappears under
  `Approved` or `Rejected`.
- A `Reset to pending` button lets you roll back — handy when walking the
  runbook more than once.

**Covenant check:** nothing auto-approves. Every AI-produced layer sits in
`pending` until a human editor decides.

---

## 7. Natural-language query — NL→SQL (zero external setup, requires Anthropic key)

**Do:**
- Back on `/map/grass-valley-demo`, open the AI query panel (right side).
- Ask `how many buildings are in this project?`.

**Expect:**
- Panel shows the generated SQL, a rationale string, and the result count.
- If the query returned rows with geometry, they render on the map as a new
  ephemeral layer.
- Visit `/review` → **AI audit log** → `NL → SQL` filter: your prompt is in the list with the rationale.

**Blocked on Nathaniel's external account:**
- `ANTHROPIC_API_KEY` in `.env.local`. The AI steps (NL→SQL, NL→style) all
  require a working Claude key. Without it the panels return a 500.

**Tip:** `pnpm gauntlet` runs this end-to-end headlessly, which is the fastest
way to sanity-check the Anthropic wiring before touching the UI.

---

## 8. Natural-language map styling — NL→Style (zero external setup, requires Anthropic key)

**Do:**
- In the layer panel, click the paint-brush icon on one of your layers.
- Ask `color buildings a muted terracotta, outline 0.5px dark red`.

**Expect:**
- The UI shows a preview patch of the proposed style (paint/layout diff).
- Clicking **Apply** persists the style to `layers.style`.
- On `/review` → **AI audit log** → `NL → Style` filter: the patch is in the
  audit log; `paint: fill-color, fill-outline-color` shows up as the compact
  hint on the card.

---

## 9. Full audit — verify every AI decision was logged (zero external setup)

The covenant requires that every AI-touching decision is auditable. Walking
this step is how you verify.

**Do:**
- `/review` → **AI audit log** tab.
- Click each filter in turn: `All prompts`, `NL → SQL`, `NL → Style`, `CRS detect`, `Column types`.

**Expect:**
- Every action you took in Steps 3b/7/8 appears, with a rationale or metadata
  summary on the card.
- The entries are ordered newest-first; `Load more` pages back through older
  events in batches of 50.

**If any entry is missing:** the route for that action forgot to call
`logAiEvent`. That's a covenant-level bug — fix it in the same commit.

---

## Regression gauntlet (CI parity)

Before calling Phase 1 done, run the same checks CI runs on every push:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm gauntlet              # NL→SQL + NL→Style against Anthropic, mock extractor
pnpm gauntlet --extractor=http   # only if the Python service is running
```

All six should exit 0.

---

## What's explicitly deferred past Phase 2

These are intentional scope cuts — don't let them creep into Phase 1 or 2
without a conversation:

- **GeoPackage ingest.** `@ngageoint/geopackage` needs `better-sqlite3`
  (native), which is fragile on Vercel serverless. Shapefile is the dominant
  field format and covers ~80% of what a planner drops on the upload panel.
- **Address geocoding on ingest.** Needs a geocoder decision (Mapbox? Pelias?
  Nominatim?) — separate conversation.
- **Dashboard builder.** Depends on sharing; Phase 2 wedge #2.
- **Pixel-level raster diff between orthomosaics.** Needs GDAL/Python and a
  second services/\* deployment; Phase 2.5. Feature-level diff (Phase 2 Step 3)
  covers vector-on-vector; raster-on-raster is the remaining half.
- **Maputnik-style editor.** PMTiles publishing is in place; a full style
  editor for published vector tiles remains separate.
- **Semantic layer search via Clay embeddings.** Phase 3 candidate.

---

## Known external-account dependencies

| What | Who | Why it's not in Phase 1 |
|---|---|---|
| Modal GPU account | Nathaniel | Real SAM feature extraction. Mock extractor covers the HTTP contract. |
| NodeODM node | Nathaniel | Real drone photo → orthomosaic. Seed provides a synthetic orthomosaic. |
| Drone imagery bundle | Nathaniel | Needed for a real-world walk-through. Seed provides a synthetic flight. |
| `ANTHROPIC_API_KEY` | Nathaniel | AI SDK calls for NL→SQL + NL→Style. |
| Vercel project link | Nathaniel | Preview/production deploys. Local dev doesn't need it. |

Everything else in this runbook should work on a fresh laptop with only
Docker + Node + pnpm + a Claude key.

---

# Phase 2 Runbook — sharing, public links, change detection

Phase 2 turns OpenGeo from a single-user demo into something a consultant can
actually invite a collaborator into and send a client a read-only map. The
steps below append to Phase 1 — they assume you've already run through at
least the upload / extract / review loop.

Each step follows the same **Do / Expect / If it fails** pattern as Phase 1.

## P2.1 Invite a collaborator to a project *(zero external setup)*

Phase 2 Step 1 extends the org-level membership model with a
`project_members` table + email-invitation flow so a project owner can bring
a collaborator in without giving them the whole org.

**Do:**

- Sign in as a project admin at `http://localhost:3000/login`.
- From `/projects`, click **Share** on a project.
- On `/projects/<slug>/share`, fill **Invite by email** with an address that
  is *not* already in `auth.users` (e.g. `collab+<unix-ts>@example.com`).
  Role: `editor`. Submit.
- Open a second browser (or incognito) and hit the Supabase local-auth
  mailbox at `http://localhost:54324` (Inbucket). Click the magic-link mail
  and follow it through `/auth/callback`.

**Expect:**

- The invite form shows a success toast and the invitation appears under
  **Pending invitations** with the role you chose.
- After the collaborator lands via the magic link, they end up on
  `/map/<slug>?projectId=<uuid>` with the project visible (no auto-org
  created for them).
- On `/projects/<slug>/share?projectId=<uuid>` the invitation row moves from
  **Pending** to **Members**.

**If it fails:**

- Nothing shows up on `/projects/<slug>/share` → the caller wasn't an admin.
  `has_project_access(project_id, 'admin')` is enforced on GET too.
- Collaborator sees no projects after signing in → the auth trigger didn't
  match their email to a pending invitation. Most common cause: the email
  differs in case. `project_invitations.email` is `citext` but the trigger
  compares against `lower(new.email)`; check `select email from
  auth.users where id = ...` vs. the pending invitation row.
- Magic-link mail never arrives → Inbucket wasn't running. Restart the
  supabase stack (`supabase start`) and re-invite.

## P2.2 Mint a public share link, verify read-only *(zero external setup)*

Phase 2 Step 2 adds `project_share_tokens` + `resolve_share_token(text)` and
an anon-readable `/api/share/[token]/*` surface so a planner can hand a raw
URL to a client. Tokens are hashed at rest (mirrors the `api_keys` pattern).

**Do:**

- On `/projects/<slug>/share?projectId=<uuid>`, scroll to **Public share links**.
- Enter an expiry in days (e.g. `7`), click **Mint**.
- Copy the token from the one-time display (it will never appear again),
  then click **Dismiss**.
- Open an incognito window and go to `/p/<token>`.

**Expect:**

- The public page loads a trimmed read-only map: project name + org in a
  "Read-only share" banner, a layers-only sidebar with visibility toggles
  (no upload, no extract, no AI query), and the basemap picker in the
  header.
- Any `.safetensors`-style copy-paste of the token into another route
  (e.g. `curl http://localhost:3000/api/layers` in an anon session) returns
  **401** — the token only unlocks `/api/share/[token]/*`.
- Listing tokens on `/projects/<slug>/share` shows the prefix + expiry but
  **not** the secret. Hitting `GET /api/projects/<slug>/share-links`
  directly returns the same.

**If it fails:**

- `/p/<token>` renders "This share link isn't available." → the token
  didn't resolve. Check `select revoked_at, expires_at from
  opengeo.project_share_tokens where token_prefix = '...'`. All invalid
  paths (expired/revoked/unknown/forged) 404 on purpose; check the DB row
  to tell them apart.
- The map is blank but the banner renders → the layers route returned
  empty. Most common cause: the project has no vector layers. Run the
  Phase 1 extract loop first so there's something to render.
- Dev tools show `GET /api/share/<token>/layers` returning 500 → the share
  scope doesn't include `read:layers`. Defaults include both
  `read:layers` and `read:orthomosaics`; if you minted with a narrower
  scope, that's the cause.

## P2.3 Diff two layers, view the AI narrative *(requires Anthropic key)*

Phase 2 Step 3 is the drone-wedge proof point: two flights of the same site
feed into `POST /api/flights/diff`, which returns a change-typed layer
(added / removed / modified) and asks Claude for a short narration stored on
the new layer's metadata.

**Do:**

- Open `/map/<slug>?projectId=<uuid>` for a project that already has at least
  two vector layers in it (the quickest seed: run the Phase 1 extract loop
  twice with a tweak, or upload two GeoJSON files with small differences).
- In the sidebar, scroll to **Compare layers**. Pick a **From** and a
  **To** layer, then click **Compare**.

**Expect:**

- A new layer appears on the map painted red / green / amber by
  `change_type`.
- The panel shows counts (e.g. `+3 added`, `−1 removed`, `Δ2 modified`).
- Within a few seconds, an **AI narration** block renders a 3–4 sentence
  summary.
- The new diff layer is persisted — reloading the page rehydrates it.
- `/review` on the **AI audit log** tab shows two rows per run:
  one with `kind = change_detect`, one with `kind = change_narrate`.
  The filter chips for both are visible.

**If it fails:**

- The compare button is disabled → fewer than two eligible vector layers
  are loaded. Large (>2000 feature) tile-backed layers don't participate
  in v1; pick two GeoJSON-backed ones.
- 400 from the route → both layers must be in the same project, both must
  have at least one feature, and `fromLayerId` must differ from
  `toLayerId`.
- Counts are `{added:0, removed:0, modified:0}` on layers you know
  differ → your features are outside the default thresholds (5m distance,
  0.5 IoU, 2m modified shift). Pass a custom `thresholds` body if you
  need tighter matching.
- Narration block never appears but counts do → the Anthropic call failed.
  The diff layer still persists (this is intentional — narration is
  best-effort). Check the server log for `change-detection narration
  failed:`.

## P2.4 Revoke a share link, verify the incognito window 404s *(zero external setup)*

Covers the opposite direction: if a planner mailed a token to the wrong
person or the client relationship ends, the token has to stop working
immediately.

**Do:**

- In the normal (logged-in) window, return to
  `/projects/<slug>/share?projectId=<uuid>`.
- In **Public share links**, click **Revoke** on the token you minted in
  P2.2.
- In the still-open incognito window from P2.2, reload `/p/<token>`.

**Expect:**

- The token disappears from the **Active** list and shows under **Revoked**
  with a timestamp.
- The incognito reload lands on "This share link isn't available." within
  a single page load — no caching gotchas, because all share routes use
  `cache: "no-store"`.
- Any direct `curl http://localhost:3000/api/share/<token>/project`
  returns **404**, same as an unknown token (no oracle leak).

**If it fails:**

- The incognito page still shows data → check `select revoked_at from
  opengeo.project_share_tokens where id = '<uuid>'`. If that's populated
  but the page still loads, the client is caching. Hard-reload.
- `/projects/<slug>/share` throws on revoke → the DELETE route is gated
  on `has_project_access(project_id, 'admin')`. Sign in as an admin.

## P2.5 Publish or register a PMTiles archive

OpenGeo can either register an existing public `.pmtiles` archive or publish
one of the current PostGIS-backed vector layers to Cloudflare R2 using
Tippecanoe.

**Prereqs for publishing:**

- Either `PMTILES_GENERATOR_URL` points at the generator service, or
  `TIPPECANOE_BIN` points to a working local `tippecanoe` binary.
- If the generator service has auth enabled, `PMTILES_GENERATOR_TOKEN` matches
  the service token.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
  and `R2_PUBLIC_BASE_URL` are set.
- `pnpm env:doctor -- --target=preview --scope=pmtiles` passes for the target
  env values.
- `GET /api/pmtiles/publish` returns `readiness.ok: true` for an authenticated
  user.

The deployable generator image is published from GitHub Actions as
`ghcr.io/nfredmond/opengeo-pmtiles-generator:sha-<commit>` on `main` or manual
workflow dispatch. Use that image on the container host and point
`PMTILES_GENERATOR_URL` at its HTTPS `/generate` endpoint.

Registering a hosted archive only needs a public PMTiles URL.

**Do:**

- Open `/map/<slug>?projectId=<uuid>` as a project editor.
- In the sidebar, click **Add PMTiles layer**.
- To publish an existing layer, choose a vector layer and click **Publish**.
- To register an existing archive, paste a public HTTPS URL ending in
  `.pmtiles`, set the source layer name used inside the archive, choose the
  geometry kind, and click **Add**.

**Expect:**

- The layer appears immediately in the map and in the layer list as a
  `pmtiles` source.
- Reloading the map rehydrates the layer from `/api/layers`.
- If the project has an active share link with `read:layers`, `/p/<token>`
  renders the same PMTiles layer without fetching GeoJSON features.
- `pnpm pmtiles:smoke` returns a non-empty PMTiles archive from the configured
  generator service.

**If it fails:**

- Publish returns 502 → the remote generator service failed or rejected the
  request. Check `PMTILES_GENERATOR_URL`, `PMTILES_GENERATOR_TOKEN`, and the
  service logs.
- Publish returns 503 → local Tippecanoe is missing, or the R2 env vars are
  not set.
- Register returns 400 → the URL must be public `http`/`https` and the path
  must end in `.pmtiles`.
- The map shows no tiles → confirm the archive has CORS enabled and that
  **Source layer** matches the internal layer name in the PMTiles archive.
- The route returns 403 → the signed-in user needs editor access to the
  target project.

---

## Phase 2 smoke-test one-liner

Once P2.1–P2.4 pass by hand, the same happy path can be exercised by the
unit + integration tests without starting a browser:

```bash
pnpm test  # project-membership, share tokens, share routes, feature diff, flights/diff route
```

The integration-style tests (`has-project-access`, `share-token`) are gated
on `LOCAL_DB_URL` so CI stays green without a provisioned Postgres; set
`LOCAL_DB_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres` to run
them against your local supabase stack.
