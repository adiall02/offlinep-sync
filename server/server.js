import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdempotencyStore } from './idempotency.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

/** Demo accounts. Password doubles as the key that unlocks the encrypted local store. */
const USERS = { demo: { id: 'u-demo', password: 'demo' }, alice: { id: 'u-alice', password: 'alice' } };

/**
 * Builds the demo API. Returned object lets tests start it on an ephemeral port and inspect state.
 * `chaos` is the fault-injection panel (see README "Break it on purpose").
 */
export function createApp({ idempotency = new IdempotencyStore() } = {}) {
  const tasks = new Map();      // id -> task
  const sessions = new Map();   // token -> userId
  const chaos = { latencyMs: 0, failNext: 0, dropResponseNext: 0 };
  const log = [];               // request log for the server view

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const readBody = async req => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : undefined;
  };

  /** Business handlers. Each returns `{ status, body }` and never touches `res`. */
  const handlers = {
    listTasks: user => ({ status: 200, body: { serverTime: new Date().toISOString(), tasks: [...tasks.values()].filter(t => t.owner === user.id) } }),

    createTask: (user, body) => {
      const title = String(body?.title ?? '').trim();
      if (!title) return { status: 400, body: { error: 'Title is required.' } };
      // Demo of a PERMANENT rejection: the client must park this one as "failed", not retry forever.
      if (title.toLowerCase().includes('!reject')) return { status: 422, body: { error: 'Rejected by business rule (title contains "!reject").' } };
      const id = String(body.id ?? randomUUID());
      if (tasks.has(id)) return { status: 409, body: { error: 'Task id already exists.' } };
      const task = { id, title, done: false, version: 1, owner: user.id, updatedAt: new Date().toISOString() };
      tasks.set(id, task);
      return { status: 201, body: task };
    },

    patchTask: (user, id, body, headers) => {
      const task = tasks.get(id);
      if (!task || task.owner !== user.id) return { status: 404, body: { error: 'Task not found.' } };
      const ifMatch = headers['if-match'];
      if (ifMatch !== undefined && Number(ifMatch) !== task.version) {
        return { status: 412, body: { error: 'Task changed on the server since you read it.' } };
      }
      if (typeof body?.title === 'string') task.title = body.title.trim() || task.title;
      if (typeof body?.done === 'boolean') task.done = body.done;
      task.version += 1;
      task.updatedAt = new Date().toISOString();
      return { status: 200, body: task };
    },
  };

  const handleApi = async (req, res, url) => {
    // ── Chaos + debug endpoints (no auth, demo only) ──────────────────────────
    if (url.pathname === '/api/_chaos' && req.method === 'POST') {
      Object.assign(chaos, await readBody(req));
      if (chaos.expireSessions) { sessions.clear(); delete chaos.expireSessions; }
      return json(res, 200, chaos);
    }
    if (url.pathname === '/api/_debug' && req.method === 'GET') {
      return json(res, 200, { chaos, tasks: [...tasks.values()], idempotency: idempotency.list(), log: log.slice(-30) });
    }
    if (url.pathname === '/api/_debug/edit' && req.method === 'POST') {
      // Simulates "somebody else edited this task on the server" to provoke a 412 conflict.
      const { id, title } = await readBody(req);
      const t = tasks.get(id);
      if (!t) return json(res, 404, { error: 'not found' });
      t.title = title; t.version += 1;
      return json(res, 200, t);
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { username, password } = (await readBody(req)) ?? {};
      const account = USERS[username];
      if (!account || account.password !== password) return json(res, 401, { error: 'Invalid credentials.' });
      const token = randomUUID();
      sessions.set(token, account.id);
      return json(res, 200, { token, userId: account.id, username });
    }

    // ── Authenticated API ─────────────────────────────────────────────────────
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const userId = sessions.get(token);
    if (!userId) return json(res, 401, { error: 'Session expired.' });
    const user = { id: userId };

    // Chaos before processing: simulates a flaky / overloaded server (request never committed).
    if (chaos.latencyMs > 0) await new Promise(r => setTimeout(r, chaos.latencyMs));
    if (chaos.failNext > 0 && req.method !== 'GET') {
      chaos.failNext--;
      log.push(`${req.method} ${url.pathname} → 503 (chaos: failNext)`);
      return json(res, 503, { error: 'Chaos: server unavailable.' });
    }

    const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
    const key = req.headers['idempotency-key'];
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);

    let run;
    if (url.pathname === '/api/tasks' && req.method === 'GET') run = async () => handlers.listTasks(user);
    else if (url.pathname === '/api/tasks' && req.method === 'POST') run = async () => handlers.createTask(user, body);
    else if (match && req.method === 'PATCH') run = async () => handlers.patchTask(user, match[1], body, req.headers);
    else return json(res, 404, { error: 'Not found.' });

    const result = await idempotency.run(
      { method: req.method, path: url.pathname, key: typeof key === 'string' ? key : undefined, userId, body },
      run);

    log.push(`${req.method} ${url.pathname} → ${result.status}${result.replayed ? ' (idempotent replay)' : ''}${key ? ` key=${String(key).slice(0, 8)}…` : ''}`);

    // Chaos AFTER commit: the write happened but the client never sees the answer.
    // This is the classic case idempotency keys exist for.
    if (chaos.dropResponseNext > 0 && req.method !== 'GET' && !result.replayed) {
      chaos.dropResponseNext--;
      log.push(`  ↳ response dropped after commit (chaos: dropResponseNext)`);
      req.socket.destroy();
      return;
    }
    json(res, result.status, result.body, result.replayed ? { 'Idempotency-Replayed': 'true' } : {});
  };

  const serveStatic = async (req, res, url) => {
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Internal error.' });
    }
  });

  return { server, tasks, sessions, chaos, idempotency };
}

// Run directly: `node server/server.js`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().server.listen(port, () => console.log(`Offline-sync demo → http://localhost:${port}  (logins: demo/demo, alice/alice)`));
}
