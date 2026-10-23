import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, serverOrigin } from '../opengym-client.mjs';
import { stampPut } from '../../api/sync-stamps.js';
import { stampChange, mergeStates } from '../../frontend/src/lib/sync-merge.js';
import { canonicalExId } from '../../frontend/src/lib/exercises.js';

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
        else {
          const before = f.state;
          f.state = f.put.state;
          const report = {};
          if (f.serverStamps) stampPut(before, f.state, {
            overRead: f.put.baseRev === before._rev, stamped: f.put.stamped === true, report
          });
          const rev = before._rev + 1;
          if (f.serverStamps) f.state._rev = rev + (report.changed ? 1 : 0);
          data = { ok: true, rev };
        }
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

test('a previously edited routine can return to an earlier prescription and survives a newer offline phone workout', async () => {
  const f = fixture();
  f.serverStamps = true;
  const before = initial();
  before.edited = { 'week.1': 100 };
  before.routines[0].ex[0].id = canonicalExId(before.routines[0].ex[0].id);
  before.routines[0]._ts = 100;
  before.routines[0]._f = { ex: 100, displayMeta: 100 };
  before.routines[0].displayMeta = { color: 'blue', source: 'phone' };
  const current = structuredClone(before);
  current.routines[0].ex[0].reps = 12;
  current._ts = stampChange(before, current, 200);
  stampPut(before, current, { overRead: true, stamped: true, now: 200 });
  f.state = current;
  const stalePhone = structuredClone(current);
  const plan = await f.client.exportPlan();
  plan.routines[0].ex[0].reps = 8; // an intentional return to the previous value
  await f.client.applyPlan(plan);
  assert.equal(f.put.stamped, true);
  assert.equal(f.state.routines[0].ex[0].reps, 8, 'legacy repair must not silently restore the old 12-rep prescription');
  assert.ok(f.state.routines[0]._f.ex > current.routines[0]._f.ex);
  assert.deepEqual(f.state.routines[0].displayMeta, before.routines[0].displayMeta, 'app-only metadata stays on the same routine');
  assert.equal(f.state.routines[0]._f.displayMeta, 100, 'unchanged metadata keeps its field stamp');

  // The disconnected phone's global timestamp is now newer, but its routine field
  // is older. The actual APK merge must keep both the plan edit and the new workout.
  const later = f.state._ts + 1000;
  stalePhone.workouts.push({ id: 'offline-workout', d: '2026-10-24', _ts: later, entries: [] });
  stalePhone._ts = stampChange(current, stalePhone, later);
  const merged = mergeStates(stalePhone, f.state);
  assert.equal(merged.routines.find(r => r.id === 'r1').ex[0].reps, 8);
  assert.ok(merged.workouts.some(w => w.id === 'offline-workout'));
  assert.ok(merged.workouts.some(w => w.id === 'w1'));
});

test('routine removals and replacement weekdays stay removed when a stale phone reconnects', async () => {
  const f = fixture();
  f.serverStamps = true;
  f.state.edited = { 'week.1': 100, 'week.2': 100 };
  f.state.routines.push({ id: 'obsolete', name: 'Old session', _ts: 100,
    ex: [{ id: canonicalExId('0025'), sets: 2, reps: 10 }] });
  f.state.week[2] = ['obsolete'];
  const stalePhone = structuredClone(f.state);
  const plan = await f.client.exportPlan();
  plan.routines = plan.routines.filter(r => r.id !== 'obsolete');
  plan.week = { 1: ['r1'], 4: ['r1'] };
  await f.client.applyPlan(plan);
  assert.ok(f.state.deleted.routines.obsolete > 100, 'removal has its own tombstone');
  assert.ok(f.state.edited['week.2'] > 100, 'clearing a weekday is stamped');
  assert.ok(f.state.edited['week.4'] > 100, 'the new weekday is stamped');
  stalePhone._ts = f.state._ts + 1000;
  const merged = mergeStates(stalePhone, f.state);
  assert.equal(merged.routines.some(r => r.id === 'obsolete'), false);
  assert.equal(merged.week[2], undefined);
  assert.deepEqual(merged.week[4], ['r1']);
});
