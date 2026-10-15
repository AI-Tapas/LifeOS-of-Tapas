import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefState, resetBrief, state } from './cron-brief-stubs.ts';
register('./cron-brief-loader.mjs', import.meta.url);
const { GET } = await import('../app/api/cron/brief/route.ts');
process.env.CRON_SECRET = 'synthetic-secret-at-least-24-characters';
const request = () => new Request('https://example.test/api/cron/brief', {
  headers:{authorization:`Bearer ${process.env.CRON_SECRET}`},
});
test('concurrent brief calls dispatch once and retain run identity', async () => {
  resetBrief();
  const responses = await Promise.all([GET(request()),GET(request())]);
  const bodies = await Promise.all(responses.map(r=>r.json()));
  assert.equal(briefState.sends,1);
  assert.equal(bodies.filter(r=>r.sent).length,1);
  assert.equal(bodies.filter(r=>r.skipped).length,1);
  assert.equal(bodies[0].run_id,bodies[1].run_id);
  await GET(request());
  assert.equal(briefState.sends,1);
});
test('known brief read failure can retry immediately without a previous send', async () => {
  resetBrief(); briefState.readError = true;
  const first = await (await GET(request())).json();
  assert.equal(first.state,'failed'); assert.equal(first.retryable,true); assert.equal(briefState.sends,0);
  briefState.readError = false;
  const second = await (await GET(request())).json();
  assert.equal(second.sent,true); assert.equal(briefState.sends,1); assert.notEqual(first.run_id,second.run_id);
});
test('lost provider response is uncertain and cannot send again', async () => {
  resetBrief(); briefState.sendError = true;
  const failed = await (await GET(request())).json();
  assert.equal(failed.state,'uncertain'); assert.equal(failed.retryable,false);
  briefState.sendError = false;
  const retry = await (await GET(request())).json();
  assert.equal(retry.skipped,true); assert.equal(retry.state,'uncertain'); assert.equal(briefState.sends,1);
});
test('failure saving successful delivery remains uncertain and blocks another send', async () => {
  resetBrief(); state.cronRpcError = 'finish_cron_run';
  const response = await GET(request());
  assert.equal(response.status,503); assert.equal((await response.json()).state,'uncertain');
  state.cronRpcError = null;
  assert.equal((await (await GET(request())).json()).skipped,true);
  assert.equal(briefState.sends,1);
});
test('failure reserving dispatch sends nothing and permits known safe retry', async () => {
  resetBrief(); state.cronRpcError = 'mark_cron_dispatch';
  const failed = await (await GET(request())).json();
  assert.equal(failed.state,'failed'); assert.equal(briefState.sends,0);
  state.cronRpcError = null;
  assert.equal((await (await GET(request())).json()).sent,true);
  assert.equal(briefState.sends,1);
});
