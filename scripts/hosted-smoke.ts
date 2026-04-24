#!/usr/bin/env tsx
import { createHmac, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const shpWrite = require("shp-write") as {
  zip(
    fc: GeoJSON.FeatureCollection,
    opts: {
      types: { point: string; polygon: string; line: string };
      outputType?: "nodebuffer" | "arraybuffer" | "base64" | "binarystring";
    },
  ): Buffer | ArrayBuffer | string;
};

const DEFAULT_BASE_URL = "https://opengeo.vercel.app";
const COOKIE_SPLIT_RE = /,(?=\s*[^;,]+=)/g;
const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

export type HostedSmokeArgs = {
  baseUrl: string;
  scope: "all";
  json: boolean;
};

export type SmokeStepName =
  | "health"
  | "auth"
  | "projects"
  | "geojson-upload"
  | "pmtiles"
  | "ai-query"
  | "shapefile-upload"
  | "ai-style"
  | "share-link"
  | "flight-diff";

export type SmokeStepResult = {
  step: SmokeStepName;
  ok: boolean;
  ms: number;
  note: string;
};

export type CleanupResult = {
  target: "r2" | "projects" | "orgs" | "auth-user";
  ok: boolean;
  count: number;
  error?: string;
};

export type HostedSmokeReport = {
  ok: boolean;
  baseUrl: string;
  runId: string;
  steps: SmokeStepResult[];
  cleanup: CleanupResult[];
};

export type SupabaseAdminLike = {
  auth: {
    admin: {
      createUser(input: {
        email: string;
        email_confirm: boolean;
        user_metadata?: Record<string, unknown>;
      }): Promise<{
        data: { user: { id: string } | null };
        error: { message: string } | null;
      }>;
      generateLink(input: {
        type: "magiclink";
        email: string;
        options?: { redirectTo?: string };
      }): Promise<{
        data: {
          properties?: {
            action_link?: string;
            hashed_token?: string;
          };
        };
        error: { message: string } | null;
      }>;
      deleteUser(userId: string): Promise<{ error: { message: string } | null }>;
    };
  };
  schema(schemaName: string): {
    from(table: string): QueryBuilderLike;
  };
};

type QueryBuilderLike = {
  select(columns?: string): QueryBuilderLike;
  eq(column: string, value: unknown): QueryBuilderLike;
  in(column: string, values: unknown[]): QueryBuilderLike;
  delete(): QueryBuilderLike;
  limit(count: number): QueryBuilderLike;
  maybeSingle<T = unknown>(): Promise<{ data: T | null; error: { message: string } | null }>;
  then?: (
    resolve: (value: { data: unknown[] | null; error: { message: string } | null }) => void,
    reject?: (reason: unknown) => void,
  ) => void;
};

type HostedSmokeDeps = {
  fetch: typeof fetch;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  now: () => Date;
  adminClient: SupabaseAdminLike;
  env: NodeJS.ProcessEnv;
};

type SmokeState = {
  userId: string | null;
  orgIds: Set<string>;
  projectIds: Set<string>;
  r2ObjectKeys: string[];
};

type ApiClient = {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body: unknown): Promise<T>;
  deleteJson<T>(path: string): Promise<T>;
  postForm<T>(path: string, form: FormData): Promise<T>;
};

type ApiOk = { ok: boolean; error?: string };

export function parseHostedSmokeArgs(argv: string[]): HostedSmokeArgs {
  let baseUrl = DEFAULT_BASE_URL;
  let scope: HostedSmokeArgs["scope"] = "all";
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--base-url") {
      const value = argv[++i];
      if (!value) throw new Error("--base-url requires a value.");
      baseUrl = value;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg === "--scope") {
      const value = argv[++i];
      if (!value) throw new Error("--scope requires a value.");
      if (value !== "all") throw new Error(`Unsupported --scope=${value}. Use --scope=all.`);
      scope = value;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (value !== "all") throw new Error(`Unsupported --scope=${value}. Use --scope=all.`);
      scope = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { baseUrl: normalizeBaseUrl(baseUrl), scope, json };
}

export function hostedSmokeExitCode(report: Pick<HostedSmokeReport, "ok">): number {
  return report.ok ? 0 : 1;
}

export function redactSensitive(message: string, sensitiveValues: string[]): string {
  let out = message;
  for (const value of sensitiveValues) {
    if (!value) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

export function splitSetCookieHeader(header: string): string[] {
  return header.split(COOKIE_SPLIT_RE).map((v) => v.trim()).filter(Boolean);
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  add(setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const first = header.split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get size(): number {
    return this.cookies.size;
  }
}

export async function cleanupTempSmoke(
  state: SmokeState,
  deps: {
    adminClient: SupabaseAdminLike;
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
  },
): Promise<CleanupResult[]> {
  const cleanup: CleanupResult[] = [];

  if (state.r2ObjectKeys.length > 0) {
    const result: CleanupResult = {
      target: "r2",
      ok: true,
      count: state.r2ObjectKeys.length,
    };
    for (const key of state.r2ObjectKeys) {
      try {
        await deleteR2Object(key, deps.env, deps.fetch);
      } catch (error) {
        result.ok = false;
        result.error = appendError(result.error, (error as Error).message);
      }
    }
    cleanup.push(result);
  }

  if (state.projectIds.size > 0) {
    cleanup.push(
      await cleanupDelete("projects", state.projectIds.size, async () => {
        await asPromise(
          deps.adminClient
            .schema("opengeo")
            .from("projects")
            .delete()
            .in("id", Array.from(state.projectIds)),
        );
      }),
    );
  }

  if (state.userId && state.orgIds.size === 0) {
    try {
      const { data, error } = await queryRows(
        deps.adminClient
          .schema("opengeo")
          .from("members")
          .select("org_id")
          .eq("user_id", state.userId)
          .limit(10),
      );
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const orgId = (row as { org_id?: unknown }).org_id;
        if (typeof orgId === "string") state.orgIds.add(orgId);
      }
    } catch (error) {
      cleanup.push({
        target: "orgs",
        ok: false,
        count: 0,
        error: (error as Error).message,
      });
    }
  }

  if (state.orgIds.size > 0) {
    cleanup.push(
      await cleanupDelete("orgs", state.orgIds.size, async () => {
        await asPromise(
          deps.adminClient
            .schema("opengeo")
            .from("orgs")
            .delete()
            .in("id", Array.from(state.orgIds)),
        );
      }),
    );
  }

  if (state.userId) {
    const result = await deps.adminClient.auth.admin.deleteUser(state.userId);
    cleanup.push({
      target: "auth-user",
      ok: !result.error,
      count: 1,
      error: result.error?.message,
    });
  }

  return cleanup;
}

export async function runHostedSmoke(
  args: HostedSmokeArgs,
  deps: HostedSmokeDeps,
): Promise<HostedSmokeReport> {
  requireEnv(deps.env, [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  const state: SmokeState = {
    userId: null,
    orgIds: new Set<string>(),
    projectIds: new Set<string>(),
    r2ObjectKeys: [],
  };
  const steps: SmokeStepResult[] = [];
  const runId = smokeRunId(deps.now());
  const jar = new CookieJar();
  const api = apiClient(args.baseUrl, jar, deps.fetch);
  let stop = false;

  const logStep = (result: SmokeStepResult) => {
    if (args.json) return;
    const mark = result.ok ? "✓" : "✗";
    deps.stdout(`  ${mark} ${result.step}${result.note ? ` — ${result.note}` : ""} (${result.ms}ms)`);
  };

  const step = async (name: SmokeStepName, fn: () => Promise<string>) => {
    if (stop) return;
    const started = Date.now();
    try {
      const note = await fn();
      const result = { step: name, ok: true, note, ms: Date.now() - started };
      steps.push(result);
      logStep(result);
    } catch (error) {
      const result = {
        step: name,
        ok: false,
        note: publicError(error),
        ms: Date.now() - started,
      };
      steps.push(result);
      logStep(result);
      stop = true;
    }
  };

  if (!args.json) {
    deps.stdout("OpenGeo hosted smoke");
    deps.stdout(`  base: ${args.baseUrl}`);
    deps.stdout(`  run: ${runId}`);
    deps.stdout("");
  }

  let project: { id: string; slug: string } | null = null;
  let geojsonLayerId: string | null = null;
  let shapefileLayerId: string | null = null;
  let diffFromLayerId: string | null = null;
  let diffToLayerId: string | null = null;
  let shareToken: { token: string; id: string } | null = null;

  try {
    await step("health", async () => {
      const body = await api.getJson<ApiOk & { status?: string }>("/api/health");
      if (body.status !== "ok" && body.ok !== true) {
        throw new Error(body.error ?? "Health check failed.");
      }
      return `status=${body.status ?? "ok"}`;
    });

    await step("auth", async () => {
      const email = `${runId}@example.invalid`;
      const created = await deps.adminClient.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { opengeo_smoke_run: runId },
      });
      if (created.error) throw new Error(created.error.message);
      const userId = created.data.user?.id;
      if (!userId) throw new Error("Supabase did not return a user id.");
      state.userId = userId;
      await captureUserOrg(userId, deps.adminClient, state);

      const generated = await deps.adminClient.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo: `${args.baseUrl}/auth/callback?next=/projects` },
      });
      if (generated.error) throw new Error(generated.error.message);
      const props = generated.data.properties ?? {};
      const callbackUrl = props.hashed_token
        ? `${args.baseUrl}/auth/callback?token_hash=${encodeURIComponent(props.hashed_token)}&type=magiclink&next=/projects`
        : props.action_link;
      if (!callbackUrl) throw new Error("Supabase did not return a magic-link token.");

      await followRedirectsForCookies(callbackUrl, args.baseUrl, jar, deps.fetch);
      if (jar.size === 0) throw new Error("Auth callback did not set session cookies.");
      return `session established`;
    });

    await step("projects", async () => {
      const slug = runId;
      const body = await api.postJson<ApiOk & { project?: { id: string; slug: string } }>(
        "/api/projects",
        {
          name: `OpenGeo hosted smoke ${runId}`,
          slug,
          visibility: "private",
        },
      );
      if (!body.ok || !body.project?.id) throw new Error(body.error ?? "Project create failed.");
      project = { id: body.project.id, slug: body.project.slug };
      state.projectIds.add(project.id);

      const list = await api.getJson<ApiOk & { projects?: Array<{ id: string }> }>("/api/projects");
      if (!list.ok) throw new Error(list.error ?? "Project list failed.");
      if (!(list.projects ?? []).some((p) => p.id === project?.id)) {
        throw new Error("Created project was not visible in project list.");
      }
      return `project=${project.slug}`;
    });

    await step("geojson-upload", async () => {
      if (!project) throw new Error("Project was not created.");
      const body = await api.postJson<ApiOk & { layerId?: string }>(
        "/api/datasets/upload",
        {
          name: `Smoke parcels ${runId}`,
          projectId: project.id,
          featureCollection: smokeGeoJsonFixture(runId),
        },
      );
      if (!body.ok || !body.layerId) throw new Error(body.error ?? "GeoJSON upload failed.");
      geojsonLayerId = body.layerId;
      return `layer=${shortId(geojsonLayerId)}`;
    });

    await step("pmtiles", async () => {
      if (!project || !geojsonLayerId) throw new Error("GeoJSON layer was not created.");
      const readiness = await api.getJson<ApiOk & { readiness?: { ok?: boolean } }>(
        "/api/pmtiles/publish",
      );
      if (!readiness.ok || readiness.readiness?.ok !== true) {
        throw new Error(readiness.error ?? "PMTiles readiness failed.");
      }

      const body = await api.postJson<
        ApiOk & {
          pmtiles?: { url?: string; objectKey?: string; bytes?: number };
          layer?: { id?: string };
        }
      >("/api/pmtiles/publish", {
        projectId: project.id,
        layerId: geojsonLayerId,
        name: `Smoke PMTiles ${runId}`,
        sourceLayer: "smoke",
        minzoom: 0,
        maxzoom: 12,
      });
      if (!body.ok || !body.pmtiles?.url) throw new Error(body.error ?? "PMTiles publish failed.");
      if (body.pmtiles.objectKey) state.r2ObjectKeys.push(body.pmtiles.objectKey);

      const range = await deps.fetch(body.pmtiles.url, {
        headers: { range: "bytes=0-15" },
      });
      if (![200, 206].includes(range.status)) {
        throw new Error(`Public PMTiles fetch failed with HTTP ${range.status}.`);
      }
      const header = new Uint8Array(await range.arrayBuffer());
      if (header.byteLength === 0) throw new Error("Public PMTiles fetch returned zero bytes.");
      return `${body.pmtiles.bytes ?? 0} bytes`;
    });

    await step("ai-query", async () => {
      const prompt = `Show me all OpenGeo hosted smoke features for run ${runId}.`;
      const body = await api.postJson<
        ApiOk & { sql?: string; featureCollection?: GeoJSON.FeatureCollection }
      >("/api/ai/query", { prompt });
      if (!body.ok || !body.sql) throw new Error(body.error ?? "AI query failed.");
      await expectAiEvent(api, "nl_sql", (event) => event.prompt === prompt);
      const count = body.featureCollection?.features?.length ?? 0;
      return `${count} feature(s)`;
    });

    await step("shapefile-upload", async () => {
      if (!project) throw new Error("Project was not created.");
      const layerName = `Smoke shapefile ${runId}`;
      const form = new FormData();
      form.set("projectId", project.id);
      form.set("name", layerName);
      const zipBytes = await smokeShapefileZip(runId);
      const zipBody = new ArrayBuffer(zipBytes.byteLength);
      new Uint8Array(zipBody).set(zipBytes);
      form.set("file", new Blob([zipBody], { type: "application/zip" }), `${runId}.zip`);
      const body = await api.postForm<
        ApiOk & { layerId?: string; crs?: { epsg?: number }; columns?: unknown[] }
      >("/api/datasets/upload", form);
      if (!body.ok || !body.layerId) throw new Error(body.error ?? "Shapefile upload failed.");
      shapefileLayerId = body.layerId;
      await expectAiEvent(api, "crs_detect", eventMetadataMatch("layerName", layerName));
      await expectAiEvent(api, "column_type_infer", eventMetadataMatch("layerName", layerName));
      return `layer=${shortId(shapefileLayerId)} epsg=${body.crs?.epsg ?? "unknown"}`;
    });

    await step("ai-style", async () => {
      if (!shapefileLayerId) throw new Error("Shapefile layer was not created.");
      const prompt = `Make smoke run ${runId} polygons red with a thin white outline.`;
      const body = await api.postJson<
        ApiOk & { patch?: { paint?: Record<string, unknown>; layout?: Record<string, unknown> } }
      >(`/api/layers/${shapefileLayerId}/ai-style`, { prompt });
      if (!body.ok) throw new Error(body.error ?? "AI style failed.");
      const patchSize =
        Object.keys(body.patch?.paint ?? {}).length + Object.keys(body.patch?.layout ?? {}).length;
      if (patchSize === 0) throw new Error("AI style returned an empty patch.");
      await expectAiEvent(api, "nl_style", (event) => event.prompt === prompt);
      return `${patchSize} style key(s)`;
    });

    await step("share-link", async () => {
      if (!project) throw new Error("Project was not created.");
      const body = await api.postJson<ApiOk & { token?: string; id?: string }>(
        `/api/projects/${project.slug}/share-links?projectId=${encodeURIComponent(project.id)}`,
        {
          label: `Smoke ${runId}`,
          scopes: ["read:layers", "read:orthomosaics"],
        },
      );
      if (!body.ok || !body.token || !body.id) throw new Error(body.error ?? "Share mint failed.");
      shareToken = { token: body.token, id: body.id };

      const publicProject = await fetchJson<ApiOk>(
        deps.fetch,
        `${args.baseUrl}/api/share/${encodeURIComponent(shareToken.token)}/project`,
        "public share project",
      );
      if (!publicProject.ok) throw new Error(publicProject.error ?? "Public project read failed.");
      const publicLayers = await fetchJson<ApiOk & { layers?: unknown[] }>(
        deps.fetch,
        `${args.baseUrl}/api/share/${encodeURIComponent(shareToken.token)}/layers`,
        "public share layers",
      );
      if (!publicLayers.ok || !Array.isArray(publicLayers.layers)) {
        throw new Error(publicLayers.error ?? "Public layers read failed.");
      }

      const revoked = await api.deleteJson<ApiOk>(
        `/api/projects/${project.slug}/share-links/${shareToken.id}?projectId=${encodeURIComponent(project.id)}`,
      );
      if (!revoked.ok) throw new Error(revoked.error ?? "Share revoke failed.");
      const afterRevoke = await deps.fetch(
        `${args.baseUrl}/api/share/${encodeURIComponent(shareToken.token)}/project`,
      );
      if (afterRevoke.status !== 404) {
        throw new Error(`Revoked share returned HTTP ${afterRevoke.status}, expected 404.`);
      }
      return `${publicLayers.layers.length} public layer(s)`;
    });

    await step("flight-diff", async () => {
      if (!project) throw new Error("Project was not created.");
      const from = await api.postJson<ApiOk & { layerId?: string }>("/api/datasets/upload", {
        name: `Smoke flight before ${runId}`,
        projectId: project.id,
        featureCollection: smokeBeforeFlightFixture(runId),
      });
      if (!from.ok || !from.layerId) throw new Error(from.error ?? "Before layer upload failed.");
      diffFromLayerId = from.layerId;

      const to = await api.postJson<ApiOk & { layerId?: string }>("/api/datasets/upload", {
        name: `Smoke flight after ${runId}`,
        projectId: project.id,
        featureCollection: smokeAfterFlightFixture(runId),
      });
      if (!to.ok || !to.layerId) throw new Error(to.error ?? "After layer upload failed.");
      diffToLayerId = to.layerId;

      const body = await api.postJson<
        ApiOk & {
          counts?: { added: number; removed: number; modified: number };
          narrative?: string | null;
        }
      >("/api/flights/diff", {
        fromLayerId: diffFromLayerId,
        toLayerId: diffToLayerId,
        outputName: `Smoke diff ${runId}`,
      });
      if (!body.ok || !body.counts) throw new Error(body.error ?? "Flight diff failed.");
      const expected = { added: 1, removed: 1, modified: 1 };
      if (
        body.counts.added !== expected.added ||
        body.counts.removed !== expected.removed ||
        body.counts.modified !== expected.modified
      ) {
        throw new Error(`Unexpected diff counts: ${JSON.stringify(body.counts)}.`);
      }
      if (!body.narrative) throw new Error("Flight diff did not return an AI narrative.");
      await expectAiEvent(api, "change_detect", (event) =>
        String(event.response_summary ?? "").includes("added=1"),
      );
      await expectAiEvent(api, "change_narrate", (event) =>
        String(event.response_summary ?? "").length > 0,
      );
      return `added=1 removed=1 modified=1`;
    });
  } finally {
    const cleanup = await cleanupTempSmoke(state, {
      adminClient: deps.adminClient,
      env: deps.env,
      fetch: deps.fetch,
    });
    const ok = !stop && steps.every((s) => s.ok) && cleanup.every((c) => c.ok);
    if (!args.json && cleanup.length > 0) {
      deps.stdout("");
      for (const c of cleanup) {
        const mark = c.ok ? "✓" : "✗";
        deps.stdout(`  ${mark} cleanup ${c.target} (${c.count})${c.error ? ` — ${c.error}` : ""}`);
      }
    }
    return { ok, baseUrl: args.baseUrl, runId, steps, cleanup };
  }
}

async function captureUserOrg(
  userId: string,
  adminClient: SupabaseAdminLike,
  state: SmokeState,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const { data, error } = await adminClient
      .schema("opengeo")
      .from("members")
      .select("org_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle<{ org_id: string }>();
    if (error) {
      lastError = error.message;
    } else if (data?.org_id) {
      state.orgIds.add(data.org_id);
      return;
    }
    await sleep(250);
  }
  throw new Error(lastError || "Timed out waiting for auth bootstrap membership.");
}

function apiClient(baseUrl: string, jar: CookieJar, fetchImpl: typeof fetch): ApiClient {
  const request = async <T>(
    path: string,
    init: RequestInit & { jsonBody?: unknown } = {},
  ): Promise<T> => {
    const headers = new Headers(init.headers);
    const cookie = jar.header();
    if (cookie) headers.set("cookie", cookie);
    if (init.jsonBody !== undefined) headers.set("content-type", "application/json");
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      body: init.jsonBody !== undefined ? JSON.stringify(init.jsonBody) : init.body,
    });
    jar.add(extractSetCookie(res.headers));
    const body = await readJson<T>(res);
    if (!res.ok) throw new Error(responseError(path, res.status, body));
    return body;
  };
  return {
    getJson: (path) => request(path),
    postJson: (path, body) => request(path, { method: "POST", jsonBody: body }),
    deleteJson: (path) => request(path, { method: "DELETE" }),
    postForm: (path, form) => request(path, { method: "POST", body: form }),
  };
}

async function followRedirectsForCookies(
  startUrl: string,
  baseUrl: string,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<void> {
  let url = startUrl;
  for (let i = 0; i < 8; i++) {
    const headers = new Headers();
    const cookie = jar.header();
    if (cookie) headers.set("cookie", cookie);
    const res = await fetchImpl(url, { redirect: "manual", headers });
    jar.add(extractSetCookie(res.headers));
    if (res.status < 300 || res.status >= 400) return;
    const location = res.headers.get("location");
    if (!location) return;
    url = new URL(location, url.startsWith("http") ? url : baseUrl).toString();
  }
  throw new Error("Auth redirect chain exceeded 8 hops.");
}

function extractSetCookie(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  label = url,
): Promise<T> {
  const res = await fetchImpl(url);
  const body = await readJson<T>(res);
  if (!res.ok) throw new Error(responseError(label, res.status, body));
  return body;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { ok: false, error: text.slice(0, 240) } as T;
  }
}

function responseError(path: string, status: number, body: unknown): string {
  const error =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "Request failed.";
  return `${path} returned HTTP ${status}: ${error}`;
}

type AiEvent = {
  kind?: string;
  prompt?: string | null;
  response_summary?: string | null;
  metadata?: Record<string, unknown> | null;
};

async function expectAiEvent(
  api: ApiClient,
  kind: string,
  match: (event: AiEvent) => boolean,
): Promise<void> {
  const body = await api.getJson<ApiOk & { events?: AiEvent[] }>(
    `/api/ai-events?kind=${encodeURIComponent(kind)}`,
  );
  if (!body.ok) throw new Error(body.error ?? `Could not read ${kind} audit events.`);
  if (!(body.events ?? []).some((event) => event.kind === kind && match(event))) {
    throw new Error(`No matching ${kind} audit event was visible.`);
  }
}

function eventMetadataMatch(key: string, value: string): (event: AiEvent) => boolean {
  return (event) => event.metadata?.[key] === value;
}

function smokeGeoJsonFixture(runId: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      squareFeature("parcel-a", -121.061, 39.221, 0.00018, { runId, kind: "parcel", score: 1 }),
      squareFeature("parcel-b", -121.0605, 39.2214, 0.00016, { runId, kind: "parcel", score: 2 }),
    ],
  };
}

async function smokeShapefileZip(runId: string): Promise<Uint8Array> {
  const fc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      squareFeature("shape-a", -121.059, 39.222, 0.00014, {
        runId,
        kind: "inspection",
        height: 12,
      }),
      squareFeature("shape-b", -121.0585, 39.2224, 0.00012, {
        runId,
        kind: "inspection",
        height: 18,
      }),
    ],
  };
  const raw = shpWrite.zip(fc, {
    types: { point: "smoke_points", polygon: "smoke_polygons", line: "smoke_lines" },
    outputType: "nodebuffer",
  });
  const bytes =
    typeof raw === "string"
      ? Buffer.from(raw, "binary")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : raw;
  const zip = await JSZip.loadAsync(bytes);
  zip.file("smoke_polygons.prj", WGS84_PRJ);
  return zip.generateAsync({ type: "uint8array" });
}

function smokeBeforeFlightFixture(runId: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      squareFeature("modified", -121.057, 39.223, 0.00018, { runId, label: "modified" }),
      squareFeature("removed", -121.0562, 39.2236, 0.00018, { runId, label: "removed" }),
    ],
  };
}

function smokeAfterFlightFixture(runId: string): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      squareFeature("modified", -121.056965, 39.223, 0.00018, {
        runId,
        label: "modified",
      }),
      squareFeature("added", -121.0554, 39.2242, 0.00018, { runId, label: "added" }),
    ],
  };
}

function squareFeature(
  id: string,
  lon: number,
  lat: number,
  size: number,
  properties: Record<string, unknown>,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const half = size / 2;
  return {
    type: "Feature",
    id,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lon - half, lat - half],
          [lon + half, lat - half],
          [lon + half, lat + half],
          [lon - half, lat + half],
          [lon - half, lat - half],
        ],
      ],
    },
    properties: { id, ...properties },
  };
}

async function deleteR2Object(
  key: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<void> {
  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ] as const;
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing R2 cleanup configuration: ${missing.join(", ")}`);
  }

  const accountId = env.R2_ACCOUNT_ID!;
  const bucket = env.R2_BUCKET!;
  const secret = env.R2_SECRET_ACCESS_KEY!;
  const accessKeyId = env.R2_ACCESS_KEY_ID!;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePathPart(bucket)}/${encodeKey(key)}`;
  const endpoint = `https://${host}${canonicalUri}`;
  const payloadHash = sha256Hex("");
  const amzDate = toAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    "DELETE",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(secret, dateStamp), stringToSign);
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  const res = await fetchImpl(endpoint, {
    method: "DELETE",
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    },
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`R2 delete failed: ${res.status} ${detail}`.trim());
  }
}

function signingKey(secret: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodePathPart).join("/");
}

function encodePathPart(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function cleanupDelete(
  target: CleanupResult["target"],
  count: number,
  fn: () => Promise<void>,
): Promise<CleanupResult> {
  return fn()
    .then(() => ({ target, ok: true, count }))
    .catch((error: Error) => ({ target, ok: false, count, error: error.message }));
}

async function asPromise(query: QueryBuilderLike): Promise<void> {
  const result = await new Promise<{ error: { message: string } | null }>((resolve, reject) => {
    if (typeof query.then !== "function") {
      resolve({ error: null });
      return;
    }
    query.then(
      (value) => resolve({ error: value.error }),
      (reason) => reject(reason),
    );
  });
  if (result.error) throw new Error(result.error.message);
}

async function queryRows(
  query: QueryBuilderLike,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  return new Promise((resolve, reject) => {
    if (typeof query.then !== "function") {
      resolve({ data: [], error: null });
      return;
    }
    query.then(resolve, reject);
  });
}

function appendError(existing: string | undefined, next: string): string {
  return existing ? `${existing}; ${next}` : next;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function smokeRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `opengeo-smoke-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function requireEnv(env: NodeJS.ProcessEnv, names: string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let args: HostedSmokeArgs;
  try {
    args = parseHostedSmokeArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  const sensitive = [
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    process.env.R2_SECRET_ACCESS_KEY ?? "",
    process.env.R2_ACCESS_KEY_ID ?? "",
    process.env.PMTILES_GENERATOR_TOKEN ?? "",
  ];

  try {
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    ) as unknown as SupabaseAdminLike;
    const report = await runHostedSmoke(args, {
      fetch,
      stdout: (message) => console.log(redactSensitive(message, sensitive)),
      stderr: (message) => console.error(redactSensitive(message, sensitive)),
      now: () => new Date(),
      adminClient,
      env: process.env,
    });
    if (args.json) {
      console.log(redactSensitive(JSON.stringify(report, null, 2), sensitive));
    } else {
      console.log("");
      console.log(`Hosted smoke: ${report.ok ? "PASS" : "FAIL"}`);
    }
    process.exitCode = hostedSmokeExitCode(report);
  } catch (error) {
    const message = redactSensitive((error as Error).message, sensitive);
    if (args.json) {
      console.log(
        JSON.stringify({
          ok: false,
          baseUrl: args.baseUrl,
          runId: null,
          steps: [],
          cleanup: [],
          error: message,
        }),
      );
    } else {
      console.error(`Hosted smoke crashed: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
