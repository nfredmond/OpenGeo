import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import { logAiEvent } from "@/lib/ai/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({
  qaStatus: z.enum(["pending", "ai_ok", "human_reviewed", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

export const POST = withRoute<{ id: string }>(
  "extractions.setQa",
  async (req, ctx) => {
    const raw = await ctx.params;
    const paramsParsed = ParamsSchema.safeParse(raw);
    if (!paramsParsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid extraction id." }, { status: 400 });
    }

    const supabase = await supabaseServer();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const bodyParsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!bodyParsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body.", issues: bodyParsed.error.issues },
        { status: 400 },
      );
    }

    // set_extraction_qa self-authorizes via project-level editor access and
    // returns the output_layer_id so the client can refresh its view.
    const { data: layerId, error } = await supabase
      .schema("opengeo")
      .rpc("set_extraction_qa", {
        p_extraction_id: paramsParsed.data.id,
        p_qa_status: bodyParsed.data.qaStatus,
      });
    if (error) {
      const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 400;
      return NextResponse.json({ ok: false, error: error.message }, { status });
    }

    await logAiEvent({
      orgId: null,
      actorId: userData.user.id,
      kind: "extract",
      model: "qa-review",
      prompt: bodyParsed.data.note,
      responseSummary: `QA: ${bodyParsed.data.qaStatus}`,
      metadata: { extractionId: paramsParsed.data.id, outputLayerId: layerId },
    });

    return NextResponse.json({ ok: true, layerId, qaStatus: bodyParsed.data.qaStatus });
  },
);
