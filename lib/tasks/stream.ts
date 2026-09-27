// B20. Which work stream a name from the assistant means.
//
// create_task used to file an unknown stream name under Personal without a
// word, which is how professional mail ended up in Personal. An unknown name
// is now refused with the real list, so the model can pick again. No name at
// all still means Personal. Pure and import-free for scripts/b20.test.ts.

export interface StreamRow {
  id: string;
  name: string;
}

export type StreamPick = { ok: true; id: string } | { ok: false; message: string };

export function pickWorkStream(streams: StreamRow[], name: string | null): StreamPick {
  if (!streams.length) return { ok: false, message: "No work streams exist." };
  const wanted = (name ?? "").trim().toLowerCase();
  const byName = (n: string) => streams.find((w) => w.name.trim().toLowerCase() === n);
  if (!wanted) {
    return { ok: true, id: (byName("personal") ?? streams[0]).id };
  }
  const hit = byName(wanted);
  if (hit) return { ok: true, id: hit.id };
  const names = streams.map((w) => w.name).sort((a, b) => a.localeCompare(b));
  return {
    ok: false,
    message: `There is no work stream called "${name!.trim()}". Use one of: ${names.join(", ")}.`,
  };
}
