import { McpError } from "./operations";
export async function readJson(req: Request, maxBytes = 65536): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new McpError("invalid_content_type", "Content-Type must be application/json.");
  const reader = req.body?.getReader();
  if (!reader) throw new McpError("invalid_json", "A JSON body is required.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new McpError("input_too_large", "Request exceeds 64 KB."); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new McpError("invalid_json", "Body must be valid JSON."); }
}
export function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
