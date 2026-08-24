#!/usr/bin/env node
// life-os-mcp-server: exposes the Life OS assistant to any MCP client, so the
// assistant can be driven from Claude or ChatGPT on an existing subscription
// instead of paying per API call.
//
// The tool list is fetched from the app at startup rather than duplicated
// here, so this server can never drift from the registry that the app's own
// gates are built around. What that means in practice:
//
//   read tools    never change anything
//   autonomous    run immediately in the app, recorded and undoable there
//   confirm       queue a proposal; NOTHING reaches another person until
//                 Tapas approves it inside the Life OS app
//
// There is deliberately no approve tool. An outside model can compose an
// email and queue it; only the owner, in the app, can send it.
//
// stdio transport, so logging goes to stderr: stdout carries the protocol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LifeOsClient, type ToolManifestEntry } from "./client.js";
import { jsonSchemaToZodShape } from "./schema.js";

const VERSION = "1.0.0";

function requireEnv(name: string, hint: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`life-os-mcp-server: ${name} is not set. ${hint}`);
    process.exit(1);
  }
  return v.trim();
}

function toolConfig(entry: ToolManifestEntry) {
  const destructive = !entry.read_only && !entry.queues_for_approval;
  return {
    title: entry.name,
    description: entry.queues_for_approval
      ? `${entry.description} This only queues the request: it reaches nobody until Tapas approves it inside the Life OS app.`
      : entry.description,
    inputSchema: jsonSchemaToZodShape(entry.input_schema),
    annotations: {
      readOnlyHint: entry.read_only,
      // Writes are recorded and undoable in the app; queued proposals do
      // nothing at all until approved.
      destructiveHint: destructive,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function textResult(payload: unknown, isError = false) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) };
}

async function main(): Promise<void> {
  const baseUrl = requireEnv(
    "LIFEOS_URL",
    "Set it to your Life OS URL, e.g. https://life-os-of-tapas.vercel.app"
  );
  const token = requireEnv(
    "LIFEOS_MCP_TOKEN",
    "It must match the LIFEOS_MCP_TOKEN set in the Life OS environment."
  );
  const client = new LifeOsClient(baseUrl, token);

  let manifest;
  try {
    manifest = await client.manifest();
  } catch (e) {
    console.error(
      `life-os-mcp-server: could not load the tool list. ${
        e instanceof Error ? e.message : e
      }`
    );
    process.exit(1);
  }

  const server = new McpServer({ name: "life-os-mcp-server", version: VERSION });

  for (const entry of manifest.read_tools) {
    server.registerTool(entry.name, toolConfig(entry), async (input: Record<string, unknown>) => {
      try {
        return textResult(await client.read(entry.name, input ?? {}));
      } catch (e) {
        return textResult(e instanceof Error ? e.message : "The read failed.", true);
      }
    });
  }

  for (const entry of manifest.write_tools) {
    server.registerTool(entry.name, toolConfig(entry), async (input: Record<string, unknown>) => {
      try {
        const r = await client.write(entry.name, input ?? {});
        return textResult(
          r.queued
            ? `${r.reply}\n\nNothing has been sent. Open the Life OS app, Assistant tab, Queue, to approve it.`
            : r.reply
        );
      } catch (e) {
        return textResult(e instanceof Error ? e.message : "The action failed.", true);
      }
    });
  }

  console.error(
    `life-os-mcp-server ${VERSION} ready: ${manifest.read_tools.length} read tools, ` +
      `${manifest.write_tools.length} write tools, against ${baseUrl}`
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(`life-os-mcp-server: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
