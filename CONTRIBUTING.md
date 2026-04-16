# Contributing to OpenGeo

OpenGeo is AGPL-3.0-or-later. By contributing, you agree your contributions are licensed under the same terms.

## Before you open a PR

1. **Read `docs/ROADMAP.md` and `docs/ARCHITECTURE.md`.** Contributions outside the current phase will be declined unless they clearly fit.
2. **Discuss non-trivial changes first.** Open an issue or RFC. Surprise PRs on architecture-shaping topics will be closed without review.
3. **Stay inside the product plane / engine plane boundary.** If your change embeds a new GIS library into the Next.js process, expect pushback.
4. **Do not add upstream-equivalent functionality inside OpenGeo.** If a feature belongs in MapLibre / Martin / pg_featureserv, send it there first. See the upstream-first policy in `docs/ARCHITECTURE.md`.

## Development workflow

```bash
pnpm install
cp .env.example .env.local     # fill in real values
docker compose up -d
pnpm db:migrate:local
pnpm dev
```

Run before pushing:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## Commit style

- Imperative mood, lowercase, no trailing period: `add martin docker service`, not `Added Martin Docker service.`
- Reference the roadmap phase or issue where relevant: `phase1: wire odm job queue`.
- One concern per commit. Refactors and feature work do not mix.

## Pull requests

- Title: `<area>: <short description>`. Example: `db: add rls policies for drone_flights`.
- Body: what changed, why, and how to verify. Link any related issue.
- Keep PRs under ~400 changed lines where possible.
- CI must be green. Reviewer will not reread after a rebase unless asked.

## Code style

- TypeScript strict mode, no `any`. Use `unknown` + narrowing.
- Server-only code lives under `lib/server/`. Client-only under `lib/client/`. Shared under `lib/shared/`.
- Prefer composing shadcn/ui primitives over importing raw Radix.
- No runtime CSS-in-JS. Tailwind utilities + `cn()`.
- No comments that describe *what* the code does. Use names. Reserve comments for non-obvious *why*.

## Security

- Report vulnerabilities privately to security@natfordplanning.com (once configured — currently nfredmond@gmail.com).
- Do not open public issues for security concerns.

## Licensing of third-party code

- OSM data is ODbL. If your change ingests OSM-derived data, surface attribution in the UI and document share-alike obligations on the dataset record.
- Any code copied from another repo must carry a compatible license and be attributed in `THIRD_PARTY_NOTICES.md`.

## Governance

OpenGeo is currently a benevolent-dictator project under Nathaniel Ford Redmond. Once there is a contributor community worth governing (Phase 3+), a technical steering committee and public RFC process will be documented here.
