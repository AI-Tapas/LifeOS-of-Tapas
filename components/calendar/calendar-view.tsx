"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  istDayKey,
  istHour,
  formatTimeIST,
  formatDateIST,
  formatMonthYear,
  formatWeekdayIST,
  istInstant,
  addDays,
  addMonths,
  startOfWeek,
  civilKey,
  civilWeekday,
  type CivilDate,
} from "@/lib/datetime";
import { accountColor } from "@/lib/account-colors";
import {
  syncEventsAction,
  createEventAction,
  updateEventAction,
  deleteEventAction,
} from "@/app/(app)/calendar/actions";
import type { AppEventInput } from "@/lib/events/payload";

export type CalView = "day" | "week" | "month";

export interface CalEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_ts: string;
  end_ts: string | null;
  all_day: boolean;
  attendees: unknown;
  account_id: string | null;
  calendar_id: string | null;
  source: string;
}
export interface CalAccount {
  id: string;
  slot: string | null;
  status: string;
  label: string;
}
export interface CalCalendar {
  id: string;
  account_id: string;
  name: string;
  is_primary_write: boolean;
}
export interface WritableAccount {
  id: string;
  slot: string | null;
  label: string;
}

function keyToCivil(key: string): CivilDate {
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

// Day keys an event covers (start..end inclusive), for month/week placement.
function eventDayKeys(e: CalEvent): string[] {
  const startKey = istDayKey(e.start_ts);
  if (!e.end_ts) return [startKey];
  // All-day end is exclusive; step back a day so a one-day all-day event maps to
  // a single cell.
  const endMs = new Date(e.end_ts).getTime() - (e.all_day ? 60000 : 0);
  const endKey = istDayKey(new Date(endMs).toISOString());
  const keys: string[] = [];
  let c = keyToCivil(startKey);
  for (let i = 0; i < 60; i++) {
    const k = civilKey(c);
    keys.push(k);
    if (k === endKey) break;
    c = addDays(c, 1);
  }
  return keys.length ? keys : [startKey];
}

export default function CalendarView({
  view,
  anchorKey,
  todayKey,
  events,
  accounts,
  writableAccounts,
  stale,
}: {
  view: CalView;
  anchorKey: string;
  todayKey: string;
  events: CalEvent[];
  accounts: CalAccount[];
  writableAccounts: WritableAccount[];
  stale: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const anchor = keyToCivil(anchorKey);
  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts]
  );

  // On open: sync when the data is stale, then refresh the server data.
  useEffect(() => {
    if (!stale) return;
    startTransition(async () => {
      await syncEventsAction();
      router.refresh();
    });
    // run once on mount for this view/anchor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(v: CalView, date: CivilDate) {
    router.push(`/calendar?view=${v}&date=${civilKey(date)}`);
  }
  function step(dir: number) {
    if (view === "day") go("day", addDays(anchor, dir));
    else if (view === "week") go("week", addDays(anchor, dir * 7));
    else go("month", addMonths(anchor, dir));
  }
  function manualRefresh() {
    setNotice(null);
    startTransition(async () => {
      const r = await syncEventsAction();
      if (r.ok && r.skipped.length) {
        setNotice(
          "Synced. Some accounts were skipped: " +
            r.skipped.map((s) => `${s.slot ?? "account"} (${s.reason})`).join(", ")
        );
      }
      router.refresh();
    });
  }

  const title =
    view === "day"
      ? formatDateIST(istInstant(anchor, 12, 0))
      : view === "week"
        ? weekTitle(anchor)
        : formatMonthYear(anchor);

  function openCreate(prefill: CivilDate, hour?: number) {
    if (writableAccounts.length === 0) {
      setNotice("No writable account. Set a write-back calendar in Settings.");
      return;
    }
    setSelected(null);
    setForm(newForm(prefill, hour, writableAccounts[0].id));
  }
  function openEdit(e: CalEvent) {
    setSelected(null);
    setForm(editForm(e));
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        <button
          onClick={manualRefresh}
          disabled={pending}
          className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs disabled:opacity-50 dark:border-neutral-700"
        >
          {pending ? "Syncing" : "Refresh"}
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {(["day", "week", "month"] as CalView[]).map((v) => (
            <button
              key={v}
              onClick={() => go(v, anchor)}
              className={
                "rounded-full px-3 py-1 text-sm capitalize " +
                (v === view
                  ? "bg-indigo-600 text-white"
                  : "border border-neutral-300 dark:border-neutral-700")
              }
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => step(-1)}
            className="rounded-lg border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            aria-label="Previous"
          >
            ‹
          </button>
          <button
            onClick={() => go(view, keyToCivil(todayKey))}
            className="rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            Today
          </button>
          <button
            onClick={() => step(1)}
            className="rounded-lg border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
            aria-label="Next"
          >
            ›
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {legendAccounts(accounts, events).map((a) => (
          <span key={a.id} className="flex items-center gap-1 text-xs text-neutral-500">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: accountColor(a.slot).hex }}
            />
            {a.label}
          </span>
        ))}
        <button
          onClick={() => openCreate(anchor, istHour(new Date().toISOString()) + 1)}
          className="ml-auto rounded-lg bg-indigo-600 px-3 py-1 text-sm font-medium text-white"
        >
          + New
        </button>
      </div>

      {notice && (
        <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          {notice}
        </p>
      )}

      <div className="mt-4">
        {view === "month" && (
          <MonthGrid
            anchor={anchor}
            todayKey={todayKey}
            events={events}
            accountById={accountById}
            onDay={(d) => go("day", d)}
            onEvent={setSelected}
          />
        )}
        {view === "week" && (
          <WeekAgenda
            anchor={anchor}
            todayKey={todayKey}
            events={events}
            accountById={accountById}
            onEvent={setSelected}
            onAddDay={(d) => openCreate(d)}
          />
        )}
        {view === "day" && (
          <DayGrid
            anchor={anchor}
            events={events}
            accountById={accountById}
            onEvent={setSelected}
            onAddHour={(h) => openCreate(anchor, h)}
          />
        )}
      </div>

      {selected && (
        <EventDetail
          event={selected}
          account={selected.account_id ? accountById.get(selected.account_id) : undefined}
          onClose={() => setSelected(null)}
          onEdit={openEdit}
          onDeleted={() => {
            setSelected(null);
            router.refresh();
          }}
        />
      )}

      {form && (
        <EventForm
          state={form}
          writableAccounts={writableAccounts}
          accountById={accountById}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------
function MonthGrid({
  anchor,
  todayKey,
  events,
  accountById,
  onDay,
  onEvent,
}: {
  anchor: CivilDate;
  todayKey: string;
  events: CalEvent[];
  accountById: Map<string, CalAccount>;
  onDay: (d: CivilDate) => void;
  onEvent: (e: CalEvent) => void;
}) {
  const first: CivilDate = { y: anchor.y, m: anchor.m, d: 1 };
  const lead = (civilWeekday(first) + 6) % 7; // Monday-start offset
  const gridStart = addDays(first, -lead);
  const byDay = groupByDay(events);
  const cells: CivilDate[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-[11px] text-neutral-400">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px rounded-lg bg-neutral-200 dark:bg-neutral-800">
        {cells.map((c) => {
          const key = civilKey(c);
          const inMonth = c.m === anchor.m;
          const dayEvents = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <button
              key={key}
              onClick={() => onDay(c)}
              className={
                "min-h-16 bg-white p-1 text-left align-top dark:bg-neutral-950 " +
                (inMonth ? "" : "opacity-40")
              }
            >
              <div
                className={
                  "text-[11px] " +
                  (isToday
                    ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-white"
                    : "text-neutral-500")
                }
              >
                {c.d}
              </div>
              <div className="mt-0.5 space-y-0.5">
                {dayEvents.slice(0, 3).map((e) => {
                  const col = accountColor(accountById.get(e.account_id ?? "")?.slot);
                  return (
                    <div
                      key={e.id + key}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onEvent(e);
                      }}
                      className="truncate rounded px-1 text-[10px] leading-tight"
                      style={{ backgroundColor: col.soft, color: col.hex }}
                    >
                      {e.all_day ? "" : formatTimeIST(e.start_ts) + " "}
                      {e.title}
                    </div>
                  );
                })}
                {dayEvents.length > 3 && (
                  <div className="text-[10px] text-neutral-400">
                    +{dayEvents.length - 3} more
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week agenda (mobile-first: a readable 7-day list, not a tiny time grid)
// ---------------------------------------------------------------------------
function WeekAgenda({
  anchor,
  todayKey,
  events,
  accountById,
  onEvent,
  onAddDay,
}: {
  anchor: CivilDate;
  todayKey: string;
  events: CalEvent[];
  accountById: Map<string, CalAccount>;
  onEvent: (e: CalEvent) => void;
  onAddDay: (d: CivilDate) => void;
}) {
  const start = startOfWeek(anchor);
  const byDay = groupByDay(events);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="space-y-3">
      {days.map((c) => {
        const key = civilKey(c);
        const dayEvents = byDay.get(key) ?? [];
        const isToday = key === todayKey;
        return (
          <section key={key}>
            <div className="flex items-center justify-between border-b border-neutral-200 pb-1 dark:border-neutral-800">
              <h3 className={"text-sm font-medium " + (isToday ? "text-indigo-600" : "")}>
                {formatWeekdayIST(istInstant(c, 12, 0))} {c.d}{" "}
                {isToday && <span className="text-xs">(today)</span>}
              </h3>
              <button
                onClick={() => onAddDay(c)}
                className="text-xs text-neutral-400"
                aria-label="Add event"
              >
                + add
              </button>
            </div>
            {dayEvents.length === 0 ? (
              <p className="py-1 text-xs text-neutral-400">Nothing scheduled</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {dayEvents.map((e) => (
                  <EventRow
                    key={e.id + key}
                    event={e}
                    account={accountById.get(e.account_id ?? "")}
                    onClick={() => onEvent(e)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day grid (hour rows; tap an empty hour to create)
// ---------------------------------------------------------------------------
function DayGrid({
  anchor,
  events,
  accountById,
  onEvent,
  onAddHour,
}: {
  anchor: CivilDate;
  events: CalEvent[];
  accountById: Map<string, CalAccount>;
  onEvent: (e: CalEvent) => void;
  onAddHour: (h: number) => void;
}) {
  const key = civilKey(anchor);
  const byDay = groupByDay(events);
  const dayEvents = byDay.get(key) ?? [];
  const allDay = dayEvents.filter((e) => e.all_day);
  const timed = dayEvents.filter((e) => !e.all_day);
  const byHour = new Map<number, CalEvent[]>();
  for (const e of timed) {
    const h = istHour(e.start_ts);
    const list = byHour.get(h) ?? [];
    list.push(e);
    byHour.set(h, list);
  }

  return (
    <div>
      {allDay.length > 0 && (
        <div className="mb-2 space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">All day</p>
          {allDay.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              account={accountById.get(e.account_id ?? "")}
              onClick={() => onEvent(e)}
            />
          ))}
        </div>
      )}
      <div className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {Array.from({ length: 24 }, (_, h) => h).map((h) => (
          <div key={h} className="flex gap-2 py-1">
            <button
              onClick={() => onAddHour(h)}
              className="w-12 shrink-0 pt-1 text-right text-[11px] text-neutral-400"
            >
              {hourLabel(h)}
            </button>
            <div className="min-h-6 flex-1 space-y-1">
              {(byHour.get(h) ?? []).map((e) => (
                <EventRow
                  key={e.id}
                  event={e}
                  account={accountById.get(e.account_id ?? "")}
                  onClick={() => onEvent(e)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventRow({
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
      className="block w-full rounded-lg border-l-4 px-2 py-1 text-left text-sm"
      style={{ borderColor: col.hex, backgroundColor: col.soft }}
    >
      <span className="font-medium">{event.title}</span>
      {!event.all_day && (
        <span className="ml-2 text-xs text-neutral-500">
          {formatTimeIST(event.start_ts)}
          {event.end_ts ? ` - ${formatTimeIST(event.end_ts)}` : ""}
        </span>
      )}
      {event.location && (
        <span className="block truncate text-xs text-neutral-400">{event.location}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Event detail drawer
// ---------------------------------------------------------------------------
function EventDetail({
  event,
  account,
  onClose,
  onEdit,
  onDeleted,
}: {
  event: CalEvent;
  account?: CalAccount;
  onClose: () => void;
  onEdit: (e: CalEvent) => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const readOnly = account?.slot === "icai";
  const attendees = Array.isArray(event.attendees)
    ? (event.attendees as { email?: string; name?: string }[])
    : [];

  return (
    <Drawer onClose={onClose} title="Event">
      <h3 className="text-lg font-medium">{event.title}</h3>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
        {formatDateIST(event.start_ts)}
        {event.all_day
          ? " (all day)"
          : `, ${formatTimeIST(event.start_ts)}${
              event.end_ts ? " - " + formatTimeIST(event.end_ts) : ""
            }`}
      </p>
      {event.location && <p className="mt-1 text-sm">{event.location}</p>}
      {event.description && (
        <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300">
          {event.description}
        </p>
      )}
      <p className="mt-3 text-xs text-neutral-500">
        Account: {account?.label ?? "Unknown"}
        {readOnly ? " (read-only)" : ""}
      </p>
      {attendees.length > 0 && (
        <p className="mt-1 text-xs text-neutral-500">
          Attendees: {attendees.map((a) => a.email).filter(Boolean).join(", ")}
        </p>
      )}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-4 flex gap-2">
        {!readOnly && (
          <button
            onClick={() => onEdit(event)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            Edit
          </button>
        )}
        {event.source === "app" && !readOnly && (
          <button
            onClick={() => {
              if (!confirm("Delete this event?")) return;
              setErr(null);
              startTransition(async () => {
                const r = await deleteEventAction(event.id);
                if (r.ok) onDeleted();
                else setErr(r.message ?? "Could not delete.");
              });
            }}
            disabled={pending}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-red-600 disabled:opacity-50 dark:border-neutral-700"
          >
            Delete
          </button>
        )}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------
interface FormState {
  mode: "create" | "edit";
  eventId?: string;
  accountId: string;
  title: string;
  date: string; // YYYY-MM-DD (IST)
  allDay: boolean;
  startTime: string; // HH:MM
  endTime: string;
  location: string;
  description: string;
  attendees: string;
}

function newForm(d: CivilDate, hour: number | undefined, accountId: string): FormState {
  const h = Math.min(Math.max(hour ?? 9, 0), 23);
  return {
    mode: "create",
    accountId,
    title: "",
    date: civilKey(d),
    allDay: false,
    startTime: `${String(h).padStart(2, "0")}:00`,
    endTime: `${String(Math.min(h + 1, 23)).padStart(2, "0")}:00`,
    location: "",
    description: "",
    attendees: "",
  };
}
function editForm(e: CalEvent): FormState {
  const dayKey = istDayKey(e.start_ts);
  return {
    mode: "edit",
    eventId: e.id,
    accountId: e.account_id ?? "",
    title: e.title,
    date: dayKey,
    allDay: e.all_day,
    startTime: hmFromIso(e.start_ts),
    endTime: e.end_ts ? hmFromIso(e.end_ts) : hmFromIso(e.start_ts),
    location: e.location ?? "",
    description: e.description ?? "",
    attendees: Array.isArray(e.attendees)
      ? (e.attendees as { email?: string }[]).map((a) => a.email).filter(Boolean).join(", ")
      : "",
  };
}

function EventForm({
  state,
  writableAccounts,
  accountById,
  onClose,
  onDone,
}: {
  state: FormState;
  writableAccounts: WritableAccount[];
  accountById: Map<string, CalAccount>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState<FormState>(state);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [confirmCount, setConfirmCount] = useState<number | null>(null);

  const isEdit = f.mode === "edit";
  const editAccountLabel = accountById.get(f.accountId)?.label ?? "Account";

  function buildInput(): AppEventInput {
    const [y, m, d] = f.date.split("-").map(Number);
    const civil = { y, m, d };
    const parseHM = (s: string) => {
      const [hh, mm] = s.split(":").map(Number);
      return { hh: hh || 0, mm: mm || 0 };
    };
    let startIso: string;
    let endIso: string | undefined;
    if (f.allDay) {
      startIso = istInstant(civil, 0, 0).toISOString();
      endIso = istInstant(addDays(civil, 1), 0, 0).toISOString();
    } else {
      const s = parseHM(f.startTime);
      const e = parseHM(f.endTime);
      startIso = istInstant(civil, s.hh, s.mm).toISOString();
      endIso = istInstant(civil, e.hh, e.mm).toISOString();
    }
    const attendees = f.attendees
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter((x) => x.includes("@"))
      .map((email) => ({ email }));
    return {
      title: f.title.trim(),
      description: f.description.trim() || undefined,
      location: f.location.trim() || undefined,
      startIso,
      endIso,
      allDay: f.allDay,
      attendees: attendees.length ? attendees : undefined,
    };
  }

  function submit(confirmed: boolean) {
    setErr(null);
    const input = buildInput();
    if (!input.title) {
      setErr("A title is required.");
      return;
    }
    startTransition(async () => {
      const r = isEdit
        ? await updateEventAction(f.eventId!, input, confirmed)
        : await createEventAction(f.accountId, input, confirmed);
      if (r.ok) {
        onDone();
      } else if ("needsConfirmation" in r) {
        setConfirmCount(r.attendeeCount);
      } else {
        setErr(r.message);
      }
    });
  }

  return (
    <Drawer onClose={onClose} title={isEdit ? "Edit event" : "New event"}>
      <div className="space-y-3">
        {!isEdit ? (
          <Field label="Account">
            <select
              value={f.accountId}
              onChange={(e) => setF({ ...f, accountId: e.target.value })}
              className={inputCls}
            >
              {writableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-xs text-neutral-500">On {editAccountLabel}</p>
        )}
        <Field label="Title">
          <input
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            className={inputCls}
            placeholder="Event title"
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={f.date}
            onChange={(e) => setF({ ...f, date: e.target.value })}
            className={inputCls}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.allDay}
            onChange={(e) => setF({ ...f, allDay: e.target.checked })}
          />
          All day
        </label>
        {!f.allDay && (
          <div className="flex gap-2">
            <Field label="Start">
              <input
                type="time"
                value={f.startTime}
                onChange={(e) => setF({ ...f, startTime: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label="End">
              <input
                type="time"
                value={f.endTime}
                onChange={(e) => setF({ ...f, endTime: e.target.value })}
                className={inputCls}
              />
            </Field>
          </div>
        )}
        <Field label="Location">
          <input
            value={f.location}
            onChange={(e) => setF({ ...f, location: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Notes">
          <textarea
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            className={inputCls}
            rows={2}
          />
        </Field>
        <Field label="Attendees (emails, comma separated)">
          <input
            value={f.attendees}
            onChange={(e) => setF({ ...f, attendees: e.target.value })}
            className={inputCls}
            placeholder="name@example.com"
          />
        </Field>

        {err && <p className="text-sm text-red-600">{err}</p>}

        {confirmCount !== null ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <p className="text-amber-900 dark:text-amber-200">
              This will send an invite to {confirmCount}{" "}
              {confirmCount === 1 ? "person" : "people"}.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => submit(true)}
                disabled={pending}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {pending ? "Sending" : "Confirm and send invites"}
              </button>
              <button
                onClick={() => setConfirmCount(null)}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => submit(false)}
            disabled={pending}
            className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving" : isEdit ? "Save changes" : "Create event"}
          </button>
        )}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-50 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950 sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">{title}</h2>
          <button onClick={onClose} className="text-neutral-400" aria-label="Close">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function groupByDay(events: CalEvent[]): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  for (const e of events) {
    for (const key of eventDayKeys(e)) {
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      return a.start_ts.localeCompare(b.start_ts);
    });
  }
  return map;
}

function legendAccounts(accounts: CalAccount[], events: CalEvent[]): CalAccount[] {
  const used = new Set(events.map((e) => e.account_id));
  return accounts.filter((a) => used.has(a.id));
}

function hmFromIso(iso: string): string {
  const t = formatTimeIST(iso); // "9:30 am"
  const m = t.match(/(\d+):(\d+)\s*(am|pm)/i);
  if (!m) return "09:00";
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function hourLabel(h: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

function weekTitle(anchor: CivilDate): string {
  const s = startOfWeek(anchor);
  const e = addDays(s, 6);
  return `${formatDateIST(istInstant(s, 12, 0))} - ${formatDateIST(istInstant(e, 12, 0))}`;
}
