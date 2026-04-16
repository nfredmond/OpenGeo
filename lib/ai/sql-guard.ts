// Security-critical: statement-level validator that gates every LLM-generated
// SQL before it touches the read-only pool. This is one of two defenses —
// the other is the `opengeo_ai_reader` role's SELECT-only grants. This gate
// exists to fail closed even if a future change loosens the role grants.
//
// Kept in its own module (no AI SDK / server-only imports) so unit tests can
// exercise it without spinning up the model stack.

const FORBIDDEN: RegExp[] = [
  /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|vacuum|call|do|analyze)\b/i,
  /;\s*\S/, // no stacked statements
  /--/, // no inline comments that could hide intent
  /\/\*/, // no block comments either
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

export function validateSql(sql: string): GuardResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^\s*(with\b|select\b)/i.test(trimmed)) {
    return { ok: false, reason: "Only SELECT (optionally with CTE) is permitted." };
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `Rejected pattern: ${pattern}` };
    }
  }
  if (!/\bgeom\b/i.test(trimmed)) {
    return { ok: false, reason: "Query must return a 'geom' column." };
  }
  return { ok: true };
}
