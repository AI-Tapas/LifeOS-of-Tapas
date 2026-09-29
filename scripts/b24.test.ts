// B24 offline proof: the scan failure alarm, the mail catch-up and the removal
// of the in-app chat. Run: npm run test:b24
//
// Synthetic data only: no real names, addresses or mail text. The scan itself
// runs for real; the model, the mailboxes, task writes and Supabase are the
// in-memory stand-ins in b24-stubs.ts, wired in by b24-loader.mjs.

import { register } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { composeBrief } from "../lib/brief/compose.ts";
import {
  SCAN_CUT_OFF,
  SCAN_DID_NOT_RUN,
  SCAN_FAILED_KEY,
  scanHealthWarning,
  type ScanHealthRow,
} from "../lib/brief/scan-health.ts";
import {
  DAILY_TASK_CAP,
  NIGHTLY_DAYS,
  PER_ACCOUNT_MESSAGES,
  ScanModelError,
  classifyModelError,
  parseScanArgs,
  scanLimits,
  windowAlreadyClosed,
} from "../lib/assistant/scan-args.ts";
import { scanRuns } from "../lib/assistant/scan-runs.ts";
import { alreadyRanToday } from "../lib/cron/guard.ts";
import { TOOLS } from "../lib/assistant/tools.ts";
import { fakeSupabase, resetState, state } from "./b24-stubs.ts";

register("./b24-loader.mjs", import.meta.url);
process.env.CRON_SECRET = "test-secret-test-secret-test-1234";

const src = (rel: string) => readFileSync(new URL("../" + rel, import.meta.url), "utf8");
const { runMailScan } = await import("../lib/assistant/scan.ts");
const { GET: scanCron } = await import("../app/api/cron/scan/route.ts");

const TODAY = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const NOW_MS = Date.parse("2026-09-30T02:00:00Z");
const IST_DATE = "2026-09-30";

// --- brief fixtures ----------------------------------------------------------
function brief(scanWarning?: string | null) {
  return composeBrief({
    nowMs: NOW_MS,
    tasks: [],
    events: [],
    pendingApprovalsCount: 0,
    accountsNeedingReconnect: [],
    appBaseUrl: "https://life.example.test",
    ...(scanWarning === undefined ? {} : { scanWarning }),
  });
}
const row = (action: string, ts: string, meta: Record<string, unknown> = { ist_date: IST_DATE }): ScanHealthRow => ({
  action,
  ts,
  meta,
});

test("brief says the scan did not run when no cron_scan row exists for today", () => {
  const warning = scanHealthWarning([row("cron_scan", "2026-09-29T21:31:00Z", { ist_date: "2026-09-29" })], IST_DATE);
  assert.equal(warning, `${SCAN_DID_NOT_RUN}.`);
  assert.equal(scanHealthWarning([], IST_DATE), `${SCAN_DID_NOT_RUN}.`);
  const b = brief(warning);
  assert.ok(b.text.startsWith(warning!), "the warning is the first line of the text brief");
  assert.ok(b.html.includes(SCAN_DID_NOT_RUN));
  // It sits above the greeting in the HTML too.
  assert.ok(b.html.indexOf(SCAN_DID_NOT_RUN) < b.html.indexOf("Good morning"));
});

test("brief says the AI key was refused when the failure row carries the auth reason", () => {
  const rows = [
    row("cron_scan_started", "2026-09-29T21:30:00Z"),
    row("cron_scan_failed", "2026-09-29T21:30:05Z", {
      ist_date: IST_DATE,
      message: "AI key refused (401)",
      reason_code: "auth",
    }),
  ];
  const warning = scanHealthWarning(rows, IST_DATE);
  assert.equal(warning, SCAN_FAILED_KEY);
  assert.ok(warning!.includes("Check the key in Vercel"));
  assert.ok(brief(warning).text.includes("the AI key was refused"));
  // A failure without a known reason still raises the alarm, in fewer words.
  const other = scanHealthWarning([row("cron_scan_failed", "2026-09-29T21:30:05Z")], IST_DATE);
  assert.match(other!, /^Mail scan failed last night\./);
});

test("brief prints nothing extra for a healthy scan", () => {
  const rows = [
    row("cron_scan_started", "2026-09-29T21:30:00Z"),
    row("cron_scan", "2026-09-29T21:31:10Z", { ist_date: IST_DATE, created: 2 }),
  ];
  assert.equal(scanHealthWarning(rows, IST_DATE), null);
  const healthy = brief(null);
  const plain = brief();
  assert.equal(healthy.text, plain.text);
  assert.equal(healthy.html, plain.html);
  assert.ok(!healthy.text.includes("Mail scan"));
});

test("brief says cut off when a start row has no finish row", () => {
  const warning = scanHealthWarning([row("cron_scan_started", "2026-09-29T21:30:00Z")], IST_DATE);
  assert.equal(warning, `${SCAN_CUT_OFF}.`);
  // A re-run that started after an earlier finish and never ended counts too.
  const rerun = scanHealthWarning(
    [row("cron_scan_failed", "2026-09-29T21:30:05Z"), row("cron_scan_started", "2026-09-30T04:00:00Z")],
    IST_DATE
  );
  assert.equal(rerun, `${SCAN_CUT_OFF}.`);
  // A failure followed by a good manual re-run the same day is healthy again.
  const fixed = scanHealthWarning(
    [
      row("cron_scan_failed", "2026-09-29T21:30:05Z", { ist_date: IST_DATE, reason_code: "auth" }),
      row("cron_scan_started", "2026-09-30T04:00:00Z"),
      row("cron_scan", "2026-09-30T04:01:00Z"),
    ],
    IST_DATE
  );
  assert.equal(fixed, null);
});

test("the brief cron reads the last 36 hours of the three scan rows", () => {
  const route = src("app/api/cron/brief/route.ts");
  assert.ok(route.includes("SCAN_HEALTH_ACTIONS"));
  assert.ok(route.includes("36 * 3600 * 1000"));
  assert.ok(route.includes("scanWarning,"));
  const health = src("lib/brief/scan-health.ts");
  for (const a of ["cron_scan_started", "cron_scan", "cron_scan_failed"]) assert.ok(health.includes(`"${a}"`));
});

test("list_scan_runs shows a started run that never finished", () => {
  const runs = scanRuns([
    { id: "a1", action: "cron_scan_started", ts: "2026-09-29T21:30:00Z", meta: { ist_date: "2026-09-30" } },
    { id: "a2", action: "cron_scan_started", ts: "2026-09-28T21:30:00Z", meta: { ist_date: "2026-09-29" } },
    { id: "a3", action: "cron_scan", ts: "2026-09-28T21:31:00Z", meta: { ist_date: "2026-09-29", created: 1 } },
  ]);
  const byDate = Object.fromEntries(runs.map((r) => [r.date, r]));
  assert.equal(byDate["2026-09-30"].started_never_finished, true);
  assert.equal(byDate["2026-09-30"].ran, false);
  assert.equal(byDate["2026-09-29"].started_never_finished, false);
  assert.equal(byDate["2026-09-29"].ran, true);
});

// --- scan fixtures -----------------------------------------------------------
const TITLES = [
  "Reconcile the Kestrel ledger",
  "Draft notice reply for Lumina",
  "Book venue for Orchid workshop",
  "Collect signed minutes from Vega",
  "Verify depreciation schedule of Zephyr",
  "Renew licence with Quartz",
  "Call auditor about Nimbus",
  "Prepare invoice annexure for Falcon",
  "Review lease deed of Harbor",
  "File appeal for Meridian",
  "Confirm payroll inputs of Sable",
  "Update fixed asset register for Tundra",
];

function seedMails(n: number): void {
  state.mails = Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(2, "0");
    return {
      id: `m${k}`,
      from: `Person ${k} <person${k}@example.test>`,
      subject: `Question ${k} about ${TITLES[i].split(" ").pop()}`,
      date: "Tue, 29 Sep 2026 10:00:00 +0530",
      snippet: `Synthetic note ${k}.`,
      threadId: `thread-${k}`,
    };
  });
}

// The stub model proposes one task per message it was shown.
function proposeAll(extra: (n: number) => Record<string, unknown> = () => ({})) {
  state.llm = (refs) => ({
    text: "",
    stop: "tool_use",
    calls: refs.map((ref) => {
      const n = Number(ref.slice(ref.lastIndexOf("m") + 1));
      return { id: `c${n}`, name: "propose_task", input: { title: TITLES[n - 1], external_ref: ref, ...extra(n) } };
    }),
  });
}

const OWNER = { supabase: fakeSupabase, userId: "user-1", origin: "owner_session", job: null } as never;
const cronRequest = () =>
  new Request("https://x.test/api/cron/scan", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

test("a 401 from the model stops after one call, creates nothing, and ends as cron_scan_failed", async () => {
  resetState();
  seedMails(4);
  state.llm = () => {
    throw Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
  };
  const res = await scanCron(cronRequest());
  assert.equal(res.status, 500);
  assert.equal(state.llmCalls, 1, "the dead key is tried once, not once per pass or account");
  assert.equal(state.tasks.length, 0);
  const actions = state.audit.map((a) => a.action).filter((a) => a.startsWith("cron_scan"));
  assert.deepEqual(actions, ["cron_scan_started", "cron_scan_failed"]);
  const failed = state.audit.find((a) => a.action === "cron_scan_failed")!.meta as Record<string, unknown>;
  assert.equal(failed.reason_code, "auth");
  assert.equal(failed.message, "AI key refused (401)");

  // A same-day manual re-run is not blocked by the failed run, and works once the key is fixed.
  const guardRows = state.audit.filter((a) => a.action === "cron_scan");
  assert.equal(alreadyRanToday(guardRows as { meta: unknown }[], failed.ist_date as string), false);
  proposeAll();
  const again = await scanCron(cronRequest());
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { ok?: boolean }).ok, true);
  assert.ok(state.audit.some((a) => a.action === "cron_scan"));
  assert.ok(state.tasks.length > 0);

  // And now the day is done: a third call is skipped.
  const third = await scanCron(cronRequest());
  assert.equal(((await third.json()) as { skipped?: boolean }).skipped, true);
});

test("the model error classifier gives short fixed reasons and never the provider's text", () => {
  const auth = classifyModelError(Object.assign(new Error("secret detail"), { status: 401 }));
  assert.ok(auth instanceof ScanModelError);
  assert.equal(auth.code, "auth");
  assert.ok(!auth.message.includes("secret"));
  assert.equal(classifyModelError(new Error("LLM request failed (403) calling https://x")).code, "auth");
  assert.equal(classifyModelError(new Error("LLM request failed (529) calling https://x")).code, "provider");
  assert.equal(classifyModelError(new Error("Could not reach https://x")).code, "provider");
});

test("the scan route stamps a start row, allows a long run, and keeps failed runs out of the guard", () => {
  const route = src("app/api/cron/scan/route.ts");
  assert.match(route, /export const maxDuration = 300;/);
  assert.ok(route.indexOf('"cron_scan_started"') < route.indexOf("await runMailScan"));
  assert.ok(route.includes('.eq("action", "cron_scan")'), "the already-ran check reads finished runs only");
});

test("scan_mail refuses days of 0 and 15 and an unknown account, and takes 1 to 14", () => {
  for (const bad of [0, 15, -1, 2.5, "10", Number.NaN]) {
    assert.equal(parseScanArgs({ days: bad }).ok, false, `days ${String(bad)} must be refused`);
  }
  assert.equal(parseScanArgs({ account: "nobody" }).ok, false);
  assert.equal(parseScanArgs({ account: 7 }).ok, false);
  for (const good of [1, 3, 10, 14]) assert.equal(parseScanArgs({ days: good }).ok, true);
  const both = parseScanArgs({ days: 10, account: "icai" });
  assert.deepEqual(both.ok && both.options, { days: 10, account: "icai" });
  const none = parseScanArgs({});
  assert.deepEqual(none.ok && none.options, {});
  // The tool takes both as optional single-typed parameters.
  const tool = TOOLS.find((t) => t.name === "scan_mail")!;
  const schema = tool.input_schema as unknown as { properties: Record<string, { type: unknown }>; required: string[] };
  assert.equal(schema.properties.days.type, "number");
  assert.equal(schema.properties.account.type, "string");
  assert.deepEqual(schema.required, []);
  // The performer checks before it scans.
  const exec = src("lib/assistant/execute.ts");
  const body = exec.slice(exec.indexOf("async scan_mail("), exec.indexOf("async undo_action("));
  assert.ok(body.indexOf("parseScanArgs") < body.indexOf("runMailScan"));
});

test("limits: days 10 means 10 days, a 150 message cap and a lifted task cap; nightly stays 3, 15, 5", () => {
  assert.deepEqual(scanLimits(), { days: 3, messages: 15, task_cap: 5 });
  assert.deepEqual(scanLimits(1), { days: 1, messages: 15, task_cap: 5 });
  assert.deepEqual(scanLimits(10), { days: 10, messages: 150, task_cap: 50 });
  assert.deepEqual(scanLimits(4), { days: 4, messages: 60, task_cap: 20 });
  assert.equal(scanLimits(14).messages, 150);
  assert.equal(NIGHTLY_DAYS, 3);
  assert.equal(PER_ACCOUNT_MESSAGES, 15);
  assert.equal(DAILY_TASK_CAP, 5);
});

test("the cron path uses 3 days, 15 messages and 5 tasks; a 10 day run uses 10, 150 and no 5 cap", async () => {
  resetState();
  seedMails(12);
  proposeAll();
  await runMailScan(OWNER);
  assert.deepEqual(state.listerCalls, [
    { days: 3, messages: 15 },
    { days: 3, messages: 15 },
  ]);
  assert.equal(state.tasks.filter((t) => String(t.external_ref).includes(":ca_tapasnr:")).length, 5);

  resetState();
  seedMails(12);
  proposeAll();
  const summary = await runMailScan(OWNER, { days: 10, account: "ca_tapasnr" });
  assert.deepEqual(state.listerCalls, [{ days: 10, messages: 150 }], "one account, the widened window");
  assert.equal(summary.created, 12, "all twelve land, past the nightly cap of five");
});

test("a mail whose lapses_on has already passed creates no task", async () => {
  resetState();
  seedMails(4);
  proposeAll((n) => (n === 1 ? { lapses_on: "2020-01-01" } : n === 2 ? { lapses_on: "2999-01-01" } : {}));
  const summary = await runMailScan(OWNER, { account: "ca_tapasnr" });
  const titles = state.tasks.map((t) => t.title);
  assert.ok(!titles.includes(TITLES[0]), "the closed window makes no task");
  assert.ok(titles.includes(TITLES[1]), "a window still open does");
  assert.equal(summary.created, 3);
  assert.equal(windowAlreadyClosed("2020-01-01", TODAY), true);
  assert.equal(windowAlreadyClosed(TODAY, TODAY), false);
  assert.equal(windowAlreadyClosed(null, TODAY), false);
});

test("running the same 10 day mail set twice creates its tasks once only", async () => {
  resetState();
  seedMails(12);
  proposeAll();
  const first = await runMailScan(OWNER, { days: 10, account: "ca_tapasnr" });
  assert.equal(first.created, 12);
  const calls = state.llmCalls;
  const second = await runMailScan(OWNER, { days: 10, account: "ca_tapasnr" });
  assert.equal(second.created, 0);
  assert.equal(state.tasks.length, 12);
  assert.equal(state.llmCalls, calls, "nothing new to read, so the model is not asked again");
});

test("the real listers take the window from the caller", () => {
  const mail = src("lib/assistant/mail.ts");
  assert.ok(mail.includes("newer_than:${window.days}d in:inbox"));
  assert.ok(mail.includes("maxResults: String(window.messages)"));
  assert.ok(mail.includes("$top: String(window.messages)"));
  assert.ok(mail.includes("Date.now() - window.days * 86400000"));
  assert.ok(!/LOOKBACK_DAYS|PER_ACCOUNT\b/.test(mail));
});

// --- chat removal ------------------------------------------------------------
test("the chat route and its UI no longer exist, and /assistant opens on the queue", () => {
  for (const gone of [
    "app/api/assistant/chat/route.ts",
    "components/assistant/chat.tsx",
    "lib/assistant/chat-store.ts",
    "lib/assistant/chat-history.ts",
  ]) {
    assert.ok(!existsSync(new URL("../" + gone, import.meta.url)), `${gone} must stay deleted`);
  }
  const page = src("app/(app)/assistant/page.tsx");
  assert.ok(!/key: "chat"/.test(page));
  assert.ok(!page.includes("AssistantChat"));
  assert.ok(page.includes(': "queue";'), "the default tab is the queue");
  for (const tab of ['"queue"', '"history"', '"audit"']) assert.ok(page.includes(`key: ${tab}`), `${tab} tab kept`);
  // scanMailAction stays; the chat actions go.
  const actions = src("app/(app)/assistant/actions.ts");
  assert.ok(actions.includes("export async function scanMailAction"));
  assert.ok(!/saveChatTurnsAction|clearChatAction|importChatFromDeviceAction/.test(actions));
  // Nothing links to the old chat opener.
  assert.ok(!src("components/tasks/tasks-view.tsx").includes("ask=priorities"));
});

test("only the mail scan model is chosen in Settings, and chat columns are not read or written", () => {
  const settings = src("lib/assistant/settings.ts");
  assert.ok(!/select\([^)]*chat_/.test(settings), "the saved chat choice is never read");
  const actions = src("app/(app)/settings/actions.ts");
  const save = actions.slice(
    actions.indexOf("export async function saveAssistantModelsAction"),
    actions.indexOf("M7a one-off maintenance")
  );
  assert.ok(!save.includes("chat_provider") && !save.includes("chat_model"));
  assert.ok(!src("components/settings/models-panel.tsx").includes("chat_"));
  assert.ok(!src("app/api/assistant/health/route.ts").includes('"chat"'));
});

test("no emojis or em dashes in what B24 wrote", () => {
  for (const file of [
    "lib/assistant/scan-args.ts",
    "lib/brief/scan-health.ts",
    "scripts/b24.test.ts",
    "scripts/b24-stubs.ts",
    "scripts/b24-loader.mjs",
  ]) {
    const text = src(file);
    assert.ok(!new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)).test(text), `${file} has a dash`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text), `${file} has an emoji`);
  }
});
