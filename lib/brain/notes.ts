// Notes: the search and the labels the Brain screen reads.
//
// The confidential boundary applies here more than anywhere: a note holds his
// own words and reference strings. There is no attachment, no upload, no file
// path and no field that invites one, and scripts/m7c.test.ts fails if one
// appears.
//
// Search is done over the loaded rows rather than in SQL. He has hundreds of
// notes, not millions, and doing it here means it is instant as he types, it
// matches the title and the body by the same rule, and it can be proven
// offline. ponytail: whole-list filter; move it to a Postgres text index if
// the note count ever makes the page slow to load.
//
// Relative .ts import so node --test resolves it without a bundler.
import { formatDateIST } from "../datetime.ts";

export type NoteType = "meeting" | "decision" | "idea" | "reference";

export const NOTE_TYPES: NoteType[] = ["meeting", "decision", "idea", "reference"];

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  meeting: "Meeting",
  decision: "Decision",
  idea: "Idea",
  reference: "Reference",
};

export interface Note {
  id: string;
  type: NoteType;
  title: string;
  body_md: string | null;
  occurred_on: string | null; // YYYY-MM-DD
  work_stream_id: string | null;
  project_id: string | null;
  people_ids: string[];
  task_id: string | null;
  trip_id: string | null;
  created_at: string;
}

// Every whitespace-separated term must appear somewhere in the title or the
// body, case insensitively. Terms are ANDed because two words narrow a search
// in every tool he already uses; an OR would widen it and hand back the list
// he was trying to escape. Title and body are one haystack, so "GST Mehta"
// finds a note titled "GST position" whose body names Mehta.
export function searchNotes<T extends { title: string; body_md: string | null }>(
  notes: T[],
  query: string
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return notes;
  return notes.filter((n) => {
    const hay = `${n.title}\n${n.body_md ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

// Newest first, on created_at. occurred_on is when the meeting happened, which
// is not the same question as when the note was written, so it is shown but
// never used to order the list.
export function newestFirst<T extends { created_at: string }>(notes: T[]): T[] {
  return [...notes].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// The date under a note's title: the day it is about where it says so, and the
// day it was written otherwise, labelled so the two are never confused.
export function noteDateLabel(n: {
  occurred_on: string | null;
  created_at: string;
}): string {
  if (n.occurred_on) return formatDateIST(`${n.occurred_on}T12:00:00+05:30`);
  return `Written ${formatDateIST(n.created_at)}`;
}

// One line of the body for the list row. Markdown is stored, not rendered:
// this strips the few marks that would otherwise show up as punctuation noise
// in a one-line preview, and nothing here ever emits markup.
export function notePreview(body: string | null, max = 120): string {
  if (!body) return "";
  const flat = body
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}
