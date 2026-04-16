# OpenGeo — Test Strategy

## Levels

1. **Type checking** (`pnpm typecheck`) — run on every save in dev and in CI. Blocks merge on failure.
2. **Unit tests** (`vitest`) — pure functions, SQL generators, utilities. Target <100 ms per test, full suite <10 s.
3. **Integration tests** (`vitest` + Testcontainers) — run against a real Postgres 15 + PostGIS + pgvector container. No mocks for the database. Test migrations, RLS, and core queries.
4. **End-to-end** (`playwright`) — smoke test the critical path: sign in → create project → upload GeoJSON → see layer on map → run NL query. Runs nightly and on release candidates.
5. **Contract tests against Claude** — keep a tiny fixture suite of NL prompts with known-good SQL outputs. Run before each release. Budget: ~$1 per run.

## Policy

- **No DB mocks.** Integration tests hit a real PostGIS instance (Testcontainers or local Compose). The research doc's note about mocked databases masking real migration failures applies here.
- **Never skip hooks.** `--no-verify` is forbidden without Nathaniel's explicit approval.
- **RLS is tested as a first-class concern.** Every table with RLS gets a test that asserts user in org A cannot read rows belonging to org B.
- **Geometry correctness over byte equality.** Use `ST_Equals` / `ST_DWithin` with a tolerance, not string comparison of WKT.
- **Fixtures are small.** Keep test GeoJSON under 100 KB. For larger test data, generate programmatically.
- **AI-generated SQL is validated before execution.** Unit tests cover the validator whitelist, not the LLM itself.

## What's intentionally *not* tested

- Visual regression of the map. MapLibre output is GPU-accelerated and varies by driver; Playwright screenshot diffs are too flaky.
- Exact Claude output. Fixtures assert structural validity and semantic equivalence, not string match.
- ODM output quality. We test that a job submitted lands in the expected R2 location; orthomosaic quality is an integration concern for Phase 1 scaling.

## Running

```bash
pnpm typecheck          # TypeScript only, fastest feedback.
pnpm test               # Unit tests (vitest).
pnpm test:integration   # Integration tests (PostGIS container, slower).
pnpm test:e2e           # Playwright.
pnpm test:ai            # Claude contract tests (uses real API, costs money).
```

Fast feedback loop: a pre-commit hook runs `typecheck + lint + unit`. Integration runs in CI.
