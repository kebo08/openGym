import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Remote databases always use certificate/hostname verification. Loopback is useful for
// disposable integration databases; never weaken TLS to make a hosted connection succeed.
export function verifiedConnectionString(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid database protocol');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/**
 * A direct PostgreSQL unit of work for the API's synchronous domain helpers.
 *
 * A request works on objects read inside its database transaction, never a filesystem
 * snapshot. Its JSON reply is held by server.js until commit. The singleton lock also
 * protects account mutations and absent state rows across processes. State rows are
 * locked before stampPut's compare/write, preserving the native client's CAS contract.
 * Only one request executes domain code at a time in this small-instance backend.
 */
export class PostgresStorage {
  constructor({ connectionString, schema = 'public', pool } = {}) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw new Error('invalid database schema');
    this.schema = `"${schema}"`;
    this.table = name => `${this.schema}."opengym_${name}"`;
    this.pool = pool || new Pool({
      connectionString: verifiedConnectionString(connectionString), max: 1,
      connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000,
      statement_timeout: 15000, query_timeout: 20000
    });
    // pg emits idle-client errors separately from query rejections.
    this.pool.on?.('error', () => console.error('PostgreSQL connection unavailable'));
    this.local = new AsyncLocalStorage();
    this.tail = Promise.resolve();
    this.initial = null;
  }

  validate(data) {
    if (!object(data) || !object(data.db) || !/^[a-f0-9]{64}$/i.test(data.secret || '')
      || !object(data.vapid) || !data.vapid.publicKey || !data.vapid.privateKey
      || !['users', 'creds', 'subs', 'invites'].every(k => Array.isArray(data.db[k]))) {
      throw new Error('invalid persisted instance configuration');
    }
    return data;
  }

  async initialize(makeInitial) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      const prior = (await client.query('SELECT to_regclass($1) AS instance, to_regclass($2) AS states',
        [this.table('instance'), this.table('states')])).rows[0];
      if (!!prior.instance !== !!prior.states) throw new Error('incomplete persisted database; restore required');
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table('instance')} (
        id integer PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table('states')} (
        uid text PRIMARY KEY, state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
        rev bigint NOT NULL CHECK (rev >= 0))`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table('audit')} (
        id bigint PRIMARY KEY, event jsonb NOT NULL)`);
      // Missing metadata in an established database is damage, not a new instance.
      // Do not orphan existing accounts/history by generating replacement authority.
      if (!prior.instance) {
        const seed = this.validate(makeInitial());
        await client.query(`INSERT INTO ${this.table('instance')} (id, data) VALUES (1, $1::jsonb)
          ON CONFLICT (id) DO NOTHING`, [JSON.stringify(seed)]);
      }
      const { rows } = await client.query(`SELECT data FROM ${this.table('instance')} WHERE id = 1 FOR UPDATE`);
      this.initial = clone(this.validate(rows[0]?.data));
      await client.query('COMMIT');
      return clone(this.initial);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* broken connection */ }
      throw error;
    } finally { client.release(); }
  }

  get active() { return !!this.local.getStore(); }
  get context() {
    const ctx = this.local.getStore();
    if (!ctx) throw new Error('PostgreSQL mutation outside transaction');
    return ctx;
  }
  get db() { return this.context.data.db; }
  get auditSeq() { return Number(this.context.data.auditSeq) || 0; }
  readState(uid) { const value = this.context.states.get(uid); return value ? clone(value) : null; }
  saveDb(db) { this.context.data.db = db; this.context.instanceDirty = true; }
  writeState(uid, state) {
    if (!object(state)) throw new Error('invalid state');
    const ctx = this.context;
    ctx.states.set(uid, clone(state));
    ctx.stateWrites.set(uid, clone(state));
  }
  deleteState(uid) {
    this.context.states.delete(uid);
    this.context.stateWrites.set(uid, null);
  }
  auditLines() { return clone(this.context.audit); }
  appendAudit(event) {
    const ctx = this.context;
    ctx.audit.push(clone(event));
    ctx.auditAdds.push(clone(event));
    ctx.data.auditSeq = Math.max(Number(ctx.data.auditSeq) || 0, event.id);
    ctx.instanceDirty = true;
  }
  replaceAudit(events) {
    const ctx = this.context;
    ctx.audit = clone(events);
    ctx.auditReplace = true;
    ctx.auditAdds = [];
  }

  async transaction(fn) {
    // Acquire the local queue before touching the globally bound server db object.
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const result = await client.query(`SELECT data FROM ${this.table('instance')} WHERE id = 1 FOR UPDATE`);
      const data = clone(this.validate(result.rows[0]?.data));
      if (data.secret !== this.initial.secret
        || data.vapid.publicKey !== this.initial.vapid.publicKey
        || data.vapid.privateKey !== this.initial.vapid.privateKey) {
        throw new Error('instance keys changed; restart required');
      }
      const states = new Map();
      for (const row of (await client.query(`SELECT uid, state, rev FROM ${this.table('states')} FOR UPDATE`)).rows) {
        if (!object(row.state) || (Number(row.state._rev) || 0) !== Number(row.rev)) throw new Error('invalid persisted profile state');
        states.set(row.uid, row.state);
      }
      let audit = [];
      await client.query('SAVEPOINT audit_read');
      try {
        audit = (await client.query(`SELECT event FROM ${this.table('audit')} ORDER BY id`)).rows
          .map(r => r.event).filter(r => object(r) && r.id && r.ev);
        await client.query('RELEASE SAVEPOINT audit_read');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT audit_read');
        console.error('PostgreSQL audit read failed');
      }
      data.auditSeq = audit.reduce((max, r) => Math.max(max, Number(r.id) || 0), Number(data.auditSeq) || 0);
      const ctx = { data, states, audit, stateWrites: new Map(), instanceDirty: false,
        auditAdds: [], auditReplace: false };
      return await this.local.run(ctx, async () => {
        const value = await fn();
        if (ctx.instanceDirty) await client.query(`UPDATE ${this.table('instance')} SET data=$1::jsonb WHERE id=1`, [JSON.stringify(ctx.data)]);
        for (const [uid, state] of ctx.stateWrites) {
          if (state === null) await client.query(`DELETE FROM ${this.table('states')} WHERE uid=$1`, [uid]);
          else await client.query(`INSERT INTO ${this.table('states')} (uid,state,rev) VALUES ($1,$2::jsonb,$3)
            ON CONFLICT (uid) DO UPDATE SET state=EXCLUDED.state,rev=EXCLUDED.rev`,
          [uid, JSON.stringify(state), Number(state._rev) || 0]);
        }
        // Audit is best-effort, as in the file backend. A SAVEPOINT keeps a log failure
        // from poisoning the transaction containing an account or training-data write.
        if (ctx.auditReplace || ctx.auditAdds.length) {
          await client.query('SAVEPOINT audit_write');
          try {
            if (ctx.auditReplace) {
              await client.query(`DELETE FROM ${this.table('audit')}`);
              for (const event of ctx.audit) await client.query(`INSERT INTO ${this.table('audit')} (id,event) VALUES ($1,$2::jsonb)`, [event.id, JSON.stringify(event)]);
            } else for (const event of ctx.auditAdds) {
              await client.query(`INSERT INTO ${this.table('audit')} (id,event) VALUES ($1,$2::jsonb)`, [event.id, JSON.stringify(event)]);
            }
            await client.query('RELEASE SAVEPOINT audit_write');
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT audit_write');
            console.error('PostgreSQL audit write failed');
          }
        }
        await client.query('COMMIT');
        return value;
      });
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* broken connection */ }
      throw error;
    } finally { client?.release(); release(); }
  }

  async close() { await this.tail; await this.pool.end(); }
}
