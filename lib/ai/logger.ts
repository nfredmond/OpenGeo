import "server-only";
import { supabaseService } from "@/lib/supabase/service";

export type AiEvent = {
  orgId: string | null;
  actorId: string | null;
  kind: string;
  model: string;
  prompt?: string;
  responseSummary?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
};

// Best-effort write. We never block a request on logging; failures go to console.
export async function logAiEvent(event: AiEvent): Promise<void> {
  try {
    const client = supabaseService();
    const { error } = await client.from("ai_events").insert({
      org_id: event.orgId,
      actor: event.actorId,
      kind: event.kind,
      model: event.model,
      prompt: event.prompt,
      response_summary: event.responseSummary,
      tokens_in: event.tokensIn ?? null,
      tokens_out: event.tokensOut ?? null,
      cost_usd: event.costUsd ?? null,
      metadata: event.metadata ?? {},
    });
    if (error) console.error("ai_events insert failed:", error.message);
  } catch (e) {
    console.error("ai_events logger crashed:", (e as Error).message);
  }
}
