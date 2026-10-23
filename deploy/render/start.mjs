import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Same policy as v1.4.2 web/Dockerfile. The hash allows the existing inline script
// that sets language/direction before paint; no application script is modified.
export const DEFAULT_CSP = "default-src 'self'; script-src 'self' 'sha256-z/iOLe5i8fD4VNlIXz/4hEayGLTQzoTc52dIY51OjYc='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self' https: http:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function resolveConfig(env = process.env) {
  const port = Number(env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 3000) {
    throw new Error('PORT must be a valid public port other than the internal API port 3000');
  }
  // The container never silently falls back to ephemeral accounts or workout data.
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; refusing ephemeral storage');
  let db;
  try { db = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  const external = env.ORIGIN || env.RENDER_EXTERNAL_URL ||
    (env.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : '');
  if (!external) throw new Error('Set ORIGIN, or deploy with Render external URL environment variables');
  let origin;
  try { origin = new URL(external); } catch { throw new Error('ORIGIN must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('ORIGIN must be an HTTP(S) origin without a path, query, or credentials');
  }
  if ((env.RENDER || env.RENDER_EXTERNAL_HOSTNAME || env.RENDER_EXTERNAL_URL) && origin.protocol !== 'https:') {
    throw new Error('Render deployments require an HTTPS ORIGIN');
  }
  const rpId = env.RP_ID || origin.hostname;
  if (rpId !== origin.hostname) throw new Error('RP_ID must match the hostname in ORIGIN');
  const csp = env.CONTENT_SECURITY_POLICY || DEFAULT_CSP;
  if (/["\r\n\\]/.test(csp)) throw new Error('CONTENT_SECURITY_POLICY contains characters unsafe for nginx configuration');
  return { port, origin: origin.origin, rpId, csp };
}

export function renderNginx(template, cfg) {
  const vars = {
    BASE_PATH: '', NGINX_PORT: String(cfg.port), BACKEND: '127.0.0.1', PORT: '3000',
    RESOLVER: '127.0.0.1', CF_CONNECTING_IP: '', MEDIA_UPLOAD_MAX: '48m',
    CONTENT_SECURITY_POLICY: cfg.csp
  };
  const server = template.replace(/\$\{([A-Z_]+)\}/g, (match, name) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Unknown nginx template variable ${name}`);
    return vars[name];
  });
  // The unchanged upstream template retains raw request targets, API/mobile CORS,
  // streaming uploads, no media hotlinking, cache rules and browser security headers.
  // With a numeric localhost upstream no DNS lookup is needed.
  return `user nginx;\nworker_processes auto;\npid /tmp/opengym-nginx.pid;\nerror_log /dev/stderr warn;\nevents { worker_connections 1024; }\nhttp {\ninclude /etc/nginx/mime.types;\ndefault_type application/octet-stream;\naccess_log /dev/stdout;\nsendfile on;\n${server}\n}\n`;
}

export function start() {
  const cfg = resolveConfig();
  const template = fs.readFileSync(path.join(here, 'nginx.conf.template'), 'utf8');
  const nginxPath = '/tmp/opengym-nginx.conf';
  fs.writeFileSync(nginxPath, renderNginx(template, cfg));
  const api = spawn(process.execPath, ['/app/api/server.js'], {
    cwd: '/app/api', stdio: 'inherit',
    env: { ...process.env, PORT: '3000', ORIGIN: cfg.origin, RP_ID: cfg.rpId }
  });
  const nginx = spawn('nginx', ['-c', nginxPath, '-g', 'daemon off;'], { stdio: 'inherit' });
  let stopping = false;
  const stop = exitCode => {
    if (stopping) return;
    stopping = true;
    const pending = [api, nginx].filter(child => child.pid && child.exitCode === null && child.signalCode === null);
    let remaining = pending.length;
    if (!remaining) process.exit(exitCode);
    const deadline = setTimeout(() => {
      for (const child of pending) child.kill('SIGKILL');
      process.exit(exitCode);
    }, 10000);
    for (const child of pending) {
      child.once('close', () => {
        remaining -= 1;
        if (!remaining) { clearTimeout(deadline); process.exit(exitCode); }
      });
      child.kill(child === nginx ? 'SIGQUIT' : 'SIGTERM');
    }
  };
  for (const [label, child] of [['API', api], ['nginx', nginx]]) {
    child.on('error', error => { console.error(`${label} could not start: ${error.message}`); stop(1); });
    child.on('exit', code => { if (!stopping) stop(code || 1); });
  }
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));
  console.log(`openGym serving ${cfg.origin} on port ${cfg.port}; external PostgreSQL required`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { start(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
