import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomBytes } from "node:crypto";

/**
 * Integration test for Phase 2 Step 2 share tokens: the `project_share_tokens`
 * table + `resolve_share_token(p_token text)` RPC. Runs against the
 * docker-compose Postgres when LOCAL_DB_URL is set, otherwise skipped so CI
 * without a provisioned DB stays green.
 *
 * Exercises:
 *   - Happy path: mint → resolve returns the right project_id
 *   - Revoked token resolves to null
 *   - Expired token resolves to null
 *   - Unknown token resolves to null (no side channel)
 */

const url = process.env.LOCAL_DB_URL;
const describeFn = url ? describe : describe.skip;

type MintedToken = { id: string; token: string };

function mintToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(8).toString("base64url").slice(0, 10);
  const secret = randomBytes(32).toString("base64url");
  const token = `${prefix}.${secret}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, prefix, hash };
}

describeFn("project_share_tokens + resolve_share_token", () => {
  let client: Client;
  let orgId: string;
  let projectId: string;
  let userId: string;

  async function insertToken(options: {
    expiresAt?: Date | null;
    revoked?: boolean;
  }): Promise<MintedToken> {
    const { token, prefix, hash } = mintToken();
    const { rows } = await client.query<{ id: string }>(
      `insert into opengeo.project_share_tokens
         (project_id, token_prefix, token_hash, scopes, expires_at, revoked_at, created_by)
       values ($1, $2, $3, array['read:layers','read:orthomosaics'], $4, $5, $6)
       returning id`,
      [
        projectId,
        prefix,
        hash,
        options.expiresAt ?? null,
        options.revoked ? new Date() : null,
        userId,
      ],
    );
    return { id: rows[0].id, token };
  }

  async function resolve(token: string): Promise<string | null> {
    const { rows } = await client.query<{ resolved: string | null }>(
      `select opengeo.resolve_share_token($1) as resolved`,
      [token],
    );
    return rows[0].resolved;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query("begin");

    const { rows: userRows } = await client.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [`share-admin+${Date.now()}@opengeo.test`],
    );
    userId = userRows[0].id;

    const { rows: orgRows } = await client.query<{ id: string }>(
      `insert into opengeo.orgs (slug, name) values ($1, 'Share Org') returning id`,
      [`share-org-${Date.now()}`],
    );
    orgId = orgRows[0].id;

    await client.query(
      `insert into opengeo.members (org_id, user_id, role) values ($1, $2, 'owner')`,
      [orgId, userId],
    );

    const { rows: pRows } = await client.query<{ id: string }>(
      `insert into opengeo.projects (org_id, slug, name, visibility)
       values ($1, 'share-test', 'Share Test', 'private') returning id`,
      [orgId],
    );
    projectId = pRows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("resolves an active token to the project id", async () => {
    const minted = await insertToken({});
    const resolved = await resolve(minted.token);
    expect(resolved).toBe(projectId);
  });

  it("returns null for a revoked token", async () => {
    const minted = await insertToken({ revoked: true });
    const resolved = await resolve(minted.token);
    expect(resolved).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const minted = await insertToken({
      expiresAt: new Date(Date.now() - 60_000),
    });
    const resolved = await resolve(minted.token);
    expect(resolved).toBeNull();
  });

  it("returns null for a token that was never minted", async () => {
    const { token } = mintToken();
    const resolved = await resolve(token);
    expect(resolved).toBeNull();
  });

  it("returns null when the prefix matches but the secret does not", async () => {
    const minted = await insertToken({});
    const [prefix] = minted.token.split(".");
    const forged = `${prefix}.${randomBytes(32).toString("base64url")}`;
    const resolved = await resolve(forged);
    expect(resolved).toBeNull();
  });

  it("touches last_used_at on a successful resolve", async () => {
    const minted = await insertToken({});
    const before = new Date();
    await resolve(minted.token);
    const { rows } = await client.query<{ last_used_at: string | null }>(
      `select last_used_at from opengeo.project_share_tokens where id = $1`,
      [minted.id],
    );
    expect(rows[0].last_used_at).not.toBeNull();
    expect(new Date(rows[0].last_used_at!).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 5,
    );
  });
});
