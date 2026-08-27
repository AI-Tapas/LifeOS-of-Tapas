"use client";

// Settings > Assistant persona. View the active version, edit into a NEW
// version, or switch the active one. The persona shapes tone only; the
// approval gates are code and ignore whatever is written here.

import { useState, useTransition } from "react";
import {
  savePersonaVersionAction,
  activatePersonaVersionAction,
} from "@/app/(app)/settings/actions";
import { btnPrimary, btnGhost } from "@/components/ui";

export interface PersonaVersionView {
  id: string;
  version: number;
  source: string;
  active: boolean;
  created_label: string;
}

export default function PersonaPanel({
  versions,
  activeMd,
}: {
  versions: PersonaVersionView[];
  activeMd: string;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(activeMd);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const active = versions.find((v) => v.active);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">
            {active ? `Version ${active.version} (${active.source})` : "No persona set"}
          </p>
          <p className="text-sm text-secondary">
            Tone and judgment only. It can never skip your approvals; that rule
            lives in code.
          </p>
        </div>
        <button type="button" className={btnGhost} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "View"}
        </button>
      </div>

      {message && (
        <p
          role="status"
          className={
            "mt-2 rounded-lg p-2 text-sm " +
            (message.ok
              ? "bg-ok-soft text-ok"
              : "bg-overdue-soft text-overdue")
          }
        >
          {message.text}
        </p>
      )}

      {open && !editing && (
        <>
          <pre className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface-2 p-3 font-sans text-sm">
            {activeMd || "Empty."}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                setDraft(activeMd);
                setEditing(true);
                setMessage(null);
              }}
            >
              Edit as new version
            </button>
          </div>
        </>
      )}

      {open && editing && (
        <>
          <textarea
            className="mt-3 h-96 w-full rounded-xl border border-border-strong bg-surface p-3 font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={pending || !draft.trim()}
              onClick={() =>
                startTransition(async () => {
                  const r = await savePersonaVersionAction(draft);
                  if (r.ok) {
                    setMessage({ text: `Saved as version ${r.version}, now active.`, ok: true });
                    setEditing(false);
                  } else {
                    setMessage({ text: r.message ?? "Could not save.", ok: false });
                  }
                })
              }
            >
              {pending ? "Saving..." : "Save as new version"}
            </button>
            <button type="button" className={btnGhost} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {versions.length > 1 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-xs font-medium text-secondary">All versions</p>
          <ul className="mt-1 space-y-1">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between text-sm">
                <span>
                  v{v.version} ({v.source}), {v.created_label}
                  {v.active ? ", active" : ""}
                </span>
                {!v.active && (
                  <button
                    type="button"
                    disabled={pending}
                    className="rounded-lg border border-border-strong px-2 py-0.5 text-xs disabled:opacity-50"
                    onClick={() =>
                      startTransition(async () => {
                        const r = await activatePersonaVersionAction(v.id);
                        setMessage(
                          r.ok
                            ? { text: `Version ${v.version} is now active.`, ok: true }
                            : { text: r.message ?? "Failed.", ok: false }
                        );
                      })
                    }
                  >
                    Make active
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
