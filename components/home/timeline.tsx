"use client";

// "Today's shape": the day's timed events as a rail with a dashed NOW line
// that separates what's already happened from what's ahead. All-day events
// have no time slot to anchor a dot to, so they list separately above the rail.

import { useEffect, useRef, useState } from "react";
import { formatTimeIST } from "@/lib/datetime";
import { accountColor } from "@/lib/account-colors";

export interface TimelineEvent {
  id: string;
  title: string;
  start_ts: string;
  all_day: boolean;
  slot: string | null;
}

const MINUTE = 60_000;

// The line is positioned over the rail rather than inserted between two rows,
// so when a meeting starts it can ease across to its new slot instead of
// jumping. It ticks once a minute and moves a transform on itself: the rail
// and the rows around it never re-render or re-lay out.
//
// The rail is the only thing this transform can contain, and the rail holds no
// position: fixed element, so the bottom nav is unaffected.
function NowLine({ starts, nowIso }: { starts: string[]; nowIso: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Seeded from the server's render clock, which is at most a request old, so
  // the first client render matches the markup. The interval takes over from
  // there.
  const [nowMs, setNowMs] = useState(() => Date.parse(nowIso));
  const first = useRef(true);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), MINUTE);
    return () => clearInterval(id);
  }, []);

  // How many of today's meetings have already started: the line belongs at the
  // top of the next one, or at the foot of the rail once the day is done.
  const index = starts.filter((s) => Date.parse(s) <= nowMs).length;

  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      const rail = el?.parentElement;
      if (!el || !rail) return;
      const rows = rail.querySelectorAll<HTMLElement>("[data-ev]");
      const y = index < rows.length ? rows[index].offsetTop : rail.offsetHeight;
      // Easing is off for the first measurement, so the line appears where it
      // belongs instead of sliding down from the top of the rail on load. From
      // the second one on, every move is a real move and earns the ease.
      if (first.current) first.current = false;
      else el.dataset.eased = "1";
      el.style.setProperty("--now-y", `${y}px`);
      el.dataset.ready = "1";
    };
    measure();
    // A rotation rewraps the titles, so the row the line sits above moves.
    // Re-measure instead of pointing at the wrong meeting until the next tick.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [index]);

  return (
    <div
      ref={ref}
      className="now-line pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-brand"
      style={{ transform: "translateY(var(--now-y, 0px))" }}
    >
      <i className="not-italic absolute -top-2 right-0 bg-background px-1 text-[10px] font-bold text-brand-deep">
        NOW {formatTimeIST(new Date(nowMs).toISOString())}
      </i>
    </div>
  );
}

export default function Timeline({
  events,
  nowIso,
}: {
  events: TimelineEvent[];
  nowIso: string;
}) {
  const allDay = events.filter((e) => e.all_day);
  const timed = events.filter((e) => !e.all_day);

  if (timed.length === 0 && allDay.length === 0) {
    return (
      <p className="text-sm text-secondary">
        No meetings today. A clear runway for the Do first list.
      </p>
    );
  }

  return (
    <div>
      {allDay.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {allDay.map((e) => (
            <li key={e.id} className="flex items-center gap-2.5 text-sm">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: accountColor(e.slot).hex }}
                aria-hidden
              />
              <span className="text-muted">All day</span>
              <span className="min-w-0 break-words font-medium">{e.title}</span>
            </li>
          ))}
        </ul>
      )}
      {timed.length > 0 && (
        <div className="relative pl-14">
          <NowLine starts={timed.map((e) => e.start_ts)} nowIso={nowIso} />
          {timed.map((e) => (
            <div
              key={e.id}
              data-ev
              className="relative border-l-[1.5px] border-border-strong py-2.5 pl-4 before:absolute before:-left-[4.75px] before:top-4 before:h-2 before:w-2 before:rounded-full before:bg-[var(--dot-color)] before:content-['']"
              style={{ ["--dot-color" as string]: accountColor(e.slot).hex }}
            >
              <span className="absolute -left-14 top-3.5 w-11 text-right text-[11px] font-bold text-muted">
                {formatTimeIST(e.start_ts)}
              </span>
              <h4 className="text-sm font-medium leading-snug">{e.title}</h4>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
