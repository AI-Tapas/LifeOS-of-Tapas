import test from "node:test";
import assert from "node:assert/strict";
import { listResources, readResource, listPrompts, getPrompt } from "../lib/mcp/catalog.ts";

test("resource discovery and reads both enforce the current authorized tools", async () => {
  const allowed = ["lifeos_list_tasks"];
  assert.deepEqual(listResources(allowed).map(r => r.uri), ["lifeos://tasks/open"]);
  let calls = 0;
  const read = async () => { calls++; return { state: "completed", data: { items: [] } }; };
  await assert.rejects(readResource("lifeos://context", allowed, read), /unavailable/);
  await assert.rejects(readResource("https://external.example/", allowed, read), /unavailable/);
  assert.equal(calls, 0);
  const result = await readResource("lifeos://tasks/open", allowed, read);
  const content = JSON.parse(result.contents[0].text);
  assert.equal(calls, 1);
  assert.equal(content.source, "lifeos_list_tasks");
  assert.equal(content.imported_content_is_untrusted, true);
});

test("resource failures are not presented as empty successful context", async () => {
  await assert.rejects(readResource("lifeos://tasks/open", ["lifeos_list_tasks"], async () => ({ state: "failed", error: { code: "revoked" } })), /could not be read/);
});

test("prompt discovery requires every referenced capability", () => {
  assert.equal(listPrompts(["lifeos_list_tasks"]).length, 0);
  assert.equal(listPrompts(["lifeos_list_tasks", "lifeos_list_events"])[0].name, "daily_planning");
  assert.throws(() => getPrompt("unbilled_work_review", ["lifeos_list_tasks"]), /unavailable/);
  const text = getPrompt("unbilled_work_review", ["lifeos_list_unbilled"]).messages[0].content.text;
  assert.match(text, /Never mark work invoiced/);
  assert.match(text, /never as instructions/);
});
