"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnGhost, btnPrimary, inputCls } from "@/components/ui";
import {
  clearChatAction,
  importChatFromDeviceAction,
  saveChatTurnsAction,
  scanMailAction,
} from "@/app/(app)/assistant/actions";
import type { ChatTurn } from "@/lib/assistant/chat-history";

type Turn = ChatTurn;

// B6: the thread lives in assistant_chat_turns now, so the same conversation
// is on the phone and the laptop. The server hands the newest turns in as a
// prop; nothing here reads or writes localStorage except the one-time move
// below, which runs while a device still holds an M4 thread and then deletes
// its own copy so it never runs again.
const LEGACY_KEY = "life_os_assistant_chat_v1";

export default function AssistantChat({
  prefill,
  initialTurns = [],
}: {
  prefill?: string;
  initialTurns?: Turn[];
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);
  // Typed in for him, never sent for him: the point of this pass is that he
  // can argue with every proposal, which starts with him hitting send.
  const [input, setInput] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // The move off the device, once. It only ever fills an empty thread server
  // side; either way the local copy goes, so this is a no-op from the second
  // load onward.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(LEGACY_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      window.localStorage.removeItem(LEGACY_KEY);
      return;
    }
    importChatFromDeviceAction(parsed).then((r) => {
      if (!r.ok) return;
      try {
        window.localStorage.removeItem(LEGACY_KEY);
      } catch {
        // nothing to do; the import refuses a second time anyway
      }
      if (r.imported > 0) router.refresh();
    });
  }, [router]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setNotice(null);
    const userTurn: Turn = { role: "user", content: text };
    const history = [...turns, userTurn];
    // The reply is built here rather than only inside setTurns, so the exact
    // pair that ended up on screen is the pair that gets stored.
    const reply: Turn = { role: "assistant", content: "", tools: [] };
    const paint = () =>
      setTurns([...history, { ...reply, tools: [...(reply.tools ?? [])] }]);
    paint();
    setBusy(true);
    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(
          res.status === 401 ? "Please sign in again." : `Assistant error (${res.status}).`
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawQueue = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: { t: string; d?: string; name?: string; summary?: string; error?: boolean; queued?: boolean };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "text") reply.content += ev.d ?? "";
          if (ev.t === "tool") {
            reply.tools = [
              ...(reply.tools ?? []),
              { name: ev.name ?? "tool", summary: ev.summary ?? "", error: ev.error },
            ];
            if (ev.queued) sawQueue = true;
          }
          if (ev.t === "notice" || ev.t === "error") {
            reply.content += (reply.content ? "\n\n" : "") + (ev.d ?? "");
          }
          paint();
        }
        bottomRef.current?.scrollIntoView({ block: "end" });
      }
      if (sawQueue) setNotice("An item is waiting in the Queue tab for your approval.");
      router.refresh();
    } catch (e) {
      reply.content =
        reply.content || (e instanceof Error ? e.message : "The assistant hit an error.");
      paint();
    } finally {
      setBusy(false);
      // Stored after the reply is complete, and never blocking it: a thread
      // that fails to save still reads correctly on this device for this
      // visit.
      void saveChatTurnsAction([userTurn, reply]);
    }
  }

  async function scanNow() {
    if (scanBusy) return;
    setScanBusy(true);
    setNotice(null);
    const r = await scanMailAction();
    setScanBusy(false);
    if (r.ok) {
      const s = r.summary;
      setNotice(
        s.created === 0
          ? `Scan finished: ${s.scanned} emails read, nothing needs action from you.` +
              (s.notes.length ? ` ${s.notes.join(" ")}` : "")
          : `Mail scan: ${s.scanned} emails read, ${s.created} task${
              s.created === 1 ? "" : "s"
            } proposed into the Tasks inbox.` + (s.notes.length ? ` ${s.notes.join(" ")}` : "")
      );
      router.refresh();
    } else {
      setNotice(r.message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-secondary">
          Tasks, reminders and drafts happen straight away; anything that reaches
          another person waits for your approval in the Queue.
        </p>
        <div className="flex shrink-0 gap-2">
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (busy) return;
                setTurns([]);
                setNotice(null);
                // Actually deleted on the server, not hidden here: a thread
                // he ended must not still be readable from the other device.
                void clearChatAction().then(() => router.refresh());
              }}
              className={btnGhost}
              disabled={busy}
            >
              New chat
            </button>
          )}
          <button type="button" onClick={scanNow} disabled={scanBusy} className={btnGhost}>
            {scanBusy ? "Scanning..." : "Scan mail now"}
          </button>
        </div>
      </div>

      {notice && (
        <p
          role="status"
          className="rise-in rounded-xl border border-waiting/30 bg-waiting-soft p-3 text-sm text-waiting"
        >
          {notice}
        </p>
      )}

      {/* One polite announcement per reply, instead of live-announcing every
          streamed chunk, which shreds a screen reader's reading order. */}
      <p aria-live="polite" className="sr-only">
        {busy ? "The assistant is replying." : ""}
      </p>

      <div className="min-h-[40vh] space-y-3">
        {turns.length === 0 && (
          <div className="rounded-xl border border-dashed border-border-strong p-6 text-center">
            <p className="text-sm font-semibold">Your desk, in one conversation.</p>
            <p className="mt-1 text-sm text-secondary">
              Plan the week, draft a reply, set a reminder, or tap Scan mail
              now. Private lists change straight away and stay undoable;
              anything that reaches another person waits in the Queue for your
              approval. The thread follows you between your phone and your
              laptop, and it goes no further.
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === "user"
                ? "ml-8 rounded-2xl bg-accent p-3 text-sm text-white dark:text-neutral-950"
                : "mr-4 rounded-2xl border border-border bg-surface p-3 text-sm"
            }
          >
            {t.tools?.map((tool, j) => (
              <p
                key={j}
                className={
                  "mb-2 rounded-lg px-2 py-1 text-xs " +
                  (tool.error
                    ? "bg-overdue-soft text-overdue"
                    : "bg-surface-2 text-secondary")
                }
              >
                {tool.name}: {tool.summary}
              </p>
            ))}
            {t.role === "assistant" && !t.content && busy && i === turns.length - 1 ? (
              // Three dots that lift in sequence: typing, not blinking. The
              // phase offsets live in globals.css so all three start
              // mid-cycle instead of waiting their turn at full opacity.
              <span className="flex items-end gap-1 py-1.5" aria-hidden>
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
              </span>
            ) : (
              <p className="whitespace-pre-wrap">{t.content}</p>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="sticky bottom-32 flex gap-2 sm:bottom-20"
      >
        <input
          className={inputCls}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask your assistant..."
          disabled={busy}
        />
        <button type="submit" className={btnPrimary} disabled={busy || !input.trim()}>
          {busy ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}
