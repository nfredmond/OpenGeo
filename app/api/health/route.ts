import { NextResponse } from "next/server";
import { withRoute } from "@/lib/observability/with-route";
import { env, flag } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check =
  | { name: string; status: "ok"; details?: string }
  | { name: string; status: "degraded" | "down"; error: string };

export const GET = withRoute("health.get", async (req) => {
  const url = new URL(req.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    return NextResponse.json({
      status: "ok",
      service: "opengeo-web",
      version: "0.0.1",
      ts: new Date().toISOString(),
    });
  }

  const checks = await Promise.all([
    checkSupabase(),
    checkUrl("martin", env().LOCAL_MARTIN_URL, "/health"),
    checkUrl("titiler", env().LOCAL_TITILER_URL, "/healthz"),
    checkUrl("pg_featureserv", env().LOCAL_PG_FEATURESERV_URL, "/health.json"),
    flag.dronePipeline()
      ? checkUrl("nodeodm", env().ODM_API_URL || "http://localhost:3002", "/info")
      : Promise.resolve<Check>({ name: "nodeodm", status: "ok", details: "disabled" }),
  ]);

  const downCount = checks.filter((c) => c.status === "down").length;
  const status = downCount === 0 ? "ok" : downCount >= 3 ? "down" : "degraded";

  return NextResponse.json(
    {
      status,
      service: "opengeo-web",
      version: "0.0.1",
      ts: new Date().toISOString(),
      flags: {
        aiNlSql: flag.aiNlSql(),
        aiStyleGen: flag.aiStyleGen(),
        aiFeatureExtraction: flag.aiFeatureExtraction(),
        dronePipeline: flag.dronePipeline(),
        anthropicKeySet: Boolean(env().ANTHROPIC_API_KEY),
      },
      checks,
    },
    { status: status === "down" ? 503 : 200 },
  );
});

async function checkSupabase(): Promise<Check> {
  try {
    const supabase = await supabaseServer();
    const { error } = await supabase.schema("opengeo").from("orgs").select("id").limit(1);
    if (error) return { name: "supabase", status: "degraded", error: error.message };
    return { name: "supabase", status: "ok" };
  } catch (e) {
    return { name: "supabase", status: "down", error: (e as Error).message };
  }
}

async function checkUrl(name: string, base: string, path: string): Promise<Check> {
  if (!base) return { name, status: "degraded", error: "no URL configured" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(base.replace(/\/$/, "") + path, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok && res.status !== 404) {
      return { name, status: "degraded", error: `HTTP ${res.status}` };
    }
    // Some services (NodeODM /info) return 200 JSON; Martin /health returns
    // plain text. We don't parse, just confirm a response.
    return { name, status: "ok" };
  } catch (e) {
    const err = e as Error;
    return {
      name,
      status: "down",
      error: err.name === "AbortError" ? "timeout after 3s" : err.message,
    };
  }
}
