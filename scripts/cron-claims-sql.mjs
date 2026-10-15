// Optional isolated PostgreSQL regression proof. No app credentials/network.
// node scripts/cron-claims-sql.mjs (optional PGLITE_MODULE overrides the installed dev dependency)
// Uses minimal synthetic auth/audit fixtures, not a complete Supabase stack.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const modulePath = process.env.PGLITE_MODULE;
const { PGlite } = modulePath ? await import(pathToFileURL(modulePath).href) : await import('@electric-sql/pglite');
const db = new PGlite();
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
  create role anon; create role authenticated; create role service_role bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  create table public.audit_log(id uuid default gen_random_uuid(), user_id uuid, actor text, action text,
    entity text, ts timestamptz default now(), meta jsonb);
  insert into auth.users values ('${owner}'), ('${other}');
  insert into public.audit_log(user_id, actor, action, entity, meta)
    values ('${owner}', 'assistant', 'cron_brief', 'cron', '{"ist_date":"2026-10-14"}');
`);
await db.exec(await readFile(new URL('../supabase/migrations/20261015000400_cron_claims.sql', import.meta.url), 'utf8'));
const call = async (name, args) => (await db.query(`select public.${name}(${args.map((_,i) => '$'+(i+1)).join(',')}) as value`, args)).rows[0].value;
await db.exec('set role service_role');
const legacy = await call('claim_cron_run', [owner, 'brief', '2026-10-14']);
assert.equal(legacy.claimed, false); assert.equal(legacy.status, 'succeeded');
const claims = await Promise.all([call('claim_cron_run', [owner, 'scan', '2026-10-15']), call('claim_cron_run', [owner, 'scan', '2026-10-15'])]);
assert.equal(claims.filter(c=>c.claimed).length, 1);
const first = claims.find(c=>c.claimed);
assert.equal(await call('finish_cron_run', [owner,'scan','2026-10-15',first.run_id,'failed',{}]), true);
const retry = await call('claim_cron_run', [owner, 'scan', '2026-10-15']);
assert.equal(retry.claimed, true); assert.notEqual(retry.run_id, first.run_id);
assert.equal(await call('finish_cron_run', [owner,'scan','2026-10-15',first.run_id,'succeeded',{}]), false, 'stale attempt must not finish new work');
assert.equal(await call('finish_cron_run', [other,'scan','2026-10-15',retry.run_id,'succeeded',{}]), false, 'owner key is part of fence');
assert.equal(await call('finish_cron_run', [owner,'scan','2026-10-15',retry.run_id,'succeeded',{}]), true);
assert.equal((await call('claim_cron_run', [owner,'scan','2026-10-15'])).claimed, false);
const brief = await call('claim_cron_run', [owner,'brief','2026-10-15']);
assert.equal(await call('mark_cron_dispatch', [owner,'brief','2026-10-15',brief.run_id]), true);
assert.equal((await call('claim_cron_run', [owner,'brief','2026-10-15'])).status, 'uncertain');
assert.equal(await call('finish_cron_run', [owner,'brief','2026-10-15',brief.run_id,'failed',{}]), false, 'dispatch uncertainty cannot be downgraded to retryable failure');
assert.equal(await call('mark_cron_dispatch', [owner,'brief','2026-10-15',brief.run_id]), false, 'cannot reserve provider send twice');
assert.equal(await call('finish_cron_run', [owner,'brief','2026-10-15',brief.run_id,'succeeded',{provider_message_id:'synthetic'}]), true);
await call('claim_cron_run', [owner,'scan','2026-10-16']);
await db.exec(`reset role; update public.cron_runs set started_at=now()-interval '11 minutes' where ist_date='2026-10-16'; set role service_role;`);
const expired = await call('claim_cron_run', [owner,'scan','2026-10-16']);
assert.equal(expired.claimed, false); assert.equal(expired.status, 'uncertain');
await assert.rejects(db.exec(`update public.cron_runs set status='failed'`), /permission denied/);
await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub','${other}',false)`);
assert.equal((await db.query('select * from public.cron_runs')).rows.length, 0);
await assert.rejects(call('claim_cron_run',[owner,'scan','2026-10-15']), /permission denied/);
await db.exec(`reset role; set role anon`);
await assert.rejects(db.query('select * from public.cron_runs'), /permission denied/);
await assert.rejects(call('claim_cron_run',[owner,'scan','2026-10-15']), /permission denied/);
await db.exec(`reset role`);
const audit = (await db.query(`select meta from public.audit_log where meta->>'ist_date'='2026-10-15'`)).rows;
assert.ok(audit.length >= 6); assert.ok(audit.every(r => typeof r.meta.run_id === 'string'));
console.log('PASS: migration/backfill, single claim, failed retry, fence, success dedupe, write-ahead dispatch, uncertainty, expired claims, RLS/privileges, audit run IDs.');
console.log((await db.query('select version()')).rows[0].version);
await db.close();
