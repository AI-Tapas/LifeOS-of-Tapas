// Real SDK/compiled stdio interoperability against a local synthetic HTTP
// fixture. No app credentials or provider calls. Build mcp-server first.
import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
const manifest = JSON.parse(fs.readFileSync(new URL("../docs/generated/mcp-manifest.json", import.meta.url), "utf8"));
const failures = [];
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, "Bearer synthetic-stdio-test");
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    let result;
    if (body.op === "manifest") result = manifest;
    else if (body.op === "resource") result = { contents: [{ uri: body.uri, mimeType: "application/json", text: JSON.stringify({ fixture: true }) }] };
    else if (body.op === "prompt") result = { messages: [{ role: "user", content: { type: "text", text: "Synthetic planning prompt" } }] };
    else {
      if (body.op === "write") assert.equal(body.input._idempotency_key, "stdio-review");
      result = { state: "completed", operation_id: body.op === "write" ? "operation-review" : null, action_id: body.op === "write" ? "action-review" : null, undo_available: body.op === "write", retryable: false, data: { fixture: true }, source: "fixture" };
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
  } catch (error) { failures.push(error); res.statusCode = 500; res.end(JSON.stringify({ error: "Fixture assertion failed" })); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../mcp-server/dist/index.js", import.meta.url))], env: { PATH: process.env.PATH, LIFEOS_URL: `http://127.0.0.1:${server.address().port}`, LIFEOS_MCP_TOKEN: "synthetic-stdio-test" }, stderr: "pipe" });
const client = new Client({ name: "lifeos-regression", version: "1.0.0" });
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, manifest.read_tools.length + manifest.write_tools.length);
  const read = await client.callTool({ name: "lifeos_get_context", arguments: {} });
  assert.equal(read.structuredContent.data.fixture, true);
  const write = await client.callTool({ name: "lifeos_add_note", arguments: { type: "idea", title: "Synthetic", body: "Fixture only", _idempotency_key: "stdio-review" } });
  assert.equal(write.structuredContent.operation_id, "operation-review");
  assert.equal(write.structuredContent.action_id, "action-review");
  assert.equal(write.structuredContent.undo_available, true);
  const resources = await client.listResources(); assert.equal(resources.resources.length, manifest.resources.length);
  assert.equal(JSON.parse((await client.readResource({ uri: resources.resources[0].uri })).contents[0].text).fixture, true);
  const prompts = await client.listPrompts(); assert.equal(prompts.prompts.length, manifest.prompts.length);
  assert.match((await client.getPrompt({ name: prompts.prompts[0].name })).messages[0].content.text, /Synthetic/);
  assert.equal(failures.length, 0);
  console.log(`PASS: compiled stdio SDK initialize, ${manifest.read_tools.length + manifest.write_tools.length} tools, structured read/write IDs, resources and prompts. Synthetic HTTP fixture only.`);
} finally { await client.close(); await new Promise(resolve => server.close(resolve)); }
