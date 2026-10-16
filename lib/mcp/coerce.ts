// A connected client can hold a stale copy of a tool's schema. When a field
// is added after the client cached the list, the client does not know the
// field's type and sends its value as text: "64895.12" instead of 64895.12
// (found 16 Oct 2026, when the new holding fields were added). This turns
// such a value back into a number, ONLY for a top-level field the live
// schema declares as number or integer, and ONLY when the whole string is a
// plain decimal. Anything else is left exactly as sent, so validateInput
// still refuses it. Pure and import-free so the offline suite loads it.
const PLAIN_DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;

export function coerceNumericStrings(
  input: Record<string, unknown>,
  schema: Record<string, unknown>
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    const type = properties[key]?.type;
    if (typeof value !== "string" || (type !== "number" && type !== "integer")) continue;
    const text = value.trim();
    if (!PLAIN_DECIMAL.test(text)) continue;
    if (type === "integer" && text.includes(".")) continue;
    out ??= { ...input };
    out[key] = Number(text);
  }
  return out ?? input;
}
