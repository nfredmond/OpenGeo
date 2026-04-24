# OpenGeo PMTiles Generator

Small HTTP service that wraps Tippecanoe. It exists so the Next.js product
plane can publish PMTiles without depending on a native `tippecanoe` binary
inside Vercel serverless functions.

## HTTP Contract

```
POST /generate
Authorization: Bearer <PMTILES_GENERATOR_TOKEN>
Content-Type: application/json
Accept: application/vnd.pmtiles

{
  "featureCollection": { "type": "FeatureCollection", "features": [...] },
  "name": "Published parcels",
  "sourceLayer": "layer",
  "minzoom": 0,
  "maxzoom": 14
}
```

Response: raw `application/vnd.pmtiles` bytes.

If `PMTILES_GENERATOR_TOKEN` is unset on the service, auth is skipped for local
development. Production should set the token and configure the same value in
Vercel as `PMTILES_GENERATOR_TOKEN`.

## Local Development

```bash
cd services/pmtiles-generator
docker build -t opengeo-pmtiles-generator .
docker run --rm -p 8110:8110 opengeo-pmtiles-generator
```

The Dockerfile compiles Tippecanoe from the Felt fork in a builder stage and
copies only the runtime binaries into the service image. Override
`TIPPECANOE_REF` at build time when intentionally upgrading Tippecanoe.

Then set in `.env.local`:

```bash
PMTILES_GENERATOR_URL="http://localhost:8110/generate"
PMTILES_GENERATOR_TOKEN=""
```

Smoke-test the running service from the repo root:

```bash
pnpm pmtiles:smoke
```

The Next.js app still supports direct local generation with
`TIPPECANOE_BIN=tippecanoe` when `PMTILES_GENERATOR_URL` is empty.

## No-cost hosted bridge

If Fly.io deployment is blocked, the repo can run the published GHCR image
locally and expose it through a Cloudflare quick tunnel:

```bash
pnpm pmtiles:bridge start
pnpm pmtiles:smoke
```

The bridge manager starts:

- `opengeo-pmtiles-generator-local` on `127.0.0.1:8110`
- `opengeo-pmtiles-tunnel` using `cloudflare/cloudflared:latest`

It writes the active quick tunnel base URL to
`~/.cache/opengeo/pmtiles/tunnel-url.txt`. To update Vercel after the quick
tunnel URL changes:

```bash
pnpm pmtiles:bridge start --update-vercel
vercel deploy --prod -y
```

This bridge depends on the local machine staying awake with Docker running.
Use Fly.io or another always-on host for real production.

## Image Publishing

GitHub Actions builds this image on pull requests and publishes it to GHCR on
`main` or manual workflow dispatch:

```text
ghcr.io/nfredmond/opengeo-pmtiles-generator:<tag>
```

The workflow emits `sha-<commit>` tags for reproducible deployments and
`latest` for the default branch. Point the container host at `/generate` and
set `PMTILES_GENERATOR_URL` in Vercel to that public HTTPS endpoint.

## Fly.io Deployment

The repo includes `fly.toml` for the release-hardening app:

```bash
fly apps create opengeo-pmtiles-generator-natford
fly secrets set PMTILES_GENERATOR_TOKEN="<shared bearer token>" \
  --app opengeo-pmtiles-generator-natford
fly deploy --config services/pmtiles-generator/fly.toml
```

The config uses the immutable image tag
`ghcr.io/nfredmond/opengeo-pmtiles-generator:sha-b61ee31`, exposes port `8110`,
and health-checks `/health`. Keep `primary_region` close to the hosted
Supabase region; it defaults to `sjc` until that region is confirmed.

After deployment, set this in Vercel preview and production:

```text
PMTILES_GENERATOR_URL=https://opengeo-pmtiles-generator-natford.fly.dev/generate
PMTILES_GENERATOR_TOKEN=<same shared bearer token>
```
