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
    const orgId = event.orgId ?? (await resolveActorOrgId(client, event.actorId));
    // `ai_events` lives in the `opengeo` schema. Without `.schema("opengeo")`,
    // PostgREST routes the insert to `public.ai_events` (the first schema in
    // `db_schemas`) which doesn't exist — and the error is only `console.error`d,
    // so /review's audit log silently stays empty.
    const { error } = await client.schema("opengeo").from("ai_events").insert({
      org_id: orgId,
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

async function resolveActorOrgId(
  client: ReturnType<typeof supabaseService>,
  actorId: string | null,
): Promise<string | null> {
  if (!actorId) return null;

  const { data: projectId, error: projectErr } = await client
    .schema("opengeo")
    .rpc("default_project_for", { p_user_id: actorId });
  if (projectErr || typeof projectId !== "string") return null;

  const { data: project, error: orgErr } = await client
    .schema("opengeo")
    .from("projects")
    .select("org_id")
    .eq("id", projectId)
    .maybeSingle<{ org_id: string }>();
  if (orgErr) return null;

  return project?.org_id ?? null;
}
