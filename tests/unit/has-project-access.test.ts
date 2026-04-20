import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * Integration test for the Phase 2 Step 1 RLS helpers + invitation trigger.
 * Runs against the docker-compose Postgres when LOCAL_DB_URL is set;
 * otherwise skipped so CI without a provisioned DB stays green.
 *
 * Exercises:
 *   - has_project_access for org-only members (viewer/editor/admin/owner)
 *   - has_project_access for project-only members (invitees)
 *   - handle_new_auth_user trigger: pending invitation routes new user into
 *     project_members instead of auto-creating a personal org
 *   - default_project_for honors both org- and project-level membership
 */

const url = process.env.LOCAL_DB_URL;
const describeFn = url ? describe : describe.skip;

describeFn("has_project_access + invitation trigger", () => {
  let client: Client;

  // Fixtures created in beforeAll and cleaned up in afterAll.
  let orgA: string;
  let orgB: string;
  let projectA: string;
  let projectB: string;
  let userOwner: string;
  let userEditor: string;
  let userViewer: string;
  let userInvited: string;
  let userProjectViewer: string;
  let userStranger: string;

  async function impersonate(userId: string | null) {
    if (userId === null) {
      await client.query(`select set_config('request.jwt.claim.sub', '', true)`);
    } else {
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        userId,
      ]);
    }
  }

  async function hasAccess(projectId: string, role: string): Promise<boolean> {
    const { rows } = await client.query<{ ok: boolean }>(
      `select opengeo.has_project_access($1::uuid, $2::opengeo.member_role) as ok`,
      [projectId, role],
    );
    return rows[0].ok;
  }

  async function expectSqlRejection(
    action: () => Promise<unknown>,
    message: RegExp,
  ) {
    await client.query("savepoint expected_error");
    try {
      await expect(action()).rejects.toThrow(message);
    } finally {
      await client.query("rollback to savepoint expected_error").catch(() => {});
      await client.query("release savepoint expected_error").catch(() => {});
    }
  }

  async function insertUser(email: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [email],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    // Run everything in a single transaction we roll back at the end so we
    // don't pollute the dev database between runs. Expected SQL errors are
    // wrapped in savepoints so they do not abort the outer transaction.
    await client.query("begin");

    userOwner = await insertUser(`owner+${Date.now()}@opengeo.test`);
    userEditor = await insertUser(`editor+${Date.now()}@opengeo.test`);
    userViewer = await insertUser(`viewer+${Date.now()}@opengeo.test`);
    userInvited = await insertUser(`invited+${Date.now()}@opengeo.test`);
    userProjectViewer = await insertUser(`project-viewer+${Date.now()}@opengeo.test`);
    userStranger = await insertUser(`stranger+${Date.now()}@opengeo.test`);

    // Two orgs so we can prove cross-org isolation.
    const { rows: orgARows } = await client.query<{ id: string }>(
      `insert into opengeo.orgs (slug, name) values ($1, 'Org A') returning id`,
      [`org-a-${Date.now()}`],
    );
    orgA = orgARows[0].id;
    const { rows: orgBRows } = await client.query<{ id: string }>(
      `insert into opengeo.orgs (slug, name) values ($1, 'Org B') returning id`,
      [`org-b-${Date.now()}`],
    );
    orgB = orgBRows[0].id;

    await client.query(
      `insert into opengeo.members (org_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'viewer')`,
      [orgA, userOwner, userEditor, userViewer],
    );

    const { rows: pA } = await client.query<{ id: string }>(
      `insert into opengeo.projects (org_id, slug, name, visibility)
       values ($1, 'alpha', 'Alpha', 'private') returning id`,
      [orgA],
    );
    projectA = pA[0].id;
    const { rows: pB } = await client.query<{ id: string }>(
      `insert into opengeo.projects (org_id, slug, name, visibility)
       values ($1, 'beta', 'Beta', 'private') returning id`,
      [orgB],
    );
    projectB = pB[0].id;

    // The on_auth_user_created trigger auto-spins an org + "Default Project"
    // for every inserted auth.users row unless a matching invitation exists.
    // userInvited is meant to represent a true project-only invitee (no org
    // membership), so strip that auto-created org here. Cascading FKs drop the
    // auto-created member row + Default Project with it. Without this the
    // default_project_for test below gets the older auto-project back instead
    // of projectA.
    await client.query(
      `delete from opengeo.orgs
        where id in (select org_id from opengeo.members where user_id in ($1, $2))`,
      [userInvited, userProjectViewer],
    );

    // Direct project_members grant: strangers get access only to projectA.
    await client.query(
      `insert into opengeo.project_members (project_id, user_id, role)
       values ($1, $2, 'editor'), ($1, $3, 'viewer')`,
      [projectA, userInvited, userProjectViewer],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it("grants org owner access at every role tier on their project", async () => {
    await impersonate(userOwner);
    expect(await hasAccess(projectA, "viewer")).toBe(true);
    expect(await hasAccess(projectA, "editor")).toBe(true);
    expect(await hasAccess(projectA, "admin")).toBe(true);
    expect(await hasAccess(projectA, "owner")).toBe(true);
  });

  it("grants org editor viewer+editor access but not admin/owner", async () => {
    await impersonate(userEditor);
    expect(await hasAccess(projectA, "viewer")).toBe(true);
    expect(await hasAccess(projectA, "editor")).toBe(true);
    expect(await hasAccess(projectA, "admin")).toBe(false);
    expect(await hasAccess(projectA, "owner")).toBe(false);
  });

  it("grants org viewer only viewer access", async () => {
    await impersonate(userViewer);
    expect(await hasAccess(projectA, "viewer")).toBe(true);
    expect(await hasAccess(projectA, "editor")).toBe(false);
    expect(await hasAccess(projectA, "admin")).toBe(false);
  });

  it("grants project-level editor access without org membership", async () => {
    await impersonate(userInvited);
    expect(await hasAccess(projectA, "viewer")).toBe(true);
    expect(await hasAccess(projectA, "editor")).toBe(true);
    expect(await hasAccess(projectA, "admin")).toBe(false);
  });

  it("denies access entirely to a stranger", async () => {
    await impersonate(userStranger);
    expect(await hasAccess(projectA, "viewer")).toBe(false);
    expect(await hasAccess(projectB, "viewer")).toBe(false);
  });

  it("does not leak project B access through project A grants", async () => {
    await impersonate(userInvited);
    expect(await hasAccess(projectA, "viewer")).toBe(true);
    expect(await hasAccess(projectB, "viewer")).toBe(false);
  });

  it("anon (no JWT) has no access", async () => {
    await impersonate(null);
    expect(await hasAccess(projectA, "viewer")).toBe(false);
  });

  it("RLS on the projects table honors has_project_access for invitees", async () => {
    // Switch to the `authenticated` role so RLS applies (session user here is
    // a superuser by default when the pg client connects as postgres/opengeo).
    await client.query("set local role authenticated");
    try {
      await impersonate(userInvited);
      const { rows } = await client.query<{ id: string }>(
        `select id from opengeo.projects where id = $1`,
        [projectA],
      );
      expect(rows).toHaveLength(1);

      const { rows: denied } = await client.query<{ id: string }>(
        `select id from opengeo.projects where id = $1`,
        [projectB],
      );
      expect(denied).toHaveLength(0);
    } finally {
      await client.query("reset role");
    }
  });

  it("trigger routes an invited email into project_members instead of a new org", async () => {
    const invitedEmail = `trigger+${Date.now()}@opengeo.test`;
    // Impersonate the admin who creates the invitation.
    await impersonate(userOwner);

    await client.query(
      `insert into opengeo.project_invitations (project_id, email, role, invited_by)
       values ($1, $2, 'editor', $3)`,
      [projectA, invitedEmail, userOwner],
    );

    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [invitedEmail],
    );
    const newUserId = inserted[0].id;

    // The trigger should have upserted project_members + marked the invitation accepted.
    const { rows: pmRows } = await client.query(
      `select role from opengeo.project_members where project_id = $1 and user_id = $2`,
      [projectA, newUserId],
    );
    expect(pmRows).toHaveLength(1);
    expect(pmRows[0].role).toBe("editor");

    const { rows: invRow } = await client.query(
      `select accepted_at from opengeo.project_invitations
        where lower(email) = lower($1) and project_id = $2`,
      [invitedEmail, projectA],
    );
    expect(invRow).toHaveLength(1);
    expect(invRow[0].accepted_at).not.toBeNull();

    // Invited users must not get a personal org auto-created.
    const { rows: membershipRows } = await client.query(
      `select 1 from opengeo.members where user_id = $1`,
      [newUserId],
    );
    expect(membershipRows).toHaveLength(0);
  });

  it("trigger bootstraps a new org for a non-invited email", async () => {
    const strangerEmail = `fresh+${Date.now()}@opengeo.test`;
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
      [strangerEmail],
    );
    const freshId = inserted[0].id;

    const { rows: orgRows } = await client.query(
      `select o.id from opengeo.orgs o
         join opengeo.members m on m.org_id = o.id and m.role = 'owner'
        where m.user_id = $1`,
      [freshId],
    );
    expect(orgRows).toHaveLength(1);
  });

  it("default_project_for picks up project-only membership", async () => {
    const { rows } = await client.query<{ id: string }>(
      `select opengeo.default_project_for($1::uuid) as id`,
      [userInvited],
    );
    expect(rows[0].id).toBe(projectA);
  });

  it("ingest_geojson allows project-only editors and denies project-only viewers", async () => {
    const featureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-121.5, 39.2] },
          properties: { name: "project-only editor" },
        },
      ],
    };

    await impersonate(userInvited);
    const { rows } = await client.query<{ layer_id: string }>(
      `select opengeo.ingest_geojson($1::uuid, $2, $3::jsonb) as layer_id`,
      [projectA, "Project-only editor ingest", JSON.stringify(featureCollection)],
    );
    expect(rows[0].layer_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await impersonate(userProjectViewer);
    await expectSqlRejection(
      () =>
        client.query(
          `select opengeo.ingest_geojson($1::uuid, $2, $3::jsonb) as layer_id`,
          [projectA, "Project-only viewer ingest", JSON.stringify(featureCollection)],
        ),
      /Not authorized/,
    );
  });

  it("set_extraction_qa allows project-only editors and denies project-only viewers", async () => {
    const { rows: flightRows } = await client.query<{ id: string }>(
      `insert into opengeo.drone_flights (project_id, flown_at, metadata)
       values ($1, now(), '{}'::jsonb)
       returning id`,
      [projectA],
    );
    const { rows: orthoRows } = await client.query<{ id: string }>(
      `insert into opengeo.orthomosaics (flight_id, status, cog_url)
       values ($1, 'ready', 'https://example.com/ortho.tif')
       returning id`,
      [flightRows[0].id],
    );
    const { rows: extractionRows } = await client.query<{ id: string }>(
      `insert into opengeo.extractions (orthomosaic_id, model, prompt, qa_status)
       values ($1, 'test-model', 'buildings', 'pending')
       returning id`,
      [orthoRows[0].id],
    );

    await impersonate(userInvited);
    await client.query(
      `select opengeo.set_extraction_qa($1::uuid, 'human_reviewed')`,
      [extractionRows[0].id],
    );
    const { rows: updatedRows } = await client.query<{ qa_status: string }>(
      `select qa_status from opengeo.extractions where id = $1`,
      [extractionRows[0].id],
    );
    expect(updatedRows[0].qa_status).toBe("human_reviewed");

    await client.query(
      `update opengeo.extractions set qa_status = 'pending' where id = $1`,
      [extractionRows[0].id],
    );
    await impersonate(userProjectViewer);
    await expectSqlRejection(
      () =>
        client.query(
          `select opengeo.set_extraction_qa($1::uuid, 'human_reviewed')`,
          [extractionRows[0].id],
        ),
      /Not authorized/,
    );
  });
});
