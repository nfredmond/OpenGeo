"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/public-env";

let cached: ReturnType<typeof createBrowserClient> | undefined;

export function supabaseClient() {
  if (cached) return cached;
  cached = createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return cached;
}
