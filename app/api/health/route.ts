import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "opengeo-web",
    version: "0.0.1",
    ts: new Date().toISOString(),
  });
}
