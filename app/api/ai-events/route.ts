import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_KINDS = [
  "nl_sql",
  "nl_style",
  "crs_detect",
  "column_type_infer",
] as const;
type AllowedKind = (typeof ALLOWED_KINDS)[number];
const PAGE_SIZE = 50;

// Lists recent AI audit events for /review's audit log tab. RLS on
// opengeo.ai_events restricts reads to org admins — non-admin callers
// get zero rows back rather than an error, which lets the UI render a
// single honest empty-state message.
//
// Pagination: ?offset=N returns rows [N, N + PAGE_SIZE). The response's
// `hasMore` is set when the page came back full — a best-effort signal the UI
// uses to show a "Load more" button without a second HEAD/count round-trip.
export const GET = withRoute("ai_events.list", async (req) => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json(
      { ok: false, error: "Not authenticated." },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  const kinds: AllowedKind[] = (
    ALLOWED_KINDS as ReadonlyArray<string>
  ).includes(kindParam ?? "")
    ? [kindParam as AllowedKind]
    : [...ALLOWED_KINDS];

  const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const { data, error } = await supabase
    .schema("opengeo")
    .from("ai_events")
    .select(
      "id, kind, model, prompt, response_summary, metadata, created_at",
    )
    .in("kind", kinds)
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  const events = data ?? [];
  return NextResponse.json({
    ok: true,
    events,
    hasMore: events.length === PAGE_SIZE,
    offset,
    pageSize: PAGE_SIZE,
  });
});
