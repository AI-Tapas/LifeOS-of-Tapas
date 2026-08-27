"use client";

// Harness-only. Two motions cannot be reached in the preview without a
// database behind them: a count that changes, and a row settling as it is
// marked done. Both get a button here so the pass can be verified offline.

import { useState } from "react";
import { BandHead, Rolling } from "@/components/ui";

export default function MotionDemo() {
  const [count, setCount] = useState(3);
  const [done, setDone] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <BandHead title="Counter" count={count} />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => setCount((c) => Math.max(0, c - 1))}
            className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm"
          >
            Fewer
          </button>
          <button
            onClick={() => setCount((c) => c + 1)}
            className="press min-h-11 rounded-lg border border-border-strong px-3 text-sm"
          >
            More
          </button>
          <span className="text-xs text-muted">
            queue badge:{" "}
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-waiting px-1 text-[9px] font-semibold text-white dark:text-neutral-950">
              <Rolling value={count > 9 ? "9+" : count} />
            </span>
          </span>
        </div>
      </div>

      <div
        className={
          "flex items-center gap-2 rounded-lg border border-border bg-surface p-1.5 shadow-[var(--shadow-card)]" +
          (done ? " settle-done" : "")
        }
      >
        <button
          onClick={() => setDone((d) => !d)}
          aria-label="Mark done"
          className={
            "press flex h-11 w-11 shrink-0 items-center justify-center rounded-full " +
            (done ? "pop-done" : "")
          }
        >
          <span
            className={
              "flex h-5 w-5 items-center justify-center rounded-full border-2 " +
              (done ? "border-ok bg-ok" : "border-border-strong")
            }
          >
            {done && (
              <svg
                viewBox="0 0 12 12"
                className="h-3 w-3 text-white dark:text-neutral-950"
              >
                <path
                  d="m2.5 6.5 2.5 2.5 4.5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
        </button>
        <span className={"text-sm " + (done ? "text-neutral-400 line-through" : "")}>
          Tap the circle: pop, then the ok tint settles out
        </span>
      </div>
    </div>
  );
}
