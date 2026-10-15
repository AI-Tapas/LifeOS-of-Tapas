import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { safeRedirectPath } from "../lib/auth/safe-redirect.ts";

test("login destinations stay in the app under URL normalisation", () => {
  for (const destination of [null, undefined, "", "https://evil.test", "//evil.test", "/\\evil.test", "/\nevil.test", "/\tevil.test", "javascript:alert(1)", " /tasks", "/\u0000tasks"]) {
    assert.equal(safeRedirectPath(destination), "/", String(destination));
  }
  assert.equal(safeRedirectPath("/tasks?task=123#details"), "/tasks?task=123#details");
  assert.equal(safeRedirectPath("/connect?redirect_uri=https%3A%2F%2Fclient.test"), "/connect?redirect_uri=https%3A%2F%2Fclient.test");
});

test("actual worker never stores or replays private navigation and RSC responses", async () => {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const entries = new Map<string, Map<string, Response>>([
    ["life-os-v4", new Map([["https://lifeos.test/tasks", new Response("private legacy page")]])],
    ["unrelated-cache", new Map()],
  ]);
  let online = true;
  let finishFetch: (() => void) | null = null;
  let delay = false;
  const cacheApi = {
    keys: async () => [...entries.keys()],
    delete: async (key: string) => entries.delete(key),
    open: async (key: string) => {
      if (!entries.has(key)) entries.set(key, new Map());
      const cache = entries.get(key)!;
      return {
        addAll: async (paths: string[]) => paths.forEach((path) => cache.set(path, new Response(path === "/offline" ? "public offline shell" : "public asset"))),
        match: async (request: Request | string) => cache.get(typeof request === "string" ? request : request.url)?.clone(),
        put: async (request: Request | string, response: Response) => { cache.set(typeof request === "string" ? request : request.url, response); },
      };
    },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    URL, Response,
    caches: cacheApi,
    fetch: async () => {
      if (!online) throw new Error("Offline");
      if (delay) await new Promise<void>((resolve) => { finishFetch = resolve; });
      return new Response("private fresh page");
    },
    self: { location: { origin: "https://lifeos.test" }, addEventListener: (event: string, fn: (event: Record<string, unknown>) => void) => handlers.set(event, fn), skipWaiting: async () => {}, clients: { claim: async () => {} } },
  });
  async function lifecycle(name: string) {
    const work: Promise<unknown>[] = [];
    handlers.get(name)!({ waitUntil: (promise: Promise<unknown>) => work.push(promise) });
    await Promise.all(work);
  }
  async function navigate(path: string) {
    let result: Promise<Response> | undefined;
    const work: Promise<unknown>[] = [];
    handlers.get("fetch")!({
      request: { method: "GET", url: "https://lifeos.test" + path, mode: "navigate", headers: new Headers() },
      respondWith: (response: Promise<Response>) => { result = response; },
      waitUntil: (promise: Promise<unknown>) => work.push(promise),
    });
    await Promise.all(work);
    return result!;
  }
  await lifecycle("install");
  await lifecycle("activate");
  assert.equal(entries.has("life-os-v4"), false);
  assert.equal(entries.has("unrelated-cache"), true);
  assert.equal(await (await navigate("/tasks")).text(), "private fresh page");
  assert.equal(entries.get("life-os-public-v5")!.has("https://lifeos.test/tasks"), false);
  // A private request already in flight at sign-out must never write a cache.
  delay = true;
  const pending = navigate("/notes");
  while (!finishFetch) await Promise.resolve();
  const purge: Promise<unknown>[] = [];
  handlers.get("message")!({ data: { type: "PURGE_PRIVATE_DATA" }, ports: [], waitUntil: (p: Promise<unknown>) => purge.push(p) });
  await Promise.all(purge);
  (finishFetch as () => void)();
  await pending;
  delay = false;
  online = false;
  assert.equal(await (await navigate("/tasks")).text(), "public offline shell");
  assert.equal(entries.get("life-os-public-v5")!.has("https://lifeos.test/notes"), false);
  let intercepted = false;
  handlers.get("fetch")!({ request: { method: "GET", mode: "cors", url: "https://lifeos.test/tasks?_rsc=x", headers: new Headers({ RSC: "1" }) }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false, "RSC uses browser network, never private offline data");
});
