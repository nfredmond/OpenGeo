import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Handles the magic-link redirect. Supabase sends either an auth code
// (PKCE flow) or a token hash (email confirm flow) — we exchange whichever
// one arrives and redirect the user to `next`.
export const GET = withRoute("auth.callback", async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const next = sanitizeNext(url.searchParams.get("next"));

  const supabase = await supabaseServer();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirectToLogin(url, next, error.message);
    return NextResponse.redirect(new URL(next, url.origin));
  }

  if (tokenHash && type) {
    // token_hash flow is always email-originated (magiclink, signup, recovery,
    // invite, email_change). SMS flows never round-trip through this callback.
    const emailTypes = ["magiclink", "signup", "recovery", "invite", "email_change", "email"] as const;
    type EmailOtp = (typeof emailTypes)[number];
    if (!(emailTypes as readonly string[]).includes(type)) {
      return redirectToLogin(url, next, `Unsupported verification type: ${type}`);
    }
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtp,
      token_hash: tokenHash,
    });
    if (error) return redirectToLogin(url, next, error.message);
    return NextResponse.redirect(new URL(next, url.origin));
  }

  return redirectToLogin(url, next, "Missing auth code.");
});

function redirectToLogin(url: URL, next: string, message: string): NextResponse {
  const target = new URL("/login", url.origin);
  target.searchParams.set("next", next);
  target.searchParams.set("error", message);
  return NextResponse.redirect(target);
}

function sanitizeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/map";
  // Prevent open-redirects to protocol-relative URLs like "//evil.com".
  if (raw.startsWith("//")) return "/map";
  return raw;
}
