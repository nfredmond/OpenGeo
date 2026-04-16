import { NextResponse } from "next/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";

export const GET = withRoute("health.get", async () =>
  NextResponse.json({
    status: "ok",
    service: "opengeo-web",
    version: "0.0.1",
    ts: new Date().toISOString(),
  }),
);
