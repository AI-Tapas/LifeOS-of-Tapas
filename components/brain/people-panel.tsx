"use client";

// The people directory.
//
// "Unverified" is said in plain words rather than shown as a coloured dot,
// because it means something specific: the assistant created this record from
// scanned mail and nobody has checked it. The approval queue highlights an
// unverified recipient before a send, so a directory he has actually curated
// is what turns that warning from wallpaper into a signal. One tap clears it.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Drawer,
  Empty,
  Field,
  btnGhost,
  btnPrimary,
  drawerFooterCls,
  inputCls,
} from "@/components/ui";
import {
  confirmPersonAction,
  createPersonAction,
  updatePersonAction,
  deletePersonAction,
  type PersonInput,
} from "@/app/(app)/brain/actions";

export interface PersonRow {
  id: string;
  name: string;
  org: string | null;
  role: string | null;
  emails: string[];
  phones: string[];
  context_md: string | null;
  unverified: boolean;
}

export default function PeoplePanel({
  people,
  openPersonId,
}: {
  people: PersonRow[];
  openPersonId?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<PersonRow | "new" | null>(
    () => people.find((p) => p.id === openPersonId) ?? null
  );
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(
    () => [...people].sort((a, b) => a.name.localeCompare(b.name)),
    [people]
  );
  const unverifiedCount = sorted.filter((p) => p.unverified).length;

  function confirm(id: string) {
    startTransition(async () => {
      await confirmPersonAction(id);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium">People</h2>
          <p className="text-sm text-secondary">
            Who they are, where they are, and how you know them.
          </p>
        </div>
        <button
          onClick={() => setEditing("new")}
          className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-950"
        >
          + Add
        </button>
      </div>

      {unverifiedCount > 0 && (
        <p className="mt-3 rounded-lg border border-waiting/40 bg-waiting-soft p-2.5 text-xs text-waiting">
          {unverifiedCount} {unverifiedCount === 1 ? "record was" : "records were"}{" "}
          created by the assistant from scanned mail and nobody has checked{" "}
          {unverifiedCount === 1 ? "it" : "them"} yet. Confirming a record is
          what makes the warning before a send worth reading.
        </p>
      )}

      <ul className="mt-4 space-y-2">
        {sorted.length === 0 ? (
          <li>
            <Empty title="Nobody here yet">
              Add the people you deal with regularly, or let the assistant add
              them from your mail and confirm each one here.
            </Empty>
          </li>
        ) : (
          sorted.map((p) => (
            <li
              key={p.id}
              id={`person-${p.id}`}
              className="rounded-lg border border-border bg-surface p-3 shadow-[var(--shadow-card)]"
            >
              <button onClick={() => setEditing(p)} className="block w-full text-left">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-secondary">
                  {[p.role, p.org].filter(Boolean).join(", ") || "No role recorded"}
                </p>
                {p.emails.length > 0 && (
                  <p className="mt-0.5 break-all text-xs text-secondary">
                    {p.emails.join(", ")}
                  </p>
                )}
                {p.context_md && (
                  <p className="mt-1 text-sm text-secondary">{p.context_md}</p>
                )}
              </button>
              {p.unverified && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-waiting-soft px-2.5 py-1 text-[11px] font-semibold text-waiting">
                    Unverified
                  </span>
                  <span className="text-[11px] text-secondary">
                    The assistant added this one.
                  </span>
                  <button
                    onClick={() => confirm(p.id)}
                    disabled={pending}
                    className="press ml-auto min-h-11 rounded-lg border border-border-strong px-3 text-xs font-medium disabled:opacity-50"
                  >
                    Confirm
                  </button>
                </div>
              )}
            </li>
          ))
        )}
      </ul>

      {editing && (
        <PersonForm
          person={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface Fields {
  name: string;
  role: string;
  org: string;
  email: string;
  phone: string;
  context: string;
}

function toFields(p: PersonRow | null): Fields {
  return {
    name: p?.name ?? "",
    role: p?.role ?? "",
    org: p?.org ?? "",
    email: p?.emails[0] ?? "",
    phone: p?.phones[0] ?? "",
    context: p?.context_md ?? "",
  };
}

function PersonForm({
  person,
  onClose,
}: {
  person: PersonRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<Fields>(() => toFields(person));
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const isEdit = !!person;

  function submit() {
    setErr(null);
    setArmed(false);
    const input: PersonInput = {
      name: f.name,
      role: f.role || null,
      org: f.org || null,
      email: f.email || null,
      phone: f.phone || null,
      context: f.context || null,
    };
    startTransition(async () => {
      const r = isEdit
        ? await updatePersonAction(person!.id, input)
        : await createPersonAction(input);
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setErr(r.message);
      }
    });
  }

  function remove() {
    if (!person) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    startTransition(async () => {
      await deletePersonAction(person.id);
      onClose();
      router.refresh();
    });
  }

  return (
    <Drawer title={isEdit ? "Edit person" : "New person"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <div className="flex gap-2">
          <Field label="Role">
            <input
              value={f.role}
              onChange={(e) => setF({ ...f, role: e.target.value })}
              className={inputCls}
              placeholder="e.g. Branch chairman"
            />
          </Field>
          <Field label="Organisation">
            <input
              value={f.org}
              onChange={(e) => setF({ ...f, org: e.target.value })}
              className={inputCls}
              placeholder="e.g. ICAI Rajkot"
            />
          </Field>
        </div>
        <Field label="Email">
          <input
            type="email"
            inputMode="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            inputMode="tel"
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="How you know them">
          <textarea
            value={f.context}
            onChange={(e) => setF({ ...f, context: e.target.value })}
            className={inputCls}
            rows={3}
            placeholder="e.g. Ran the Level 1 batch in Rajkot, arranges the hotel there"
          />
        </Field>
        {isEdit && person!.unverified && (
          <p className="text-xs text-secondary">
            Saving this record also confirms it: reading it and deciding it is
            right is the whole of what confirming means.
          </p>
        )}

        {err && <p className="text-sm text-overdue">{err}</p>}
        <div className={drawerFooterCls + " flex gap-2"}>
          <button onClick={submit} disabled={pending} className={btnPrimary + " flex-1"}>
            {pending ? "Saving" : isEdit ? "Save" : "Create"}
          </button>
          {isEdit && (
            <button
              onClick={remove}
              disabled={pending}
              className={
                armed
                  ? "press min-h-11 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  : btnGhost + " text-overdue"
              }
            >
              {armed ? "Confirm delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  );
}
