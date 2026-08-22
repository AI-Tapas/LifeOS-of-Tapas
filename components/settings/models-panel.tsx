"use client";

// Settings > Assistant models. Chooses which provider and model each activity
// uses: the interactive chat, and the mail scan. Only names are stored; API
// keys stay in the server environment and are never shown here. The Test
// button calls the health endpoint for that activity.

import { useState, useTransition } from "react";
import { saveAssistantModelsAction } from "@/app/(app)/settings/actions";
import { btnPrimary, btnGhost, inputCls } from "@/components/ui";

export interface ProviderOption {
  name: string;
  hasKey: boolean;
  defaultModel: string;
}

export interface ModelChoice {
  provider: string | null;
  model: string | null;
}

const ROLES = [
  {
    key: "chat" as const,
    label: "Assistant chat",
    hint: "You wait for this one, so speed matters.",
  },
  {
    key: "scan" as const,
    label: "Mail scan",
    hint: "Runs in the background, so a slower model is fine.",
  },
];

export default function ModelsPanel({
  options,
  envProvider,
  chat,
  scan,
}: {
  options: ProviderOption[];
  envProvider: string;
  chat: ModelChoice;
  scan: ModelChoice;
}) {
  const [values, setValues] = useState({
    chat_provider: chat.provider ?? "",
    chat_model: chat.model ?? "",
    scan_provider: scan.provider ?? "",
    scan_model: scan.model ?? "",
  });
  const [message, setMessage] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const set = (k: keyof typeof values, v: string) =>
    setValues((prev) => ({ ...prev, [k]: v }));

  async function test(role: "chat" | "scan") {
    setTested((t) => ({ ...t, [role]: "Testing..." }));
    try {
      const res = await fetch(`/api/assistant/health?role=${role}`, {
        cache: "no-store",
      });
      const j = (await res.json()) as {
        ok: boolean;
        provider: string;
        model: string;
        ms: number;
        error?: string;
      };
      setTested((t) => ({
        ...t,
        [role]: j.ok
          ? `Working: ${j.provider}, ${j.model}, replied in ${(j.ms / 1000).toFixed(1)}s.`
          : `Failed: ${j.error ?? "unknown error"}`,
      }));
    } catch {
      setTested((t) => ({ ...t, [role]: "Could not reach the health check." }));
    }
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <p className="text-sm text-neutral-500">
        Which model does what. Leave a row on Server default to follow the
        deployment setting, currently {envProvider}. Saved choices apply to the
        next message; keys live on the server and are never shown here.
      </p>

      {ROLES.map((role) => {
        const providerKey = `${role.key}_provider` as keyof typeof values;
        const modelKey = `${role.key}_model` as keyof typeof values;
        const chosen = options.find((o) => o.name === values[providerKey]);
        return (
          <div
            key={role.key}
            className="mt-4 border-t border-neutral-100 pt-4 first:border-0 dark:border-neutral-800"
          >
            <p className="font-medium">{role.label}</p>
            <p className="text-xs text-neutral-500">{role.hint}</p>

            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-500">Provider</span>
                <select
                  className={inputCls}
                  value={values[providerKey]}
                  onChange={(e) => set(providerKey, e.target.value)}
                >
                  <option value="">Server default ({envProvider})</option>
                  {options.map((o) => (
                    <option key={o.name} value={o.name} disabled={!o.hasKey}>
                      {o.name}
                      {o.hasKey ? "" : " (no key set)"}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-500">
                  Model id (blank uses the default)
                </span>
                <input
                  className={inputCls}
                  value={values[modelKey]}
                  onChange={(e) => set(modelKey, e.target.value)}
                  placeholder={chosen?.defaultModel ?? "provider default"}
                  spellCheck={false}
                />
              </label>
            </div>

            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                className={btnGhost}
                onClick={() => test(role.key)}
                disabled={pending}
              >
                Test this model
              </button>
              {tested[role.key] && (
                <span className="text-xs text-neutral-600 dark:text-neutral-300">
                  {tested[role.key]}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {message && (
        <p className="mt-3 text-sm text-indigo-700 dark:text-indigo-300">{message}</p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await saveAssistantModelsAction(values);
              setMessage(
                r.ok
                  ? "Saved. Test above to confirm, then use the Assistant."
                  : r.message ?? "Could not save."
              );
              setTested({});
            })
          }
        >
          {pending ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
