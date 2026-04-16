import "server-only";
import { NextResponse } from "next/server";
import { log } from "./logger";

// withRoute wraps a Next.js App Router handler with structured request
// logging + unhandled-error capture. Usage:
//
//   export const GET = withRoute("layers.list", async () => {
//     ...
//     return NextResponse.json({ ok: true });
//   });
//
// The wrapper records the HTTP method, path, status, duration, and a short
// request id for every invocation, and turns any thrown error into a 500
// JSON response so the client never sees an HTML Next.js error page.

type RouteContext<P = unknown> = { params: Promise<P> };
type Handler<P = unknown> = (
  req: Request,
  ctx: RouteContext<P>,
) => Promise<Response> | Response;

export function withRoute<P = unknown>(name: string, handler: Handler<P>): Handler<P> {
  return async function wrapped(req, ctx) {
    const start = performance.now();
    const requestId =
      req.headers.get("x-request-id") ??
      req.headers.get("x-vercel-id") ??
      newRequestId();
    const method = req.method;
    const path = pathOf(req);

    let response: Response;
    try {
      response = await handler(req, ctx);
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : "unknown error";
      const stack = err instanceof Error ? err.stack : undefined;
      log.error("route.unhandled", {
        route: name,
        method,
        path,
        requestId,
        durationMs,
        error: message,
        stack,
      });
      return NextResponse.json(
        { ok: false, error: "Internal error.", requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }

    const durationMs = Math.round(performance.now() - start);
    const status = response.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    log[level]("route.complete", {
      route: name,
      method,
      path,
      status,
      durationMs,
      requestId,
    });
    // Surface the request id to the client so support can correlate logs.
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function pathOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "<invalid-url>";
  }
}

function newRequestId(): string {
  // 12-hex-char id is enough for correlating logs on a single request;
  // not cryptographic.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
