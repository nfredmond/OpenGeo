import "server-only";

// Structured console logger. Every line is single-object JSON so that any
// log aggregator (Vercel, Datadog, Loki) can index fields without an
// external client library. Keep this module dependency-free — it runs on
// every route and should never block a request.

type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields: Fields = {}): void {
  const payload = {
    level,
    msg: message,
    t: new Date().toISOString(),
    ...fields,
  };
  const line = safeStringify(payload);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ level: "error", msg: "log serialization failed" });
  }
}

export const log = {
  debug: (msg: string, f?: Fields) => emit("debug", msg, f),
  info: (msg: string, f?: Fields) => emit("info", msg, f),
  warn: (msg: string, f?: Fields) => emit("warn", msg, f),
  error: (msg: string, f?: Fields) => emit("error", msg, f),
};
