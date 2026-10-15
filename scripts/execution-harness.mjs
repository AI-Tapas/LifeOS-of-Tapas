// Actual TS module bodies under a VM; only imports/DB/network are replaced.
// Synthetic query harness, not a PostgreSQL/RLS implementation.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function load(relative, bindings = {}) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  const stripped = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,
    ast.statements.filter((node) => !ts.isImportDeclaration(node))));
  // Reparse after stripping imports so TypeScript cannot rewrite names to the
  // removed import aliases. Inject only explicit boundary bindings below.
  const compiled = ts.transpileModule(stripped, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {
    exports: {}, console, Buffer, URL, URLSearchParams, Request, Response,
    Headers, FormData, AbortSignal, TextEncoder, TextDecoder, structuredClone,
    process: { env: {} }, setTimeout, clearTimeout, ...bindings,
  };
  vm.createContext(context);
  vm.runInContext(compiled, context, { filename: relative });
  return context.exports;
}

export function database(initial = {}) {
  const tables = structuredClone(initial), calls = [];
  let next = 1;
  const db = {
    tables, calls, fail: null, before: null,
    from(table) {
      const filters = [];
      let op = "select", payload;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push((row) => row[key] === value); return query; },
        is(key, value) { filters.push((row) => (row[key] ?? null) === value); return query; },
        in(key, values) { filters.push((row) => values.includes(row[key])); return query; },
        limit() { return query; }, order() { return query; },
        insert(value) { op = "insert"; payload = value; return query; },
        upsert(value) { op = "upsert"; payload = value; return query; },
        update(value) { op = "update"; payload = value; return query; },
        delete() { op = "delete"; return query; },
        single() { return run(true); }, maybeSingle() { return run("maybe"); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
      async function run(single) {
        await db.before?.({ table, op, payload });
        calls.push({ table, op, payload });
        if (db.fail?.(table, op, payload)) return { data: null, error: { message: "Injected database failure" } };
        const rows = tables[table] ?? (tables[table] = []);
        let result = rows.filter((row) => filters.every((filter) => filter(row)));
        if (op === "upsert") {
          const existing = rows.find((row) => row.ext_event_id === payload.ext_event_id);
          if (existing) {
            Object.assign(existing, structuredClone(payload)); result = [existing];
          } else {
            result = [{ id: `new-${next++}`, ...structuredClone(payload) }]; rows.push(...result);
          }
        } else if (op === "insert") {
          result = (Array.isArray(payload) ? payload : [payload]).map((value) => ({ id: `new-${next++}`, ...structuredClone(value) }));
          rows.push(...result);
        } else if (op === "update") {
          result.forEach((row) => Object.assign(row, structuredClone(payload)));
        } else if (op === "delete") {
          tables[table] = rows.filter((row) => !result.includes(row));
        }
        if (single === true && result.length !== 1) return { data: null, error: { message: "Expected exactly one row" } };
        return { data: structuredClone(single ? (result[0] ?? null) : result), error: null };
      }
      return query;
    },
  };
  return db;
}
