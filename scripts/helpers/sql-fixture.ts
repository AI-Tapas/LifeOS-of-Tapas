// Isolated PostgreSQL engine fixture. Real migrations/policies/transactions;
// synthetic Supabase auth claims and Vault stubs. This does not validate Auth,
// Vault encryption, PostgREST, or multi-connection production lock scheduling.
import type { PGlite } from "@electric-sql/pglite";
const { PGlite: PGliteEngine } = await import(process.env.PGLITE_MODULE_PATH ?? "@electric-sql/pglite") as typeof import("@electric-sql/pglite");
import { readdirSync, readFileSync } from "node:fs";
export async function sqlFixture(options: { through?: string } = {}) {
  const db = new PGliteEngine();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key, email text);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create schema vault; create table vault.secrets(id uuid primary key, secret text);
    create view vault.decrypted_secrets as select id, secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(text,text) returns uuid language sql as $$ select gen_random_uuid() $$;
    create function vault.update_secret(uuid,text) returns void language sql as $$ select $$;
  `);
  const directory = new URL("../../supabase/migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql") && (!options.through || file <= options.through)).sort();
  try {
    for (const file of migrations) {
      const sql = readFileSync(new URL(file, directory), "utf8").replace("create extension if not exists supabase_vault with schema vault;", "-- Vault fixture supplied by SQL test helper.");
      try { await db.exec(sql); } catch (error) { throw new Error(`Migration ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { db, migrations };
  } catch (error) { await db.close(); throw error; }
}
export async function sqlRole(db: PGlite, role: "anon" | "authenticated" | "service_role", userId?: string) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, ...(userId ? { sub: userId } : {}) })]);
  await db.exec(`set role ${role}`);
}
