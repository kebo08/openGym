#!/usr/bin/env node
// A separate paired session for Codex; exercise plans travel, credentials never do.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildPlanBundle, parsePlan } from '../frontend/src/lib/plan-share.js';

export function serverOrigin(value, { allowLocalHttp = false } = {}) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['/', '/api', '/api/'].includes(u.pathname)) {
    throw new Error('Use the server origin, without credentials, query, or a page path');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(allowLocalHttp && local && u.protocol === 'http:')) {
    throw new Error('The server must use HTTPS');
  }
  return u.origin;
}

const fingerprint = state => {
  const plan = buildPlanBundle(state, '');
  return crypto.createHash('sha256').update(JSON.stringify([plan.routines, plan.week, plan.customEx, plan.unit])).digest('hex');
};

export function createClient({ server, token, allowLocalHttp = false, fetchImpl = fetch }) {
  const origin = serverOrigin(server, { allowLocalHttp });
  let session = token;
  const request = async (route, body, authenticated = true) => {
    if (authenticated && !session) throw new Error('Pair a separate Codex session first');
    const response = await fetchImpl(origin + route, {
      method: body === undefined ? 'GET' : route === '/api/data' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${session}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(90000)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const e = new Error(response.status === 409 ? 'The profile changed; export the plan again before applying it' :
        `OpenGym request failed (HTTP ${response.status})`);
      e.status = response.status;
      throw e;
    }
    if (!data || typeof data !== 'object') throw new Error('The server did not return OpenGym JSON');
    return data;
  };
  const me = async () => {
    const data = await request('/api/me');
    if (!data.user?.id) throw new Error('The server returned no signed-in profile');
    if (data.token) session = data.token;
    return data.user;
  };
  return {
    origin, get token() { return session; },
    async pair(code) {
      if (typeof code !== 'string' || !code.trim()) throw new Error('A pairing code is required');
      const data = await request('/api/pair/redeem', { code: code.trim() }, false);
      if (typeof data.token !== 'string' || !data.user?.id) throw new Error('The pairing response was invalid');
      session = data.token;
      return data.user;
    },
    status: me,
    async exportPlan() {
      const user = await me();
      const { state, rev } = await request('/api/data');
      const current = state || { unit: 'kg', routines: [], week: {}, customEx: [] };
      return { ...buildPlanBundle(current, 'Training plan'), codex_source: {
        server: origin, profile: user.id, rev, wid: current._wid || null, fingerprint: fingerprint(current)
      } };
    },
    async applyPlan(plan) {
      const user = await me();
      if (plan?.codex_source?.server !== origin || plan.codex_source.profile !== user.id) {
        throw new Error('Start with a plan exported from this server and profile');
      }
      const { state, rev } = await request('/api/data');
      const current = state || { unit: 'kg', routines: [], week: {}, customEx: [], workouts: [], bodyweight: [] };
      if (fingerprint(current) !== plan.codex_source.fingerprint) {
        throw new Error('The server plan changed since export; export again and review the changes');
      }
      const parsed = parsePlan(plan, current.unit || 'kg');
      if (parsed.dropped || parsed.routines.length !== plan.routines.length) throw new Error('The plan contains unknown exercises or malformed routines');
      if (!parsed.routines.length || parsed.routines.some(r => !r.ex.length || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string' || !r.name.trim())) {
        throw new Error('Each routine needs a stable ID, a name, and at least one exercise');
      }
      for (const routine of parsed.routines) for (const exercise of routine.ex) {
        if (!Number.isInteger(exercise.sets) || exercise.sets < 1 || exercise.sets > 100 ||
            (exercise.mode != null && !['reps', 'time', 'cardio'].includes(exercise.mode)) ||
            (exercise.weight != null && (!Number.isFinite(exercise.weight) || exercise.weight < 0)) ||
            (exercise.reps != null && (!Number.isInteger(exercise.reps) || exercise.reps < 1 || exercise.reps > 1000))) {
          throw new Error('The plan contains an invalid exercise prescription');
        }
      }
      const ids = new Set(parsed.routines.map(r => r.id));
      if (ids.size !== parsed.routines.length) throw new Error('Routine IDs must be unique');
      for (const [day, value] of Object.entries(parsed.week)) {
        if (!/^[0-6]$/.test(day) || ![].concat(value).every(id => ids.has(id))) throw new Error('The weekly schedule references an invalid routine or day');
      }
      const customs = new Map((current.customEx || []).map(e => [e.id, e]));
      for (const ex of parsed.customEx) customs.set(ex.id, { ...customs.get(ex.id), ...ex, custom: true });
      // Always start from the latest full document: workouts and weigh-ins can advance
      // after the export without being replaced by the plan file's older view.
      const next = { ...current, routines: parsed.routines, week: parsed.week, customEx: [...customs.values()], _ts: Date.now() };
      const result = await request('/api/data', { state: next, baseRev: rev, ...(current._wid ? { baseWid: current._wid } : {}) });
      return { revision: result.rev, routines: parsed.routines.length };
    }
  };
}

function saveAuth(file, client) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ server: client.origin, token: client.token }) + '\n', { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    server: { type: 'string' }, auth: { type: 'string' }, file: { type: 'string' },
    'allow-local-http': { type: 'boolean', default: false }, help: { type: 'boolean', default: false }
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('pair --server https://YOUR-SERVER --auth .opengym/session.json (pair code on stdin)\nstatus --auth FILE\nexport-plan --auth FILE --file plan.json\napply-plan --auth FILE --file plan.json');
    return;
  }
  if (!['pair', 'status', 'export-plan', 'apply-plan'].includes(command)) throw new Error('Unknown command');
  const authPath = path.resolve(values.auth || '.opengym/session.json');
  const existing = command === 'pair' ? {} : JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (values.server && existing.server && serverOrigin(values.server, { allowLocalHttp: values['allow-local-http'] }) !== existing.server) {
    throw new Error('This credential belongs to a different server');
  }
  const client = createClient({ server: values.server || existing.server, token: existing.token, allowLocalHttp: values['allow-local-http'] });
  if (command === 'pair') {
    if (fs.existsSync(authPath)) throw new Error('Choose a new --auth path; an existing session will not be overwritten');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 100) throw new Error('Invalid pairing code'); }
    await client.pair(input.trim());
    saveAuth(authPath, client);
    console.log('Paired. Credential saved locally; it was not printed.');
    return;
  }
  if (command === 'status') {
    await client.status();
    console.log('Connected to ' + client.origin);
  } else {
    if (!values.file) throw new Error('--file is required');
    const file = path.resolve(values.file);
    if (command === 'export-plan') {
      const plan = await client.exportPlan();
      fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log('Plan exported to ' + file);
    } else {
      const result = await client.applyPlan(JSON.parse(fs.readFileSync(file, 'utf8')));
      console.log(`Saved ${result.routines} routines at revision ${result.revision}`);
    }
  }
  if (client.token !== existing.token) saveAuth(authPath, client);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
