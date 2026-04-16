import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

// Service-role client. Bypasses RLS. Never expose to the browser.
// Use only for trusted server-side workflows (migrations runner, admin jobs).
export function supabaseService() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
