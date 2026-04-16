import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_BASEMAP_PMTILES_URL: z.string().optional().default(""),
  NEXT_PUBLIC_MARTIN_URL: z.string().optional().default("http://localhost:3001"),
});

export const publicEnv = schema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_BASEMAP_PMTILES_URL: process.env.NEXT_PUBLIC_BASEMAP_PMTILES_URL,
  NEXT_PUBLIC_MARTIN_URL: process.env.NEXT_PUBLIC_MARTIN_URL,
});

export type PublicEnv = typeof publicEnv;
