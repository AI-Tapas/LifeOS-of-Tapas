"use client";

// Day and week time grid (B33). Hours run down the side, a timed event is a
// block from its start to its end, overlapping events sit side by side, and
// all-day events sit in a strip above. The geometry is pure (lib/calendar/grid).

import { useEffect, useRef } from "react";
import { formatTimeIST, istHour, istMinute } from "@/lib/datetime";
import { accountColor } from "@/lib/account-colors";
import {
  blockBox,
  gridHours,
  layoutColumns,
  sliceForDay,
  weekHeads,
  type Slice,
} from "@/lib/calendar/grid";
import type { CalAccount, CalEvent } from "./calendar-view";

const PX_PER_HOUR = 48;
const GUTTER = "3rem";

function hourLabel(h: number): string {
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${h < 12 ? "am" : "pm"}`;
}

export default function TimeGrid({
  mode,
  anchorKey,
  todayKey,
  byDay,
  accountById,
  onEvent,
  onAddAt,
  onOpenDay,
}: {
  mode: "day" | "week";
  anchorKey: string;
  todayKey: string;
  byDay: Map<string, CalEvent[]>;
  accountById: Map<string, CalAccount>;
  onEvent: (e: CalEvent) => void;
  onAddAt: (dayKey: string, hour: number) => void;
  onOpenDay?: (dayKey: string) => void;
}) {
  const heads =
    mode === "week"
      ? weekHeads(anchorKey, todayKey)
      : [{ key: anchorKey, weekday: "", day: 0, label: "", isToday: anchorKey === todayKey }];

  // Slices per day, laid out side by side.
  const perDay = heads.map((h) => {
    const dayEvents = byDay.get(h.key) ?? [];
    const allDay = dayEvents.filter((e) => e.all_day);
    const byId = new Map<string, CalEvent>();
    const slices: Slice[] = [];
    for (const e of dayEvents) {
      if (e.all_day) continue;
      const s = sliceForDay(e, h.key);
      if (!s) continue;
      byId.set(e.id, e);
      slices.push(s);
    }
    return { head: h, allDay, byId, placed: layoutColumns(slices), slices };
  });
  const { startHour, endHour } = gridHours(perDay.flatMap((d) => d.slices));
  const totalPx = (endHour - startHour) * PX_PER_HOUR;
  const cols = { gridTemplateColumns: `${GUTTER} repeat(${heads.length}, minmax(0, 1fr))` };

  // Open at the first timed event; with none, at the current time when today
  // is shown, else at 8 am.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const starts = perDay.flatMap((d) => d.slices.map((s) => s.startMin));
    let focusMin = 8 * 60;
    if (starts.length) focusMin = Math.min(...starts);
    else if (heads.some((h) => h.key === todayKey)) {
      const now = new Date().toISOString();
      focusMin = istHour(now) * 60 + istMinute(now);
    }
    el.scrollTop = Math.max(0, ((focusMin - startHour * 60) / 60) * PX_PER_HOUR - 16);
    // once per mount: the parent remounts this grid on every view or date change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {/* Week heads: weekday and date, today marked. The day view's heading is
          the page title, so it has none. */}
      {mode === "week" && (
        <div className="grid border-b border-border text-center text-xs" style={cols}>
          <div />
          {heads.map((h) => (
            <button
              key={h.key}
              onClick={() => onOpenDay?.(h.key)}
              className="press min-h-11 py-1.5"
              aria-label={`Open ${h.label}`}
            >
              <span className={h.isToday ? "font-semibold text-accent" : "text-secondary"}>
                {h.weekday}{" "}
                <span
                  className={
                    h.isToday
                      ? "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-white dark:text-neutral-950"
                      : ""
                  }
                >
                  {h.day}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {perDay.some((d) => d.allDay.length > 0) && (
        <div className="grid border-b border-border" style={cols}>
          <div className="pr-1 pt-1.5 text-right text-[10px] uppercase leading-tight text-neutral-400">
            All day
          </div>
          {perDay.map((d) => (
            <div key={d.head.key} className="min-w-0 space-y-0.5 p-0.5">
              {d.allDay.map((e) => (
                <EventChip
                  key={e.id}
                  event={e}
                  account={accountById.get(e.account_id ?? "")}
                  onClick={() => onEvent(e)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="max-h-[68vh] overflow-y-auto overscroll-contain">
        <div className="grid" style={{ ...cols, height: totalPx }}>
          <div className="relative">
            {Array.from({ length: endHour - startHour }, (_, i) => startHour + i).map((h) => (
              <button
                key={h}
                onClick={() => onAddAt(heads[0].key, h)}
                aria-label={`New event at ${hourLabel(h)}`}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-neutral-400 active:text-accent"
                style={{ top: (h - startHour) * PX_PER_HOUR + (h === startHour ? 8 : 0) }}
              >
                {hourLabel(h)}
              </button>
            ))}
          </div>
          {perDay.map((d) => (
            <div
              key={d.head.key}
              className="relative min-w-0 border-l border-border"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(to bottom, transparent 0, transparent " +
                  (PX_PER_HOUR - 1) +
                  "px, var(--color-border) " +
                  (PX_PER_HOUR - 1) +
                  "px, var(--color-border) " +
                  PX_PER_HOUR +
                  "px)",
              }}
              onClick={(ev) => {
                if (ev.target !== ev.currentTarget) return;
                const y = ev.clientY - ev.currentTarget.getBoundingClientRect().top;
                onAddAt(d.head.key, startHour + Math.floor(y / PX_PER_HOUR));
              }}
            >
              {d.head.isToday && mode === "week" && (
                <div className="pointer-events-none absolute inset-0 bg-accent/5" />
              )}
              {d.placed.map((p) => {
                const e = d.byId.get(p.id)!;
                const { top, height } = blockBox(p, startHour, PX_PER_HOUR);
                const col = accountColor(accountById.get(e.account_id ?? "")?.slot);
                return (
                  <button
                    key={e.id}
                    onClick={() => onEvent(e)}
                    className="press absolute overflow-hidden rounded-md border-l-[3px] px-1 py-0.5 text-left text-[11px] leading-tight"
                    style={{
                      top,
                      height: height - 1,
                      left: `calc(${(p.col / p.cols) * 100}% + 1px)`,
                      width: `calc(${100 / p.cols}% - 2px)`,
                      borderColor: col.hex,
                      backgroundColor: col.soft,
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span className="font-medium">{e.title}</span>
                    {height >= 40 && (
                      <span className="block text-[10px] text-neutral-500">
                        {formatTimeIST(e.start_ts)}
                        {e.end_ts ? ` - ${formatTimeIST(e.end_ts)}` : ""}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EventChip({
  event,
  account,
  onClick,
}: {
  event: CalEvent;
  account?: CalAccount;
  onClick: () => void;
}) {
  const col = accountColor(account?.slot);
  return (
    <button
      onClick={onClick}
      className="press block min-h-6 w-full truncate rounded border-l-[3px] px-1 py-0.5 text-left text-[11px]"
      style={{ borderColor: col.hex, backgroundColor: col.soft }}
    >
      {event.title}
    </button>
  );
}
