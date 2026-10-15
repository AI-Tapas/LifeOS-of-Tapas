// Translate the actual manifest contract without silently dropping unions or
// limits. Unsupported types fail startup rather than weaken client validation.
import { z } from "zod";
interface Node { type?: string | string[]; enum?: unknown[]; items?: Node; properties?: Record<string, Node>; required?: string[]; description?: string; additionalProperties?: boolean; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number }
function nodeToZod(node: Node): z.ZodTypeAny {
  let out: z.ZodTypeAny;
  if (Array.isArray(node.type)) {
    const variants = node.type.map(type => nodeToZod({ ...node, type }));
    out = variants.length === 1 ? variants[0] : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else {
    switch (node.type) {
      case "null": out = z.null(); break;
      case "string": {
        let text = z.string();
        if (node.minLength !== undefined) text = text.min(node.minLength);
        if (node.maxLength !== undefined) text = text.max(node.maxLength);
        out = text; break;
      }
      case "number": case "integer": {
        let number = node.type === "integer" ? z.number().int() : z.number();
        if (node.minimum !== undefined) number = number.min(node.minimum);
        if (node.maximum !== undefined) number = number.max(node.maximum);
        out = number; break;
      }
      case "boolean": out = z.boolean(); break;
      case "array": {
        let array = z.array(node.items ? nodeToZod(node.items) : z.unknown());
        if (node.minItems !== undefined) array = array.min(node.minItems);
        if (node.maxItems !== undefined) array = array.max(node.maxItems);
        out = array; break;
      }
      case "object": { const obj = z.object(shapeOf(node)); out = node.additionalProperties === false ? obj.strict() : obj.passthrough(); break; }
      case undefined: out = z.unknown(); break;
      default: throw new Error(`Unsupported JSON Schema type: ${node.type}`);
    }
    if (node.enum) { const values = node.enum; out = out.refine(value => values.includes(value), "Value is not in the allowed enumeration."); }
  }
  return node.description ? out.describe(node.description) : out;
}
function shapeOf(node: Node): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}; const required = new Set(node.required ?? []);
  for (const [key, child] of Object.entries(node.properties ?? {})) { const value = nodeToZod(child); shape[key] = required.has(key) ? value : value.optional(); }
  return shape;
}
export function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> { return shapeOf(schema as Node); }
