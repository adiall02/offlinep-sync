/**
 * Tasks repository: the feature code that sits on top of the sync engine.
 * It shows the three patterns every offline-capable feature needs:
 *
 *   READ   network first, write-through to the encrypted cache, fall back to the cache offline
 *          (result is flagged `fromCache` so the UI can show an "offline data" chip)
 *   WRITE  go through `sync.mutate()` — never call fetch directly for a mutation
 *   VIEW   overlay still-queued writes onto the read model so the user sees their own changes
 *          immediately (optimistic UI), each marked pending / failed
 */
const COLLECTION = 'tasks';
const LIST_KEY = 'list';

export class TasksRepo {
  constructor({ http, store, sync, uuid = () => crypto.randomUUID() }) {
    Object.assign(this, { http, store, sync, uuid });
  }

  /** Pull side: refresh the cache when online. Offline → serve the last snapshot. */
  async load() {
    try {
      const { tasks, serverTime } = await this.http('GET', '/api/tasks');
      if (this.store.unlocked) await this.store.cachePut(COLLECTION, LIST_KEY, { tasks, serverTime });
      return { tasks, fromCache: false, serverTime };
    } catch (err) {
      if (err?.status) throw err; // a real HTTP error is not "offline"
      const cached = this.store.unlocked ? await this.store.cacheGet(COLLECTION, LIST_KEY) : null;
      return { tasks: cached?.tasks ?? [], fromCache: true, serverTime: cached?.serverTime ?? null, cacheMiss: !cached };
    }
  }

  /** Read model + queued writes layered on top. */
  async view() {
    const base = await this.load();
    const byId = new Map(base.tasks.map(t => [t.id, { ...t, sync: 'synced' }]));
    const entries = this.store.unlocked ? await this.store.outboxList() : [];

    for (const e of entries.filter(x => x.entity === 'task')) {
      const state = e.status === 'pending' ? 'pending' : 'failed';
      if (e.method === 'POST') {
        byId.set(e.body.id, { id: e.body.id, title: e.body.title, done: false, version: 0, sync: state, error: e.lastError });
      } else {
        const id = e.url.split('/').pop();
        const t = byId.get(id);
        if (t && e.status === 'pending') byId.set(id, { ...t, ...e.body, sync: 'pending' });
        else if (t) byId.set(id, { ...t, sync: 'failed', error: e.lastError });
      }
    }
    return { ...base, tasks: [...byId.values()] };
  }

  // Writes. The client generates the id so the optimistic row and the server row are the same row.
  add(title) {
    const id = this.uuid();
    return this.sync.mutate('task', 'POST', '/api/tasks', { id, title });
  }

  /** Last-writer-wins: no precondition header. */
  toggle(task) {
    return this.sync.mutate('task', 'PATCH', `/api/tasks/${task.id}`, { done: !task.done });
  }

  /** Optimistic concurrency: If-Match makes the server answer 412 if someone else changed it. */
  rename(task, title) {
    return this.sync.mutate('task', 'PATCH', `/api/tasks/${task.id}`, { title }, { 'If-Match': String(task.version) });
  }
}
