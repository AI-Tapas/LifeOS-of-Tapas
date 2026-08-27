// "Today's shape": the day's timed events as a rail with a dashed NOW line
// inserted at the point that separates what's already happened from what's
// ahead. All-day events have no time slot to anchor a dot to, so they list
// separately above the rail.

import { formatTimeIST } from "@/lib/datetime";
import { accountColor } from "@/lib/account-colors";

export interface TimelineEvent {
  id: string;
  title: string;
  start_ts: string;
  all_day: boolean;
  slot: string | null;
}

function NowLine({ nowIso }: { nowIso: string }) {
  return (
    <div className="relative -ml-14 my-1 border-t border-dashed border-brand">
      <i className="not-italic absolute -top-2 right-0 bg-background px-1 text-[10px] font-bold text-brand-deep">
        NOW {formatTimeIST(nowIso)}
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
  const nowIndex = timed.findIndex((e) => e.start_ts > nowIso);
  const insertAt = nowIndex === -1 ? timed.length : nowIndex;

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
          {timed.map((e, i) => (
            <div key={e.id}>
              {i === insertAt && <NowLine nowIso={nowIso} />}
              <div
                className="relative border-l-[1.5px] border-border-strong py-2.5 pl-4 before:absolute before:-left-[4.75px] before:top-4 before:h-2 before:w-2 before:rounded-full before:bg-[var(--dot-color)] before:content-['']"
                style={{ ["--dot-color" as string]: accountColor(e.slot).hex }}
              >
                <span className="absolute -left-14 top-3.5 w-11 text-right text-[11px] font-bold text-muted">
                  {formatTimeIST(e.start_ts)}
                </span>
                <h4 className="text-sm font-medium leading-snug">{e.title}</h4>
              </div>
            </div>
          ))}
          {insertAt === timed.length && <NowLine nowIso={nowIso} />}
        </div>
      )}
    </div>
  );
}
