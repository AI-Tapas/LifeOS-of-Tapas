// Thin client for the Life OS HTTP surface at /api/mcp. Carries the shared
// token, times out rather than hanging a chat, and turns an error body into a
// readable message. It holds no other credentials: OAuth tokens for Gmail and
// the calendar never leave the app.

export interface ToolManifestEntry {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
  queues_for_approval?: boolean;
}

export interface Manifest {
  read_tools: ToolManifestEntry[];
  write_tools: ToolManifestEntry[];
}

const TIMEOUT_MS = 60_000;

export class LifeOsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      throw new Error(
        name === "TimeoutError" || name === "AbortError"
          ? `Life OS did not respond within ${TIMEOUT_MS / 1000} seconds.`
          : `Could not reach Life OS at ${this.baseUrl}. Check LIFEOS_URL and that the app is deployed.`
      );
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Life OS returned a non-JSON reply (${res.status}).`);
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: string }).error ?? `Life OS returned ${res.status}.`;
      throw new Error(
        res.status === 401
          ? `${message} The LIFEOS_MCP_TOKEN here must match the one set in the app's environment.`
          : message
      );
    }
    return parsed as T;
  }

  manifest(): Promise<Manifest> {
    return this.post<Manifest>({ op: "manifest" });
  }

  read(tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post({ op: "read", tool, input });
  }

  write(
    tool: string,
    input: Record<string, unknown>
  ): Promise<{ reply: string; queued: boolean; action_id?: string }> {
    return this.post({ op: "write", tool, input });
  }
}
