/**
 * Storage backends. They only ever see OPAQUE strings: encryption happens above this layer,
 * so swapping IndexedDB for SQLite-WASM/OPFS (what SankTec uses) never touches crypto or sync code.
 *
 * Interface (all async):
 *   outboxInsert(row) outboxAll() outboxUpdate(id, patch) outboxDelete(id)
 *   cachePut(collection, key, payloadEnc, updatedAt) cacheGet(collection, key) cacheClear()
 *   metaGet(k) metaSet(k, v) metaDelete(k) clearData()
 */
export class MemoryBackend {
  persistent = false;
  outbox = new Map();
  cache = new Map();
  meta = new Map();

  async init() { return { persistent: this.persistent }; }
  async outboxInsert(row) { this.outbox.set(row.id, { ...row }); }
  async outboxAll() { return [...this.outbox.values()].sort((a, b) => a.queuedAt - b.queuedAt).map(r => ({ ...r })); }
  async outboxUpdate(id, patch) { const r = this.outbox.get(id); if (r) Object.assign(r, patch); }
  async outboxDelete(id) { this.outbox.delete(id); }
  async cachePut(collection, key, payloadEnc, updatedAt) { this.cache.set(`${collection}|${key}`, { payloadEnc, updatedAt }); }
  async cacheGet(collection, key) { return this.cache.get(`${collection}|${key}`)?.payloadEnc ?? null; }
  async cacheClear() { this.cache.clear(); }
  async metaGet(k) { return this.meta.get(k) ?? null; }
  async metaSet(k, v) { this.meta.set(k, v); }
  async metaDelete(k) { this.meta.delete(k); }
  async clearData() { this.outbox.clear(); this.cache.clear(); this.meta.clear(); }
}

/** Persistent backend: three object stores that mirror SankTec's three SQLite tables. */
export class IndexedDbBackend {
  persistent = true;
  #db = null;

  constructor(name = 'offline-sync-demo') { this.name = name; }

  async init() {
    this.#db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('outbox', { keyPath: 'id' });
        db.createObjectStore('cache', { keyPath: ['collection', 'key'] });
        db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return { persistent: true };
  }

  #tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  outboxInsert(row) { return this.#tx('outbox', 'readwrite', s => s.put(row)); }
  async outboxAll() {
    const rows = await this.#tx('outbox', 'readonly', s => s.getAll());
    return rows.sort((a, b) => a.queuedAt - b.queuedAt);
  }
  async outboxUpdate(id, patch) {
    const row = await this.#tx('outbox', 'readonly', s => s.get(id));
    if (row) await this.#tx('outbox', 'readwrite', s => s.put({ ...row, ...patch }));
  }
  outboxDelete(id) { return this.#tx('outbox', 'readwrite', s => s.delete(id)); }
  cachePut(collection, key, payloadEnc, updatedAt) {
    return this.#tx('cache', 'readwrite', s => s.put({ collection, key, payloadEnc, updatedAt }));
  }
  async cacheGet(collection, key) {
    return (await this.#tx('cache', 'readonly', s => s.get([collection, key])))?.payloadEnc ?? null;
  }
  cacheClear() { return this.#tx('cache', 'readwrite', s => s.clear()); }
  async metaGet(k) { return (await this.#tx('meta', 'readonly', s => s.get(k)))?.v ?? null; }
  metaSet(k, v) { return this.#tx('meta', 'readwrite', s => s.put({ k, v })); }
  metaDelete(k) { return this.#tx('meta', 'readwrite', s => s.delete(k)); }
  async clearData() {
    await Promise.all(['outbox', 'cache', 'meta'].map(s => this.#tx(s, 'readwrite', st => st.clear())));
  }
}
