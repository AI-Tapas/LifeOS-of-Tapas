// The app publishes its tool schemas as plain JSON Schema, which keeps one
// definition behind both the in-app assistant and this connector. The MCP SDK
// wants Zod, so convert at startup rather than maintaining a second copy that
// could drift from the registry the security gates are built around.
//
// Only the constructs the app actually emits are handled: one concrete type
// per parameter, optional parameters expressed by absence from `required`,
// enums, arrays and nested objects. Anything unrecognised degrades to
// z.unknown() rather than throwing, so a new field can never take the
// connector down.

import { z } from "zod";

interface JsonSchemaNode {
  type?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  description?: string;
}

function nodeToZod(node: JsonSchemaNode): z.ZodTypeAny {
  let out: z.ZodTypeAny;

  const values = (node.enum ?? []).filter(
    (v): v is string => typeof v === "string"
  );
  if (node.type === "string" && values.length) {
    out =
      values.length === 1
        ? z.literal(values[0])
        : z.enum(values as [string, string, ...string[]]);
  } else {
    switch (node.type) {
      case "string":
        out = z.string();
        break;
      case "integer":
        out = z.number().int();
        break;
      case "number":
        out = z.number();
        break;
      case "boolean":
        out = z.boolean();
        break;
      case "array":
        out = z.array(node.items ? nodeToZod(node.items) : z.unknown());
        break;
      case "object":
        out = z.object(shapeOf(node));
        break;
      default:
        out = z.unknown();
    }
  }

  return node.description ? out.describe(node.description) : out;
}

function shapeOf(node: JsonSchemaNode): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const zod = nodeToZod(child);
    shape[key] = required.has(key) ? zod : zod.optional();
  }
  return shape;
}

// The SDK takes the top level as a raw shape (a map of field to Zod type),
// not as a wrapped object.
export function jsonSchemaToZodShape(
  schema: Record<string, unknown>
): Record<string, z.ZodTypeAny> {
  return shapeOf(schema as JsonSchemaNode);
}
