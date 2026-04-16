import "server-only";
import { z } from "zod";

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  SUPABASE_DB_URL: z.string().optional().default(""),
  LOCAL_DB_URL: z.string().optional().default(""),
  LOCAL_MARTIN_URL: z.string().optional().default("http://localhost:3001"),
  LOCAL_TITILER_URL: z.string().optional().default("http://localhost:8000"),
  LOCAL_PG_FEATURESERV_URL: z.string().optional().default("http://localhost:9000"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-7"),
  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET: z.string().default("opengeo-assets"),
  R2_PUBLIC_BASE_URL: z.string().optional().default(""),
  ODM_API_URL: z.string().optional().default(""),
  ODM_API_TOKEN: z.string().optional().default(""),
  FEATURE_AI_NL_SQL: z.enum(["true", "false"]).default("true"),
  FEATURE_AI_STYLE_GEN: z.enum(["true", "false"]).default("true"),
  FEATURE_AI_FEATURE_EXTRACTION: z.enum(["true", "false"]).default("false"),
  FEATURE_DRONE_PIPELINE: z.enum(["true", "false"]).default("false"),
  FEATURE_DURABLE_PIPELINE: z.enum(["true", "false"]).default("false"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid server env:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid server environment. See .env.example.");
  }
  cached = parsed.data;
  return cached;
}

export const flag = {
  aiNlSql: () => env().FEATURE_AI_NL_SQL === "true",
  aiStyleGen: () => env().FEATURE_AI_STYLE_GEN === "true",
  aiFeatureExtraction: () => env().FEATURE_AI_FEATURE_EXTRACTION === "true",
  dronePipeline: () => env().FEATURE_DRONE_PIPELINE === "true",
  durablePipeline: () => env().FEATURE_DURABLE_PIPELINE === "true",
};
