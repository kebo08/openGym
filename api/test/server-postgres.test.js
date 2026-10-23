/* Opt-in integration coverage for the real PostgreSQL backend and unchanged mobile API.
 *
 * TEST_DATABASE_URL must name a disposable database whose user may create schemas.
 * Every test owns a random schema; no existing application tables are used or removed.
 * Example: TEST_DATABASE_URL=postgresql://... node --test test/server-postgres.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { Pool } = DATABASE_URL ? await import('pg') : {};
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:8080';
const NATIVE_ORIGIN = 'https://localhost';
const enabled = { skip: !DATABASE_URL && 'set TEST_DATABASE_URL to a disposable PostgreSQL database', timeout: 90000 };
const quote = name => '"' + name.replaceAll('"', '""') + '"';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
}

async function fixture(t) {
  const schema = 'opengym_test_' + crypto.randomBytes(10).toString('hex');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2, connectionTimeoutMillis: 5000 });
  const children = [];
  const directories = [];
  await pool.query(`CREATE SCHEMA ${quote(schema)}`);
  t.after(async () => {
    for (const child of children) await stop(child);
    try { await pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`); }
    finally {
      await pool.end();
      for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const start = async (connectionString = DATABASE_URL, env = {}) => {
    // A second process gets a genuinely empty ephemeral directory. It must recover the
    // profile, signing key and state from PostgreSQL rather than an old local cache.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-postgres-'));
    directories.push(dataDir);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost',
        DATABASE_URL: connectionString, OPENGYM_DATABASE_SCHEMA: schema,
        MEDIA_UPLOADS: '0', COACH_DISABLED: '1', PASSWORD_LOGIN: '1',
        FIRST_USER_ADMIN: '1', INVITE_ONLY: '', ADMIN_UIDS: '', AUDIT_LOG: '1', ...env
      }
    });
    children.push(child);
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
    const request = async (method, route, { body, cookie, token, origin = ORIGIN } = {}) => {
      const response = await fetch(base + route, {
        method,
        headers: {
          Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      const setCookie = response.headers.getSetCookie().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
      return {
        status: response.status, body: await response.json(), headers: response.headers,
        cookie: setCookie ? setCookie.split(';')[0] : null
      };
    };
    return { child, base, request, stop: () => stop(child) };
  };

  const account = async server => {
    const registered = await server.request('POST', '/api/register/password', {
      body: { name: 'Integration owner', password: 'correct horse battery staple' }
    });
    assert.equal(registered.status, 200, 'normal account registration succeeds');
    assert.ok(registered.cookie, 'registration returns a browser session');
    const paired = await server.request('POST', '/api/pair/create', { cookie: registered.cookie, body: {} });
    assert.equal(paired.status, 200);
    const redeemed = await server.request('POST', '/api/pair/redeem', {
      origin: NATIVE_ORIGIN, body: { code: paired.body.code }
    });
    assert.equal(redeemed.status, 200);
    assert.equal(typeof redeemed.body.token, 'string');
    assert.equal(redeemed.body.user.id, registered.body.user.id);
    assert.equal(redeemed.headers.get('access-control-allow-origin'), NATIVE_ORIGIN);
    assert.equal(redeemed.headers.get('access-control-allow-credentials'), null);
    const reused = await server.request('POST', '/api/pair/redeem', {
      origin: NATIVE_ORIGIN, body: { code: paired.body.code }
    });
    assert.equal(reused.status, 400, 'pairing code stays one-use');
    return { uid: registered.body.user.id, token: redeemed.body.token, cookie: registered.cookie };
  };

  const stored = async uid => {
    const result = await pool.query(`SELECT state, rev FROM ${quote(schema)}.opengym_states WHERE uid=$1`, [uid]);
    return result.rows[0];
  };
  return { schema, pool, start, account, stored };
}

const state = (name = 'original') => ({
  _ts: Date.now(), unit: 'kg', routines: [{ id: 'r1', name, ex: [{ id: '0001', sets: 3, reps: 8 }] }],
  week: { 1: 'r1' }, customEx: [], dayPlan: {}, bodyweight: [{ d: '2026-10-01', w: 75 }],
  workouts: [{ id: 'w1', d: '2026-10-01', entries: [] }], active: { id: 'device-local' }
});
const mobile = token => ({ token, origin: NATIVE_ORIGIN });

test('PostgreSQL: paired bearer, profile, secret and training state survive an empty-directory restart', enabled, async t => {
  const f = await fixture(t);
  const first = await f.start();
  const user = await f.account(first);
  const initial = await first.request('GET', '/api/data', mobile(user.token));
  assert.deepEqual(initial.body, { state: null, rev: 0 });
  const saved = await first.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state(), baseRev: 0 }
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.rev, 1);
  assert.equal(typeof saved.body.wid, 'string');
  const committed = await f.stored(user.uid);
  assert.equal(Number(committed.rev), 1, 'another database connection sees the write before its 200 is received');
  assert.equal(committed.state._rev, 1);
  assert.equal('active' in committed.state, false, 'active workout remains device-local');
  const before = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  assert.equal(typeof before.secret, 'string');
  assert.ok(before.vapid?.publicKey);

  await first.stop();
  const restarted = await f.start();
  const me = await restarted.request('GET', '/api/me', mobile(user.token));
  assert.equal(me.status, 200, 'existing paired token still verifies after cold start');
  assert.equal(me.body.user.id, user.uid);
  const read = await restarted.request('GET', '/api/data', mobile(user.token));
  assert.equal(read.status, 200);
  assert.equal(read.body.rev, 1);
  assert.equal(read.body.state.routines[0].name, 'original');
  assert.deepEqual(read.body.state.workouts.map(w => w.id), ['w1']);
  assert.deepEqual(read.body.state.bodyweight.map(({ d, w }) => ({ d, w })), [{ d: '2026-10-01', w: 75 }]);
  const revision = await restarted.request('GET', '/api/data/rev', mobile(user.token));
  assert.deepEqual(revision.body, { rev: 1, wid: saved.body.wid });
  const after = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  assert.equal(after.secret, before.secret, 'signing material is durable');
  assert.deepEqual(after.vapid, before.vapid, 'push keys do not rotate on cold start');

  // Exercise the real Codex client as well as the phone's API contract. A workout
  // logged after the plan export must survive the later plan-only change.
  const { createClient } = await import('../../scripts/opengym-client.mjs');
  const codex = createClient({ server: restarted.base, allowLocalHttp: true });
  const pairing = await restarted.request('POST', '/api/pair/create', { cookie: user.cookie, body: {} });
  assert.equal(pairing.status, 200);
  assert.equal((await codex.pair(pairing.body.code)).id, user.uid);
  const plan = await codex.exportPlan();
  assert.equal(JSON.stringify(plan).includes(codex.token), false, 'the exported plan has no paired credential');
  plan.routines[0].ex[0].reps = 12;
  const phone = (await restarted.request('GET', '/api/data', mobile(user.token))).body;
  phone.state.workouts.push({ id: 'w2', d: '2026-10-02', entries: [] });
  phone.state.bodyweight.push({ d: '2026-10-02', w: 74.5 });
  const logged = await restarted.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: phone.state, baseRev: phone.rev, baseWid: phone.state._wid }
  });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.rev, 2);
  assert.equal((await codex.applyPlan(plan)).revision, 3);
  const updated = (await restarted.request('GET', '/api/data', mobile(user.token))).body;
  assert.equal(updated.rev, 3);
  assert.equal(updated.state.routines[0].ex[0].reps, 12);
  assert.deepEqual(updated.state.workouts.map(w => w.id), ['w1', 'w2']);
  assert.deepEqual(updated.state.bodyweight.map(({ d, w }) => ({ d, w })),
    [{ d: '2026-10-01', w: 75 }, { d: '2026-10-02', w: 74.5 }]);
  const durableUpdate = await f.stored(user.uid);
  assert.equal(Number(durableUpdate.rev), 3);
  assert.equal(durableUpdate.state.routines[0].ex[0].reps, 12);
  assert.deepEqual(durableUpdate.state.workouts.map(w => w.id), ['w1', 'w2']);

  assert.equal((await restarted.request('POST', '/api/logout/all', { ...mobile(user.token), body: {} })).status, 200);
  const third = await f.start();
  assert.equal((await third.request('GET', '/api/me', mobile(user.token))).status, 401,
    'session revocation is durable and visible to an independent process');
  assert.equal((await third.request('GET', '/api/me', mobile(codex.token))).status, 401,
    'the separately paired Codex session is revoked too');
});

test('PostgreSQL: bootstrap invitation is normalized, one-use and never reseeded on restart', enabled, async t => {
  const f = await fixture(t);
  const bootstrap = crypto.randomBytes(32).toString('hex');
  const code = bootstrap.slice(0, 32);
  const first = await f.start(DATABASE_URL, {
    OPENGYM_BOOTSTRAP_INVITE: bootstrap, INVITE_ONLY: '1', FIRST_USER_ADMIN: '1'
  });
  const signup = (server, name, invitation) => server.request('POST', '/api/register/password', {
    body: { name, password: 'correct horse battery staple', ...(invitation === undefined ? {} : { code: invitation }) }
  });
  assert.equal((await signup(first, 'No code')).status, 403);
  assert.equal((await signup(first, 'Wrong code', 'not-an-invitation')).status, 403);
  assert.equal((await signup(first, 'Full generated value', bootstrap)).status, 403,
    'a long generated value is not the short invitation shown to the owner');
  const owner = await signup(first, 'Bootstrap owner', code);
  assert.equal(owner.status, 200, 'lowercase first 32 characters fit the client input and are accepted');
  assert.equal(owner.body.user.admin, true);
  assert.equal(owner.body.user.owner, true);
  assert.equal((await signup(first, 'Second person', code)).status, 403, 'bootstrap invitation is one-use');
  const initial = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  assert.equal(initial.db.users.length, 1);
  assert.equal(initial.db.invites.length, 1);
  assert.equal(initial.db.invites[0].code, code.toUpperCase());
  assert.equal(initial.db.invites[0].usedBy, owner.body.user.id);

  await first.stop();
  const changedBootstrap = crypto.randomBytes(32).toString('hex');
  const restarted = await f.start(DATABASE_URL, {
    OPENGYM_BOOTSTRAP_INVITE: changedBootstrap, INVITE_ONLY: '1', FIRST_USER_ADMIN: '1'
  });
  assert.equal((await signup(restarted, 'Reseed attempt', changedBootstrap.slice(0, 32))).status, 403);
  assert.equal((await signup(restarted, 'Reuse after restart', code)).status, 403);
  const me = await restarted.request('GET', '/api/me', { cookie: owner.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, owner.body.user.id);
  assert.equal(me.body.user.owner, true);
  const persisted = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  assert.equal(persisted.db.users.length, 1);
  assert.deepEqual(persisted.db.invites, initial.db.invites, 'a changed environment never resets durable invitations');
});

test('PostgreSQL: two server processes serialize conditional writes and preserve write-id ancestry', enabled, async t => {
  const f = await fixture(t);
  const a = await f.start();
  const user = await f.account(a);
  const b = await f.start();
  const write = (server, name, extra = {}) => server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state(name), baseRev: 0, ...extra }
  });
  const results = await Promise.all([write(a, 'phone'), write(b, 'Codex')]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409], 'only one write may consume revision zero');
  const winner = results.find(r => r.status === 200);
  const loser = results.find(r => r.status === 409);
  assert.equal(winner.body.rev, 1);
  assert.equal(loser.body.rev, 1);
  assert.equal(loser.body.state._wid, winner.body.wid);
  assert.equal(Number((await f.stored(user.uid)).rev), 1);

  const stale = await write(a, 'stale write id', { baseRev: 1, baseWid: 'not-the-current-write' });
  assert.equal(stale.status, 409, 'a correct revision does not excuse a stale write id');
  const next = await write(b, 'accepted update', { baseRev: 1, baseWid: winner.body.wid });
  assert.equal(next.status, 200);
  assert.equal(next.body.rev, 2);
  const persisted = await f.stored(user.uid);
  assert.deepEqual(persisted.state._wids, [winner.body.wid]);
  assert.equal(persisted.state._wid, next.body.wid);
  assert.equal(persisted.state.routines[0].name, 'accepted update');
  const seen = await a.request('GET', '/api/data/rev', mobile(user.token));
  assert.deepEqual(seen.body, { rev: 2, wid: next.body.wid }, 'the other process reads authoritative revision data');
});

test('PostgreSQL: failure at COMMIT returns no success and rolls back state and account authority', enabled, async t => {
  const f = await fixture(t);
  const server = await f.start();
  const user = await f.account(server);
  const put = (name, baseRev = 0) => server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state(name), baseRev }
  });
  const original = await put('before failure');
  assert.equal(original.status, 200);

  // A deferred constraint fails at COMMIT, after the handler has prepared its normal
  // success response. A response sent before commit would therefore fail this test.
  await f.pool.query(`CREATE FUNCTION ${quote(f.schema)}.reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'integration-test commit failure'; END $$`);
  await f.pool.query(`CREATE CONSTRAINT TRIGGER reject_state_commit AFTER INSERT OR UPDATE
    ON ${quote(f.schema)}.opengym_states DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ${quote(f.schema)}.reject_commit()`);
  const refused = await put('must never be acknowledged', 1);
  assert.equal(refused.status, 503);
  assert.notEqual(refused.body.ok, true);
  assert.equal(Number((await f.stored(user.uid)).rev), 1);
  assert.equal((await f.stored(user.uid)).state.routines[0].name, 'before failure');
  await f.pool.query(`DROP TRIGGER reject_state_commit ON ${quote(f.schema)}.opengym_states`);
  const intact = await server.request('GET', '/api/data', mobile(user.token));
  assert.equal(intact.status, 200);
  assert.equal(intact.body.rev, 1);
  assert.equal(intact.body.state.routines[0].name, 'before failure', 'rolled-back working state is not exposed');

  await f.pool.query(`CREATE CONSTRAINT TRIGGER reject_account_commit AFTER UPDATE
    ON ${quote(f.schema)}.opengym_instance DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.data IS DISTINCT FROM NEW.data)
    EXECUTE FUNCTION ${quote(f.schema)}.reject_commit()`);
  const logout = await server.request('POST', '/api/logout/all', { ...mobile(user.token), body: {} });
  assert.equal(logout.status, 503, 'session-version mutation is not acknowledged before commit');
  await f.pool.query(`DROP TRIGGER reject_account_commit ON ${quote(f.schema)}.opengym_instance`);
  assert.equal((await server.request('GET', '/api/me', mobile(user.token))).status, 200,
    'failed revocation must not remain authoritative in process memory');
  const accepted = await put('after recovery', 1);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.rev, 2);

  await f.pool.query(`CREATE CONSTRAINT TRIGGER reject_health_commit AFTER UPDATE
    ON ${quote(f.schema)}.opengym_instance DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION ${quote(f.schema)}.reject_commit()`);
  const unwritable = await server.request('GET', '/api/health');
  assert.equal(unwritable.status, 503, 'health must prove write/commit ability rather than only SELECT access');
  await f.pool.query(`DROP TRIGGER reject_health_commit ON ${quote(f.schema)}.opengym_instance`);
  const healthy = await server.request('GET', '/api/health');
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.writable, true);
});

test('PostgreSQL: an unavailable optional audit table does not prevent account or training operations', enabled, async t => {
  const f = await fixture(t);
  const server = await f.start();
  const user = await f.account(server);
  assert.equal((await server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state('before audit outage'), baseRev: 0 }
  })).status, 200);
  await f.pool.query(`ALTER TABLE ${quote(f.schema)}.opengym_audit RENAME TO opengym_audit_unavailable`);
  try {
    // Password login appends an audit record, exercising both the read and write
    // savepoints while the optional relation cannot be reached.
    const login = await server.request('POST', '/api/login/password', {
      body: { name: 'Integration owner', password: 'correct horse battery staple' }
    });
    assert.equal(login.status, 200);
    assert.ok(login.cookie);
    const saved = await server.request('PUT', '/api/data', {
      ...mobile(user.token), body: { state: state('during audit outage'), baseRev: 1 }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.rev, 2);
    const read = await server.request('GET', '/api/data', mobile(user.token));
    assert.equal(read.status, 200);
    assert.equal(read.body.state.routines[0].name, 'during audit outage');
    assert.equal(Number((await f.stored(user.uid)).rev), 2);
  } finally {
    await f.pool.query(`ALTER TABLE ${quote(f.schema)}.opengym_audit_unavailable RENAME TO opengym_audit`);
  }
});

test('PostgreSQL: missing authoritative rows or tables never regenerate an empty replacement instance', enabled, async t => {
  const f = await fixture(t);
  const server = await f.start();
  const user = await f.account(server);
  assert.equal((await server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state('must be recoverable'), baseRev: 0 }
  })).status, 200);
  const instance = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  await server.stop();

  await f.pool.query(`DELETE FROM ${quote(f.schema)}.opengym_instance WHERE id=1`);
  await assert.rejects(f.start(), /refusing to start without authoritative storage/);
  assert.equal((await f.pool.query(`SELECT count(*) AS n FROM ${quote(f.schema)}.opengym_instance`)).rows[0].n, '0');
  assert.equal((await f.stored(user.uid)).state.routines[0].name, 'must be recoverable');
  await f.pool.query(`INSERT INTO ${quote(f.schema)}.opengym_instance (id,data) VALUES (1,$1::jsonb)`, [JSON.stringify(instance)]);

  await f.pool.query(`DROP TABLE ${quote(f.schema)}.opengym_states`);
  await assert.rejects(f.start(), /refusing to start without authoritative storage/);
  const relation = await f.pool.query('SELECT to_regclass($1) AS name', [`${f.schema}.opengym_states`]);
  assert.equal(relation.rows[0].name, null, 'startup does not recreate the missing authoritative state table');
  const intact = (await f.pool.query(`SELECT data FROM ${quote(f.schema)}.opengym_instance WHERE id=1`)).rows[0].data;
  assert.equal(intact.secret, instance.secret);
  assert.equal(intact.db.users[0].id, user.uid);
});

// The relay cuts only this test server's database transport; it never stops or changes
// the supplied database. TLS endpoints are excluded because replacing a hostname with
// a loopback relay would change certificate verification, rather than test an outage.
function plainLoopback(url) {
  if (!url) return false;
  const value = new URL(url);
  return ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname) &&
    (!value.searchParams.has('sslmode') || value.searchParams.get('sslmode') === 'disable');
}

test('PostgreSQL: a real connection outage refuses writes, then recovers without losing the paired profile', {
  ...enabled, skip: !DATABASE_URL || !plainLoopback(DATABASE_URL)
    ? 'requires a disposable plaintext loopback TEST_DATABASE_URL for the transport relay' : false
}, async t => {
  const f = await fixture(t);
  const target = new URL(DATABASE_URL);
  const sockets = new Set();
  let relay;
  let port = 0;
  const open = () => new Promise((resolve, reject) => {
    relay = net.createServer(client => {
      const upstream = net.connect(Number(target.port || 5432), target.hostname.replace(/^\[|\]$/g, ''));
      sockets.add(client); sockets.add(upstream);
      for (const socket of [client, upstream]) {
        socket.on('error', () => { client.destroy(); upstream.destroy(); });
        socket.on('close', () => sockets.delete(socket));
      }
      client.pipe(upstream).pipe(client);
    });
    relay.once('error', reject);
    relay.listen(port, '127.0.0.1', () => { port = relay.address().port; resolve(); });
  });
  const cut = () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    relay.close(resolve);
  });
  await open();
  t.after(async () => { if (relay.listening) await cut(); });
  const proxy = new URL(DATABASE_URL); proxy.hostname = '127.0.0.1'; proxy.port = String(port);
  const server = await f.start(proxy.href);
  const user = await f.account(server);
  const original = await server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state('before outage'), baseRev: 0 }
  });
  assert.equal(original.status, 200);
  await cut();
  const failed = await server.request('PUT', '/api/data', {
    ...mobile(user.token), body: { state: state('during outage'), baseRev: 1 }
  });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('access-control-allow-origin'), NATIVE_ORIGIN,
    'the native app can read a storage failure instead of receiving an opaque CORS error');
  assert.equal(Number((await f.stored(user.uid)).rev), 1);
  assert.equal((await f.stored(user.uid)).state.routines[0].name, 'before outage');
  await open();
  const restored = await server.request('GET', '/api/data', mobile(user.token));
  assert.equal(restored.status, 200);
  assert.equal(restored.body.rev, 1);
  assert.equal(restored.body.state.routines[0].name, 'before outage');
});

test('PostgreSQL: an unavailable authoritative database prevents startup instead of creating an empty local instance', enabled, async t => {
  // This listener owns its port throughout the test but cannot speak PostgreSQL. It
  // models a database connection failure without stopping any shared database.
  const refusedConnections = net.createServer(socket => socket.destroy());
  await new Promise(resolve => refusedConnections.listen(0, '127.0.0.1', resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-postgres-unavailable-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost',
      DATABASE_URL: `postgresql://test:test@127.0.0.1:${refusedConnections.address().port}/test`,
      OPENGYM_DATABASE_SCHEMA: 'opengym_startup_failure_test', MEDIA_UPLOADS: '0', COACH_DISABLED: '1'
    }
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(async () => {
    await stop(child);
    await new Promise(resolve => refusedConnections.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.doesNotMatch(log, /gym-api on :\d+/, 'the API never accepts traffic');
  assert.match(log, /refusing to start without authoritative storage/);
  assert.equal(fs.existsSync(path.join(dataDir, 'db.json')), false, 'no replacement empty profile database is created');
});
