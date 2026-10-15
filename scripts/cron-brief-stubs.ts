// Offline fixtures for the real brief route. All addresses and results synthetic.
import { fakeSupabase, resetState, state } from './b24-stubs.ts';
export { state };
export const briefState = { sends: 0, sendError: false, readError: false, connected: true };
export function resetBrief() {
  resetState();
  Object.assign(briefState, { sends: 0, sendError: false, readError: false, connected: true });
}
class Query {
  private table: string;
  constructor(table: string) { this.table = table; }
  select() { return this; } eq() { return this; } in() { return this; }
  lte() { return this; } gte() { return this; } or() { return this; }
  order() { return this; } not() { return this; } insert() { return this; }
  maybeSingle() { return this; } single() { return this; }
  then(resolve: (result: unknown) => unknown) {
    const data = this.table === 'accounts' ? { id: 'synthetic', email: 'owner@example.test',
      status: briefState.connected ? 'connected' : 'needs_reauth', connect_mode: 'direct' } : [];
    // Account list queries need arrays; only maybeSingle should return an object.
    return Promise.resolve({ data, count: 0, error: this.table === 'tasks' && briefState.readError ? { message: 'Injected read failure' } : null }).then(resolve);
  }
}
const supabase = { ...fakeSupabase, from(table: string) {
  if (table !== 'accounts') return new Query(table);
  let single = false;
  const query = new Query(table);
  query.maybeSingle = () => { single = true; return query; };
  const original = query.then.bind(query);
  query.then = (resolve) => original((result) => {
    const r = result as {data: unknown};
    return resolve({ ...(result as object), data: single ? r.data : [] });
  });
  return query;
} };
export async function serviceActor() { return { supabase, userId: 'user-1', origin: 'service', job: 'cron_brief' }; }
export async function sendBriefEmail() {
  briefState.sends++;
  if (briefState.sendError) throw new Error('Synthetic provider response lost');
  return { provider_message_id: 'synthetic-message' };
}
export function composeBrief() { return { subject: 'Synthetic', html: '<p>Synthetic</p>', text: 'Synthetic' }; }
export function staleTripStepIds() { return []; }
export function lapsedLine() { return null; }
export async function sweepLapsed() { return { tasks: [] }; }
export function ticketBriefLine() { return null; }
export function cabBriefLine() { return null; }
export const SCAN_HEALTH_ACTIONS = [];
export function scanHealthWarning() { return null; }
export async function keepBrief() {}
export function briefStoreFor() { return {}; }
export function briefNotSentAlert() { return {}; }
export function scanFailedAlert() { return {}; }
export async function sendPushQuietly() {}
export async function loadTripSteps() { return []; }
export async function setTaskStatus() { return { ok: true }; }
export async function syncFamilyTravel() {}
export async function syncAllEvents() {}
export function overlapsFrom() { return ''; }
export async function loadUnbilled() { return []; }
export function summarise() { return null; }
export async function loadLastWeekHours() { return null; }
