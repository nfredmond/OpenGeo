import "server-only";
import { createHash, createHmac } from "node:crypto";
import { env } from "@/lib/env";

export class R2ConfigError extends Error {
  constructor(missing: string[]) {
    super(`Missing R2 configuration: ${missing.join(", ")}`);
    this.name = "R2ConfigError";
  }
}

export class R2UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2UploadError";
  }
}

export function missingR2Config(): string[] {
  const cfg = env();
  const missing: string[] = [];
  if (!cfg.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
  if (!cfg.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!cfg.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!cfg.R2_BUCKET) missing.push("R2_BUCKET");
  if (!cfg.R2_PUBLIC_BASE_URL) missing.push("R2_PUBLIC_BASE_URL");
  return missing;
}

export async function putR2Object({
  key,
  body,
  contentType,
}: {
  key: string;
  body: Uint8Array;
  contentType: string;
}): Promise<{ url: string; key: string }> {
  const missing = missingR2Config();
  if (missing.length > 0) throw new R2ConfigError(missing);

  const cfg = env();
  const host = `${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePathPart(cfg.R2_BUCKET)}/${encodeKey(key)}`;
  const endpoint = `https://${host}${canonicalUri}`;
  const payloadHash = sha256Hex(body);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(cfg.R2_SECRET_ACCESS_KEY, dateStamp), stringToSign);
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${cfg.R2_ACCESS_KEY_ID}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  const uploadBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(uploadBody).set(body);

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
    },
    body: uploadBody,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new R2UploadError(`R2 upload failed: ${res.status} ${detail}`.trim());
  }

  return {
    key,
    url: `${cfg.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${encodeKey(key)}`,
  };
}

function signingKey(secret: string, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodePathPart).join("/");
}

function encodePathPart(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
