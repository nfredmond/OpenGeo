import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { env } from "@/lib/env";
import type { ChangeType, Thresholds } from "./feature-diff";

export type NarrationInput = {
  fromLayerName: string;
  toLayerName: string;
  counts: Record<ChangeType, number>;
  thresholdsUsed: Thresholds;
  // A few example property snapshots (up to ~6) to give the model flavor
  // without leaking the entire payload into the prompt.
  samples?: Array<{
    changeType: ChangeType;
    properties: Record<string, unknown>;
  }>;
};

export type NarrationResult = {
  text: string;
  model: string;
};

export async function narrateDiff(input: NarrationInput): Promise<NarrationResult> {
  const model = env().ANTHROPIC_MODEL;
  const { text } = await generateText({
    model: anthropic(model),
    system:
      "You summarize drone-site change detection results for planners. Keep the tone matter-of-fact, name the counts, and note any obvious pattern. Plain English. 3–4 sentences. Do not speculate beyond the data provided. No bullet points.",
    prompt: buildPrompt(input),
    temperature: 0,
  });
  return { text: text.trim(), model };
}

function buildPrompt(input: NarrationInput): string {
  const lines: string[] = [];
  lines.push(`From layer: ${input.fromLayerName}`);
  lines.push(`To layer: ${input.toLayerName}`);
  lines.push(
    `Counts — added: ${input.counts.added}, removed: ${input.counts.removed}, modified: ${input.counts.modified}`,
  );
  lines.push(
    `Thresholds used — distance: ${input.thresholdsUsed.distanceMeters} m; IoU: ${input.thresholdsUsed.iouThreshold}; modified-shift: ${input.thresholdsUsed.modifiedDistanceMeters ?? "—"} m.`,
  );
  if (input.samples && input.samples.length > 0) {
    lines.push("Example features:");
    for (const s of input.samples.slice(0, 6)) {
      lines.push(`- [${s.changeType}] ${JSON.stringify(s.properties).slice(0, 200)}`);
    }
  }
  lines.push(
    "Write the summary now. Call out when one category dominates, and mention that polygon matches use an IoU estimate (not exact) if relevant.",
  );
  return lines.join("\n");
}
