// B22. One search across his tasks, notes, people and trips, for
// lifeos_search.
//
// Pure: the connector loads the rows (lib/assistant/mcp-api.ts) and this
// decides what matches. Same rule as the Brain screen's note search
// (lib/brain/notes.ts searchNotes): every word must appear, case
// insensitively, somewhere in one haystack of the row's text. ponytail: whole
// lists filtered in memory; a single user has hundreds of rows, not millions.
// Move it into Postgres full-text search if a read ever becomes slow.
//
// A task created from scanned email carries text an outsider wrote, so its
// excerpt goes out inside the untrusted-data fence and the row is flagged,
// the same rule lifeos_list_tasks and the assistant context follow.

import { fenceUntrusted } from "./prompt.ts";

export const SEARCH_KINDS = ["tasks", "notes", "people", "trips"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_MAX = 25;
export const EXCERPT_CHARS = 120;

export interface SearchRow {
  kind: SearchKind;
  id: string;
  title: string;
  // The searchable text beside the title: a task's note, a note's body and
  // tags, a person's organisation, role and context, a trip's notes and
  // cities.
  text: string;
  untrusted: boolean;
}

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  excerpt: string;
  untrusted: boolean;
}

export function searchKinds(v: unknown): SearchKind[] {
  if (!Array.isArray(v) || !v.length) return [...SEARCH_KINDS];
  const picked = SEARCH_KINDS.filter((k) => v.includes(k));
  return picked.length ? picked : [...SEARCH_KINDS];
}

// About EXCERPT_CHARS of the text around the first term found, whitespace
// collapsed. The title is the excerpt when only the title matched.
export function excerptFor(title: string, text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const source = at === undefined ? title.replace(/\s+/g, " ").trim() : flat;
  const start = at === undefined ? 0 : Math.max(0, at - 40);
  const cut = source.slice(start, start + EXCERPT_CHARS);
  return (start > 0 ? "..." : "") + cut + (start + EXCERPT_CHARS < source.length ? "..." : "");
}

export function searchRows(rows: SearchRow[], query: string): { hits: SearchHit[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], total: 0 };
  const matched = rows.filter((r) => {
    const hay = `${r.title}\n${r.text}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const hits = matched.slice(0, SEARCH_MAX).map((r) => {
    const excerpt = excerptFor(r.title, r.text, terms);
    return {
      kind: r.kind,
      id: r.id,
      title: r.title,
      excerpt: r.untrusted ? fenceUntrusted("text from a task created from scanned email or shared text", excerpt) : excerpt,
      untrusted: r.untrusted,
    };
  });
  return { hits, total: matched.length };
}
