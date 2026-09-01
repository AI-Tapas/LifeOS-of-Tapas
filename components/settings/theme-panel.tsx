"use client";

// Settings > Appearance. Three-way theme choice, stored on this device only
// (see lib/theme.ts for why). The stored value lives in localStorage, which
// the server cannot know, so it is read through useSyncExternalStore: that is
// the API built for exactly this, and it keeps the server render ("System")
// from mismatching the client without a state-in-effect hack.

import { useSyncExternalStore } from "react";
import {
  subscribeTheme,
  themeSnapshot,
  themeServerSnapshot,
  writeTheme,
  type ThemeChoice,
} from "@/lib/theme";

const OPTIONS: Array<{ value: ThemeChoice; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follows the device" },
  { value: "light", label: "Light", hint: "Always the day theme" },
  { value: "dark", label: "Dark", hint: "Always the night theme" },
];

export default function ThemePanel() {
  const choice = useSyncExternalStore(
    subscribeTheme,
    themeSnapshot,
    themeServerSnapshot
  );

  function pick(next: ThemeChoice) {
    writeTheme(next);
  }

  return (
    <div>
      <div
        className="grid grid-cols-3 gap-2"
        role="radiogroup"
        aria-label="Theme"
      >
        {OPTIONS.map((o) => {
          const active = choice === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pick(o.value)}
              className={`press flex min-h-[56px] flex-col items-center justify-center rounded-xl border px-2 py-2 text-sm ${
                active
                  ? "border-brand bg-brand-soft font-semibold text-brand-deep"
                  : "border-border bg-surface text-foreground"
              }`}
            >
              <span>{o.label}</span>
              <span className="mt-0.5 text-[11px] text-neutral-500">{o.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-neutral-500">
        Saved on this device, so your phone and laptop can differ.
      </p>
    </div>
  );
}
