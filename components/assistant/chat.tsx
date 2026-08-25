"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, inputCls } from "@/components/ui";
import { scanMailAction } from "@/app/(app)/assistant/actions";

interface Turn {
  role: "user" | "assistant";
  content: string;
  tools?: { name: string; summary: string; error?: boolean }[];
}

// The conversation survives navigation and reloads on this device by living
// in localStorage. ponytail: device-local on purpose, no table and no sync;
// move it into the database if the same thread is ever needed on the phone
// and the laptop at once. Only the last 40 turns are kept.
const STORE_KEY = "life_os_assistant_chat_v1";
const KEEP_TURNS = 40;

function loadTurns(): Turn[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Turn[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-KEEP_TURNS) : [];
  } catch {
    return [];
  }
}

function saveTurns(turns: Turn[]): void {
  try {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify(turns.slice(-KEEP_TURNS))
    );
  } catch {
    // storage full or blocked; the chat still works for this visit
  }
}

export default function AssistantChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [restored, setRestored] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Restore after mount (localStorage does not exist during server render),
  // then persist every change once the restore has happened, so the initial
  // empty state never overwrites a saved conversation.
  useEffect(() => {
    setTurns(loadTurns());
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored) saveTurns(turns);
  }, [turns, restored]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setNotice(null);
    const history = [...turns, { role: "user" as const, content: text }];
    setTurns([...history, { role: "assistant", content: "", tools: [] }]);
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
          setTurns((prev) => {
            const next = [...prev];
            const last = { ...next[next.length - 1] };
            if (ev.t === "text") last.content += ev.d ?? "";
            if (ev.t === "tool") {
              last.tools = [
                ...(last.tools ?? []),
                { name: ev.name ?? "tool", summary: ev.summary ?? "", error: ev.error },
              ];
              if (ev.queued) sawQueue = true;
            }
            if (ev.t === "notice" || ev.t === "error") {
              last.content += (last.content ? "\n\n" : "") + (ev.d ?? "");
            }
            next[next.length - 1] = last;
            return next;
          });
        }
        bottomRef.current?.scrollIntoView({ block: "end" });
      }
      if (sawQueue) setNotice("An item is waiting in the Queue tab for your approval.");
      router.refresh();
    } catch (e) {
      setTurns((prev) => {
        const next = [...prev];
        const last = { ...next[next.length - 1] };
        last.content =
          last.content || (e instanceof Error ? e.message : "The assistant hit an error.");
        next[next.length - 1] = last;
        return next;
      });
    } finally {
      setBusy(false);
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
        `Mail scan: ${s.scanned} emails read, ${s.created} task${
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
        <p className="text-sm text-neutral-500">
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
              }}
              className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
              disabled={busy}
            >
              New chat
            </button>
          )}
          <button
            type="button"
            onClick={scanNow}
            disabled={scanBusy}
            className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-neutral-700"
          >
            {scanBusy ? "Scanning..." : "Scan mail now"}
          </button>
        </div>
      </div>

      {notice && (
        <p className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200">
          {notice}
        </p>
      )}

      <div className="min-h-[40vh] space-y-3">
        {restored && turns.length === 0 && (
          <p className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Ask for anything: plan the week, draft a reply, set a reminder,
            or tap Scan mail now. This conversation is kept on this device
            until you start a new chat.
          </p>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === "user"
                ? "ml-8 rounded-2xl bg-indigo-600 p-3 text-sm text-white"
                : "mr-4 rounded-2xl border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
            }
          >
            {t.tools?.map((tool, j) => (
              <p
                key={j}
                className={
                  "mb-2 rounded-lg px-2 py-1 text-xs " +
                  (tool.error
                    ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300")
                }
              >
                {tool.name}: {tool.summary}
              </p>
            ))}
            <p className="whitespace-pre-wrap">
              {t.content || (t.role === "assistant" && busy && i === turns.length - 1 ? "..." : t.content)}
            </p>
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
