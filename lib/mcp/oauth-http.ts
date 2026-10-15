// Bound unauthenticated OAuth input before parsing or opening a database client.
export const OAUTH_BODY_LIMIT = 16_384;

export async function readBoundedText(req: Request, limit = OAUTH_BODY_LIMIT): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error("Body is too large.");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readOAuthParams(req: Request): Promise<URLSearchParams> {
  const text = await readBoundedText(req);
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return new URLSearchParams(text);
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object.");
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== "string") throw new Error("OAuth parameters must be strings.");
    params.append(key, value);
  }
  return params;
}

export function rpcSucceeded(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { ok?: unknown }).ok === true;
}
export function rpcErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}
