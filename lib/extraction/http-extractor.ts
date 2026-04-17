import type { Extractor, ExtractionInput, ExtractionResult } from "./types";

// HTTP-backed extractor. POSTs to the Python extractor service (either
// local docker-compose CPU or Modal GPU — same contract). The URL and
// bearer token come from env; callers get them through getExtractor().
export class HttpExtractor implements Extractor {
  readonly name = "http";
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    modelLabel = "samgeo-langsam-v1",
  ) {
    this.model = modelLabel;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const url = new URL("/extract", this.baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    // 10-minute ceiling. CPU dev runs can legitimately take 3–10 minutes;
    // Modal GPU runs are ~5–30 seconds. AbortController lets us surface a
    // clean error in either case rather than hanging forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Extractor ${res.status}: ${detail.slice(0, 400) || res.statusText}`,
        );
      }
      return (await res.json()) as ExtractionResult;
    } finally {
      clearTimeout(timeout);
    }
  }
}
