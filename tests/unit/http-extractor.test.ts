import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { HttpExtractor } from "@/lib/extraction/http-extractor";
import type { ExtractionInput, ExtractionResult } from "@/lib/extraction/types";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

function startServer(handler: Handler): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const validInput: ExtractionInput = {
  orthomosaicId: "o-test",
  cogUrl: "https://example.com/o.tif",
  prompt: "buildings",
  bbox: null,
};

const validResult: ExtractionResult = {
  featureCollection: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
        properties: { label: "buildings", confidence: 0.82 },
      },
    ],
  },
  metrics: {
    model: "samgeo-langsam-v1",
    latencyMs: 4213,
    featureCount: 1,
    extras: { estimatedCostCents: 0.1287 },
  },
};

describe("HttpExtractor", () => {
  let active: Server | null = null;

  afterEach(async () => {
    if (active) await stopServer(active);
    active = null;
  });

  it("POSTs /extract with the serialized input and returns the typed result", async () => {
    let seenMethod: string | undefined;
    let seenPath: string | undefined;
    let seenBody: unknown;
    const { server, url } = await startServer((req, res, body) => {
      seenMethod = req.method;
      seenPath = req.url;
      seenBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validResult));
    });
    active = server;

    const extractor = new HttpExtractor(url, "");
    const result = await extractor.extract(validInput);

    expect(seenMethod).toBe("POST");
    expect(seenPath).toBe("/extract");
    expect(seenBody).toEqual(validInput);
    expect(result).toEqual(validResult);
    expect(extractor.name).toBe("http");
    expect(extractor.model).toBe("samgeo-langsam-v1");
  });

  it("sends Bearer token when one is configured", async () => {
    let seenAuth: string | undefined;
    const { server, url } = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validResult));
    });
    active = server;

    await new HttpExtractor(url, "sk-test-token").extract(validInput);
    expect(seenAuth).toBe("Bearer sk-test-token");
  });

  it("omits Authorization header when token is empty", async () => {
    let seenAuth: string | undefined;
    const { server, url } = await startServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validResult));
    });
    active = server;

    await new HttpExtractor(url, "").extract(validInput);
    expect(seenAuth).toBeUndefined();
  });

  it("surfaces non-2xx responses with status and a body snippet", async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "prompt.kind=point is unsupported" }));
    });
    active = server;

    await expect(new HttpExtractor(url, "").extract(validInput)).rejects.toThrow(
      /Extractor 422.*prompt\.kind=point is unsupported/,
    );
  });

  it("honors a custom model label", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validResult));
    });
    active = server;

    const extractor = new HttpExtractor(url, "", "custom-model-v2");
    expect(extractor.model).toBe("custom-model-v2");
    await extractor.extract(validInput);
  });
});
