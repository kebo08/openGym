import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, serverOrigin } from '../opengym-client.mjs';

const SERVER = 'https://gym.example.com';
const initial = () => ({ unit: 'kg', _rev: 3, _wid: 'original', _ts: 100,
  routines: [{ id: 'r1', name: 'Session A', ex: [{ id: '0025', sets: 3, reps: 8 }] }],
  week: { 1: ['r1'] }, customEx: [{ id: 'unused', n: 'My own exercise', bp: 'back' }],
  workouts: [{ id: 'w1', d: '2026-10-20' }], bodyweight: [{ d: '2026-10-20', w: 80 }],
  exWeights: { '0025': { w: 20 } }, dayPlan: { '2026-10-23': ['r1'] }, theme: 'dark' });

function fixture() {
  const f = { state: initial(), put: null, conflict: false, calls: [] };
  f.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(url.startsWith(SERVER + '/api/'));
    f.calls.push({ url, options });
    let data;
    let status = 200;
    if (url.endsWith('/api/pair/redeem')) {
      assert.equal(options.headers.Authorization, undefined);
      data = { user: { id: 'u1' }, token: 'paired-token' };
    } else {
      assert.match(options.headers.Authorization, /^Bearer /);
      if (url.endsWith('/api/me')) data = { user: { id: 'u1' }, token: 'refreshed-token' };
      else if (options.method === 'PUT') {
        f.put = JSON.parse(options.body);
        if (f.conflict) { status = 409; data = { error: 'conflict', state: f.state, rev: f.state._rev }; }
        else { f.state = f.put.state; data = { ok: true, rev: f.state._rev + 1 }; }
      } else data = { state: structuredClone(f.state), rev: f.state._rev };
    }
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  f.client = createClient({ server: SERVER, token: 'old-token', fetchImpl: f.fetch });
  return f;
}

test('credentials can only be sent to an HTTPS origin; local HTTP is explicitly opt-in', () => {
  assert.equal(serverOrigin(SERVER + '/api/'), SERVER);
  for (const url of ['http://gym.example.com', 'https://user:password@gym.example.com', SERVER + '/another/page', SERVER + '/?token=secret']) {
    assert.throws(() => serverOrigin(url));
  }
  assert.throws(() => serverOrigin('http://localhost:3000'));
  assert.equal(serverOrigin('http://localhost:3000', { allowLocalHttp: true }), 'http://localhost:3000');
  assert.throws(() => serverOrigin('http://remote.example.com', { allowLocalHttp: true }));
});

test('pairing never forwards a previous bearer token and exports never contain credentials', async () => {
  const f = fixture();
  await f.client.pair('PAIRCODE');
  assert.equal(f.client.token, 'paired-token');
  const plan = await f.client.exportPlan();
  assert.equal(f.client.token, 'refreshed-token');
  const json = JSON.stringify(plan);
  for (const secret of ['old-token', 'paired-token', 'refreshed-token', 'workouts', 'bodyweight']) assert.ok(!json.includes(secret));
  assert.equal(plan.codex_source.server, SERVER);
});

test('a plan update preserves newer workout history, weigh-ins, settings and unused custom exercises', async () => {
  const f = fixture();
  const plan = await f.client.exportPlan();
  plan.routines[0].ex[0].reps = 10;
  f.state.workouts.push({ id: 'w2', d: '2026-10-23' });
  f.state.bodyweight.push({ d: '2026-10-23', w: 79.5 });
  f.state._rev = 4;
  f.state._wid = 'new-workout';
  const before = structuredClone(f.state);
  await f.client.applyPlan(plan);
  assert.equal(f.put.baseRev, 4);
  assert.equal(f.put.baseWid, 'new-workout');
  for (const key of ['workouts', 'bodyweight', 'exWeights', 'dayPlan', 'theme', 'customEx']) assert.deepEqual(f.put.state[key], before[key], key);
  assert.equal(f.put.state.routines[0].id, 'r1');
  assert.equal(f.put.state.routines[0].ex[0].reps, 10);
});

test('a changed remote plan or a different profile stops the update before any PUT', async () => {
  const f = fixture();
  const plan = await f.client.exportPlan();
  f.state.routines[0].name = 'Edited on phone';
  await assert.rejects(f.client.applyPlan(plan), /plan changed/);
  assert.equal(f.put, null);
  plan.codex_source.profile = 'someone-else';
  await assert.rejects(f.client.applyPlan(plan), /this server and profile/);
  assert.equal(f.put, null);
});

test('unknown exercises and broken schedules cannot silently drop part of a plan', async () => {
  const f = fixture();
  const plan = await f.client.exportPlan();
  plan.routines[0].ex.push({ id: 'not-in-catalogue', sets: 3, reps: 10 });
  await assert.rejects(f.client.applyPlan(plan), /unknown exercises/);
  plan.routines[0].ex.pop();
  plan.week = { 1: ['not-a-routine'] };
  await assert.rejects(f.client.applyPlan(plan), /weekly schedule/);
  assert.equal(f.put, null);
});

test('a concurrent server conflict is returned without an automatic overwriting retry', async () => {
  const f = fixture();
  const plan = await f.client.exportPlan();
  f.conflict = true;
  await assert.rejects(f.client.applyPlan(plan), e => e.status === 409);
  assert.equal(f.calls.filter(call => call.options.method === 'PUT').length, 1);
});
