"use server";

// Brain server actions: notes and the people directory.
//
// Confidential boundary: a note carries his own words and reference strings.
// There is no attachment, no upload and no file field here, in the schema, or
// in the form, and scripts/m7c.test.ts fails if one appears.

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/require-user";
import type { NoteType } from "@/lib/brain/notes";

export interface NoteInput {
  type: NoteType;
  title: string;
  body?: string | null;
  occurred_on?: string | null;
  work_stream_id?: string | null;
  people_ids?: string[];
  task_id?: string | null;
  trip_id?: string | null;
}

export type NoteResult = { ok: true; id: string } | { ok: false; message: string };

function noteRow(input: NoteInput) {
  return {
    type: input.type,
    title: input.title.trim(),
    body_md: input.body?.trim() || null,
    occurred_on: input.occurred_on || null,
    work_stream_id: input.work_stream_id || null,
    people_ids: input.people_ids ?? [],
    task_id: input.task_id || null,
    trip_id: input.trip_id || null,
  };
}

export async function createNoteAction(input: NoteInput): Promise<NoteResult> {
  const { supabase, user } = await requireUser("/brain");
  if (!input.title.trim()) return { ok: false, message: "A note needs a title." };

  const { data, error } = await supabase
    .from("notes")
    .insert({ user_id: user.id, ...noteRow(input) })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save." };
  revalidatePath("/brain");
  return { ok: true, id: data.id };
}

export async function updateNoteAction(
  id: string,
  patch: NoteInput
): Promise<NoteResult> {
  const { supabase } = await requireUser("/brain");
  if (!patch.title.trim()) return { ok: false, message: "A note needs a title." };

  const { error } = await supabase.from("notes").update(noteRow(patch)).eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/brain");
  return { ok: true, id };
}

export async function deleteNoteAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase } = await requireUser("/brain");
  const { error } = await supabase.from("notes").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/brain");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PersonInput {
  name: string;
  org?: string | null;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  context?: string | null;
}

export type PersonResult = { ok: true; id: string } | { ok: false; message: string };

// A record he types himself is confirmed by the act of typing it. Only the
// assistant's records start unverified, which is what makes the flag mean
// something at send time.
function personRow(input: PersonInput) {
  const email = input.email?.trim().toLowerCase() || "";
  const phone = input.phone?.trim() || "";
  return {
    name: input.name.trim(),
    org: input.org?.trim() || null,
    role: input.role?.trim() || null,
    emails: email ? [email] : [],
    phones: phone ? [phone] : [],
    context_md: input.context?.trim() || null,
  };
}

export async function createPersonAction(input: PersonInput): Promise<PersonResult> {
  const { supabase, user } = await requireUser("/brain");
  if (!input.name.trim()) return { ok: false, message: "A name is required." };

  const { data, error } = await supabase
    .from("people")
    .insert({ user_id: user.id, ...personRow(input), unverified: false })
    .select("id")
    .single();
  if (error || !data) return { ok: false, message: error?.message ?? "Could not save." };
  revalidatePath("/brain");
  return { ok: true, id: data.id };
}

export async function updatePersonAction(
  id: string,
  patch: PersonInput
): Promise<PersonResult> {
  const { supabase } = await requireUser("/brain");
  if (!patch.name.trim()) return { ok: false, message: "A name is required." };

  // Editing a record IS reading it and deciding it is right, so it also
  // clears the flag. Anything else would leave him tapping Confirm on a
  // record he has just finished correcting.
  const { error } = await supabase
    .from("people")
    .update({ ...personRow(patch), unverified: false })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/brain");
  revalidatePath("/assistant");
  return { ok: true, id };
}

// The one tap the approval queue depends on. An unverified record is one the
// assistant created from scanned mail and nobody has checked; the queue
// highlights those recipients, so clearing the flag by hand is what turns that
// warning from noise into a signal.
export async function confirmPersonAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase } = await requireUser("/brain");
  const { error } = await supabase
    .from("people")
    .update({ unverified: false })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/brain");
  revalidatePath("/assistant");
  return { ok: true };
}

export async function deletePersonAction(
  id: string
): Promise<{ ok: boolean; message?: string }> {
  const { supabase } = await requireUser("/brain");
  const { error } = await supabase.from("people").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  revalidatePath("/brain");
  return { ok: true };
}
