import { createApp } from '../server/server.js';
import { MemoryBackend } from '../public/lib/backends.js';
import { LocalStore } from '../public/lib/local-store.js';
import { createHttp } from '../public/lib/http.js';
import { SyncService } from '../public/lib/sync.js';
import { TasksRepo } from '../public/lib/tasks.js';

/** Starts the real demo server on an ephemeral port and wires a full client against it. */
export async function setup({ user = 'demo', password = 'demo', syncOptions = {} } = {}) {
  const app = createApp();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const net = { online: true };
  const session = { token: null };
  const raw = createHttp({ getToken: () => session.token, isOnline: () => net.online, timeoutMs: 2000 });
  const http = (method, url, opts) => raw(method, base + url, opts);

  const login = async () => {
    const res = await createHttp({ getToken: () => null })('POST', `${base}/api/login`, { body: { username: user, password } });
    session.token = res.token;
    return res;
  };
  const { userId } = await login();

  const backend = new MemoryBackend();
  const store = new LocalStore(backend, { kdfIterations: 1000 });
  await store.init();
  await store.open(userId, password);

  const sync = new SyncService({ store, http, isOnline: () => net.online, backoffBaseMs: 1, ...syncOptions });
  const repo = new TasksRepo({ http, store, sync });

  return {
    app, base, net, session, backend, store, sync, repo, http, login, userId,
    serverTasks: () => [...app.tasks.values()],
    close: () => new Promise(r => { app.server.closeAllConnections?.(); app.server.close(r); }),
  };
}
