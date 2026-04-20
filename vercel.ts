// OpenGeo — Vercel project config (TypeScript).
// Uses @vercel/config (v1) per the 2026-02 Vercel knowledge update.

import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "nextjs",
  buildCommand: "pnpm build",
  installCommand: "pnpm install --frozen-lockfile",

  // Co-locate function regions with Supabase. Default us-west-2 to match the
  // Oregon region commonly selected for Supabase Pro. Adjust once Supabase
  // region is confirmed in the dashboard.
  regions: ["pdx1"],

  headers: [
    {
      source: "/api/(.*)",
      headers: [
        { key: "x-powered-by", value: "OpenGeo" },
        { key: "cache-control", value: "private, no-store" },
      ],
    },
    {
      // Long cache for PMTiles / static map assets served via Next.
      source: "/map-assets/(.*)",
      headers: [
        { key: "cache-control", value: "public, max-age=31536000, immutable" },
      ],
    },
  ],

  // Crons added in Phase 1+ for: ODM job polling, AI cost rollups, usage metering.
  crons: [],
};

export default config;
