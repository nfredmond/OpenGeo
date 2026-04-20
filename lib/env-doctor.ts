export type EnvDoctorTarget = "local" | "preview" | "production";
export type EnvDoctorScope = "core" | "pmtiles" | "ai" | "drone" | "all";
export type EnvDoctorStatus = "pass" | "warn" | "fail" | "skip";

export type EnvDoctorCheck = {
  id: string;
  scope: Exclude<EnvDoctorScope, "all">;
  status: EnvDoctorStatus;
  message: string;
  keys?: string[];
};

export type EnvDoctorReport = {
  target: EnvDoctorTarget;
  scopes: Exclude<EnvDoctorScope, "all">[];
  ok: boolean;
  failures: number;
  warnings: number;
  checks: EnvDoctorCheck[];
};

type EnvRecord = Record<string, string | undefined>;

const ALL_SCOPES: Exclude<EnvDoctorScope, "all">[] = [
  "core",
  "pmtiles",
  "ai",
  "drone",
];

const FEATURE_FLAGS = [
  "FEATURE_AI_NL_SQL",
  "FEATURE_AI_STYLE_GEN",
  "FEATURE_AI_FEATURE_EXTRACTION",
  "FEATURE_DRONE_PIPELINE",
  "FEATURE_DURABLE_PIPELINE",
] as const;

const R2_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
] as const;

export function normalizeEnvDoctorScopes(
  scopes: EnvDoctorScope[] | undefined,
): Exclude<EnvDoctorScope, "all">[] {
  if (!scopes?.length || scopes.includes("all")) return ALL_SCOPES;
  const normalized: Exclude<EnvDoctorScope, "all">[] = [];
  for (const scope of scopes) {
    if (scope === "all") continue;
    if (!normalized.includes(scope)) normalized.push(scope);
  }
  return normalized.length ? normalized : ALL_SCOPES;
}

export function runEnvDoctor({
  env,
  target = "local",
  scopes,
}: {
  env: EnvRecord;
  target?: EnvDoctorTarget;
  scopes?: EnvDoctorScope[];
}): EnvDoctorReport {
  const activeScopes = normalizeEnvDoctorScopes(scopes);
  const checks: EnvDoctorCheck[] = [];

  if (activeScopes.includes("core")) checks.push(...coreChecks(env, target));
  if (activeScopes.includes("pmtiles")) checks.push(...pmtilesChecks(env, target));
  if (activeScopes.includes("ai")) checks.push(...aiChecks(env));
  if (activeScopes.includes("drone")) checks.push(...droneChecks(env, target));

  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    target,
    scopes: activeScopes,
    ok: failures === 0,
    failures,
    warnings,
    checks,
  };
}

export function formatEnvDoctorReport(report: EnvDoctorReport): string {
  const lines = [
    `OpenGeo env doctor target=${report.target} scopes=${report.scopes.join(",")}`,
    "",
    ...report.checks.map((check) => {
      const suffix = check.keys?.length ? ` [${check.keys.join(", ")}]` : "";
      return `${check.status.padEnd(4)} ${check.id}: ${check.message}${suffix}`;
    }),
    "",
    report.ok
      ? `OK: ${report.checks.length} checks, ${report.warnings} warnings.`
      : `FAIL: ${report.failures} failures, ${report.warnings} warnings.`,
  ];
  return lines.join("\n");
}

function coreChecks(env: EnvRecord, target: EnvDoctorTarget): EnvDoctorCheck[] {
  const checks: EnvDoctorCheck[] = [];
  checks.push(requireKeys("core.supabase", "core", env, [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]));
  checks.push(validUrl("core.supabase-url", "core", env, "NEXT_PUBLIC_SUPABASE_URL"));
  checks.push(validEnum("core.extractor-mode", "core", env, "OPENGEO_EXTRACTOR", [
    "mock",
    "http",
    "",
  ]));

  const missingFlags = FEATURE_FLAGS.filter((key) => !isSet(env[key]));
  checks.push(
    missingFlags.length === 0
      ? pass("core.feature-flags", "core", "Feature flags are explicit.")
      : target === "local"
        ? warn(
            "core.feature-flags",
            "core",
            "Feature flags are not all explicit; server defaults will apply.",
            missingFlags,
          )
        : fail(
            "core.feature-flags",
            "core",
            "Feature flags must be set explicitly for deployed environments.",
            missingFlags,
          ),
  );

  checks.push(
    isSet(env.SUPABASE_DB_URL)
      ? pass("core.remote-db", "core", "Remote migration URL is set.")
      : warn(
          "core.remote-db",
          "core",
          "SUPABASE_DB_URL is missing; remote migrations cannot run from this env.",
          ["SUPABASE_DB_URL"],
        ),
  );

  if (target === "local") {
    checks.push(
      isSet(env.LOCAL_DB_URL)
        ? pass("core.local-db", "core", "Local database URL is set.")
        : warn(
            "core.local-db",
            "core",
            "LOCAL_DB_URL is missing; local migrations and seed scripts cannot run.",
            ["LOCAL_DB_URL"],
          ),
    );
  }

  return checks;
}

function pmtilesChecks(env: EnvRecord, target: EnvDoctorTarget): EnvDoctorCheck[] {
  const checks: EnvDoctorCheck[] = [];
  checks.push(requireKeys("pmtiles.r2", "pmtiles", env, [...R2_KEYS]));
  checks.push(validUrl("pmtiles.public-base-url", "pmtiles", env, "R2_PUBLIC_BASE_URL"));

  const hasRemoteGenerator = isSet(env.PMTILES_GENERATOR_URL);
  const hasLocalTippecanoe = isSet(env.TIPPECANOE_BIN);
  if (target === "local") {
    checks.push(
      hasRemoteGenerator || hasLocalTippecanoe
        ? pass("pmtiles.generator", "pmtiles", "PMTiles generation path is configured.")
        : fail(
            "pmtiles.generator",
            "pmtiles",
            "Set PMTILES_GENERATOR_URL or TIPPECANOE_BIN.",
            ["PMTILES_GENERATOR_URL", "TIPPECANOE_BIN"],
          ),
    );
  } else {
    checks.push(
      hasRemoteGenerator
        ? pass("pmtiles.generator", "pmtiles", "Remote PMTiles generator URL is set.")
        : fail(
            "pmtiles.generator",
            "pmtiles",
            "Deployed environments must use PMTILES_GENERATOR_URL.",
            ["PMTILES_GENERATOR_URL"],
          ),
    );
  }

  checks.push(validUrl("pmtiles.generator-url", "pmtiles", env, "PMTILES_GENERATOR_URL"));
  checks.push(
    isSet(env.PMTILES_GENERATOR_TOKEN)
      ? pass("pmtiles.generator-token", "pmtiles", "Generator bearer token is set.")
      : target === "local"
        ? warn(
            "pmtiles.generator-token",
            "pmtiles",
            "Generator token is empty; local generator auth must also be disabled.",
            ["PMTILES_GENERATOR_TOKEN"],
          )
        : fail(
            "pmtiles.generator-token",
            "pmtiles",
            "Set PMTILES_GENERATOR_TOKEN for deployed generator access.",
            ["PMTILES_GENERATOR_TOKEN"],
          ),
  );

  return checks;
}

function aiChecks(env: EnvRecord): EnvDoctorCheck[] {
  const aiEnabled =
    env.FEATURE_AI_NL_SQL === "true" || env.FEATURE_AI_STYLE_GEN === "true";
  const extractionEnabled = env.FEATURE_AI_FEATURE_EXTRACTION === "true";
  const checks: EnvDoctorCheck[] = [];

  checks.push(
    aiEnabled
      ? requireKeys("ai.anthropic-key", "ai", env, ["ANTHROPIC_API_KEY"])
      : pass("ai.anthropic-key", "ai", "Anthropic key is optional while AI text features are disabled."),
  );
  checks.push(
    isSet(env.ANTHROPIC_MODEL)
      ? pass("ai.model", "ai", "Anthropic model is set.")
      : warn("ai.model", "ai", "ANTHROPIC_MODEL is missing; server default will apply.", [
          "ANTHROPIC_MODEL",
        ]),
  );

  const extractorMode = env.OPENGEO_EXTRACTOR || "mock";
  checks.push(
    extractionEnabled && extractorMode !== "http"
      ? fail(
          "ai.extractor-mode",
          "ai",
          "Feature extraction requires OPENGEO_EXTRACTOR=http.",
          ["OPENGEO_EXTRACTOR"],
        )
      : pass("ai.extractor-mode", "ai", "Extractor mode is compatible with feature flags."),
  );
  checks.push(
    extractorMode === "http"
      ? requireKeys("ai.extractor-url", "ai", env, ["OPENGEO_EXTRACTOR_URL"])
      : pass("ai.extractor-url", "ai", "Extractor URL is optional in mock mode."),
  );
  checks.push(validUrl("ai.extractor-url-format", "ai", env, "OPENGEO_EXTRACTOR_URL"));

  return checks;
}

function droneChecks(env: EnvRecord, target: EnvDoctorTarget): EnvDoctorCheck[] {
  const enabled = env.FEATURE_DRONE_PIPELINE === "true";
  if (!enabled) {
    return [
      pass("drone.feature-flag", "drone", "Drone pipeline is disabled; provider env is optional."),
    ];
  }

  const checks: EnvDoctorCheck[] = [
    pass("drone.feature-flag", "drone", "Drone pipeline is enabled."),
    requireKeys("drone.r2", "drone", env, [...R2_KEYS]),
    requireKeys("drone.odm", "drone", env, ["ODM_API_URL", "ODM_API_TOKEN"]),
    validUrl("drone.odm-url", "drone", env, "ODM_API_URL"),
  ];

  if (target !== "local") {
    checks.push(
      env.OPENGEO_EXTRACTOR === "http"
        ? pass("drone.extractor", "drone", "HTTP extractor is selected for deployed drone flow.")
        : warn(
            "drone.extractor",
            "drone",
            "Drone pipeline is enabled without OPENGEO_EXTRACTOR=http; extraction stays mocked.",
            ["OPENGEO_EXTRACTOR"],
          ),
    );
  }

  return checks;
}

function requireKeys(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  env: EnvRecord,
  keys: string[],
): EnvDoctorCheck {
  const missing = keys.filter((key) => !isSet(env[key]));
  return missing.length === 0
    ? pass(id, scope, "Required variables are set.")
    : fail(id, scope, "Missing required variables.", missing);
}

function validUrl(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  env: EnvRecord,
  key: string,
): EnvDoctorCheck {
  const value = env[key]?.trim();
  if (!value) return skip(id, scope, `${key} is empty; no URL format check needed.`);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail(id, scope, `${key} must use http or https.`, [key]);
    }
    return pass(id, scope, `${key} is a valid URL.`);
  } catch {
    return fail(id, scope, `${key} is not a valid URL.`, [key]);
  }
}

function validEnum(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  env: EnvRecord,
  key: string,
  allowed: string[],
): EnvDoctorCheck {
  const value = env[key] ?? "";
  return allowed.includes(value)
    ? pass(id, scope, `${key || id} is valid.`)
    : fail(id, scope, `${key} must be one of: ${allowed.filter(Boolean).join(", ")}.`, [
        key,
      ]);
}

function isSet(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function pass(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  message: string,
  keys?: string[],
): EnvDoctorCheck {
  return { id, scope, status: "pass", message, keys };
}

function warn(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  message: string,
  keys?: string[],
): EnvDoctorCheck {
  return { id, scope, status: "warn", message, keys };
}

function skip(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  message: string,
  keys?: string[],
): EnvDoctorCheck {
  return { id, scope, status: "skip", message, keys };
}

function fail(
  id: string,
  scope: Exclude<EnvDoctorScope, "all">,
  message: string,
  keys?: string[],
): EnvDoctorCheck {
  return { id, scope, status: "fail", message, keys };
}
