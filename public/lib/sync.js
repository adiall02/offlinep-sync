import { Emitter } from './emitter.js';
import { HttpError } from './http.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

// 4xx codes that are NOT a permanent rejection — they resolve on their own, so keep retrying:
//   401 token expired (re-auth, then replay) · 408 timeout · 429 rate limited / duplicate in flight
const TRANSIENT_4XX = new Set([401, 408, 429]);

const isPermanentRejection = err =>
  err instanceof HttpError && err.status >= 400 && err.status < 500 && !TRANSIENT_4XX.has(err.status);
const isUnauthorized = err => err instanceof HttpError && err.status === 401;

/** 30s, 1m, 2m … capped at 30m (shorter in tests via options). */
export const backoffMs = (attempts, base = 30_000, max = 30 * 60_000) =>
  Math.min(base * 2 ** Math.max(0, attempts - 1), max);

/**
 * The sync engine — port of SankTec's SyncService v2.
 *
 *   mutate()  online  → send straight to the ORIGINAL endpoint, with an Idempotency-Key
 *             offline → persist in the encrypted outbox, resolve { queued: true }
 *             transient failure (network, timeout, 5xx, 401/408/429) → also queue
 *             permanent 4xx → throw (the form shows the server's message)
 *   flush()   replay pending entries IN ORDER to their original method+url, reusing the
 *             outbox id as Idempotency-Key. Transient failure → backoff, stop the loop.
 *             Permanent 4xx → park as `failed`, continue. 401 → pause + ask for password.
 *   Nothing is ever dropped silently: failed entries wait for an explicit retry/abandon.
 */
export class SyncService extends Emitter {
  constructor({ store, http, isOnline, backoffBaseMs = 30_000, maxTransientAttempts = 8, now = () => Date.now(), uuid = () => crypto.randomUUID() }) {
    super();
    Object.assign(this, { store, http, isOnline, backoffBaseMs, maxTransientAttempts, now, uuid });
    this.syncing = false;
    this.sessionExpired = false;
    this.counts = { pending: 0, failed: 0 };
    this.failedEntries = [];
  }

  /** Queue-aware mutation. */
  async mutate(entity, method, url, body, headers = {}) {
    const id = this.uuid();

    if (this.store.mode === 'foreign') {
      // Another user's unsent data owns the outbox: this user may only write while online.
      if (!this.isOnline()) throw new Error('Offline mode is disabled on this device — you can only save while online.');
      return { queued: false, value: await this.http(method, url, { body, headers: { ...headers, [IDEMPOTENCY_HEADER]: id } }) };
    }

    if (!this.isOnline()) return this.#enqueue(id, entity, method, url, body, headers);

    try {
      const value = await this.http(method, url, { body, headers: { ...headers, [IDEMPOTENCY_HEADER]: id } });
      return { queued: false, value };
    } catch (err) {
      if (isPermanentRejection(err)) throw err;
      if (isUnauthorized(err)) this.#setSessionExpired(true);
      // Ambiguous or recoverable: the request may or may not have been applied. Queue it under
      // the SAME id — the server's idempotency key makes the later replay safe either way.
      return this.#enqueue(id, entity, method, url, body, headers);
    }
  }

  async #enqueue(id, entity, method, url, body, headers) {
    await this.store.outboxAdd({ id, entity, method, url, body, headers });
    await this.refreshCounts();
    return { queued: true, id };
  }

  async flush() {
    if (this.syncing || !this.isOnline() || !this.store.unlocked || this.sessionExpired) return;
    this.syncing = true;
    this.emit('change');
    let delivered = 0;
    try {
      const pending = (await this.store.outboxList()).filter(e => e.status === 'pending');
      const t = this.now();
      for (const entry of pending) {
        // Strict order: an entry in backoff blocks the ones behind it (later updates could
        // otherwise be applied against stale state).
        if (entry.nextAttemptAt > t) break;
        const outcome = await this.#replay(entry);
        if (outcome === 'delivered') delivered++;
        if (outcome === 'stop') break;
      }
    } finally {
      this.syncing = false;
      await this.refreshCounts();
    }
    if (delivered > 0) this.emit('delivered', { count: delivered });
  }

  async #replay(entry) {
    try {
      await this.http(entry.method, entry.url, {
        body: entry.body,
        headers: { ...entry.headers, [IDEMPOTENCY_HEADER]: entry.id },
      });
      await this.store.outboxDelete(entry.id);
      this.emit('replayed', { id: entry.id, entity: entry.entity, result: 'delivered' });
      return 'delivered';
    } catch (err) {
      if (isUnauthorized(err)) {
        this.#setSessionExpired(true); // pause; no attempt burnt, nothing parked
        await this.store.outboxUpdate(entry.id, { lastError: 'Session expired — enter your password to sync.' });
        return 'stop';
      }
      if (isPermanentRejection(err)) {
        await this.store.outboxUpdate(entry.id, { status: 'failed', lastError: err.message });
        this.emit('replayed', { id: entry.id, entity: entry.entity, result: 'failed', error: err.message });
        return 'next'; // a permanent rejection does not block the rest of the queue
      }
      const attempts = entry.attempts + 1;
      if (attempts >= this.maxTransientAttempts) {
        // Poison-entry guard: stop it blocking the ordered queue forever.
        await this.store.outboxUpdate(entry.id, { attempts, status: 'failed', lastError: 'Failed after several attempts — check and retry.' });
        return 'next';
      }
      await this.store.outboxUpdate(entry.id, {
        attempts,
        nextAttemptAt: this.now() + backoffMs(attempts, this.backoffBaseMs),
        lastError: 'Server unreachable — retrying automatically.',
      });
      this.emit('replayed', { id: entry.id, entity: entry.entity, result: 'retry', attempts });
      return 'stop';
    }
  }

  /** User action: put a failed entry back in the queue and replay now. */
  async retry(id) {
    await this.store.outboxUpdate(id, { status: 'pending', attempts: 0, nextAttemptAt: 0, lastError: '' });
    await this.refreshCounts();
    await this.flush();
  }

  /** User action: explicitly give up on a FAILED entry. Pending entries can never be dropped. */
  async abandon(id) {
    const row = (await this.store.outboxSummary()).find(r => r.id === id);
    if (!row) return;
    if (row.status === 'pending') throw new Error('A pending entry cannot be abandoned — it will be sent automatically.');
    await this.store.outboxDelete(id);
    await this.refreshCounts();
  }

  /** Logout guard: refuse while anything is unsent or failed (tries to flush first). */
  async logoutBlocked() {
    if (this.store.mode === 'foreign') return false;
    let n = (await this.store.outboxSummary()).length;
    if (n > 0 && this.isOnline() && this.store.unlocked) {
      await this.flush();
      n = (await this.store.outboxSummary()).length;
    }
    return n > 0;
  }

  /** After the unlock dialog re-authenticated (fresh token): clear backoff and resume. */
  async resumeAfterReauth() {
    this.#setSessionExpired(false);
    for (const e of await this.store.outboxList()) {
      if (e.status === 'pending' && e.nextAttemptAt > 0) await this.store.outboxUpdate(e.id, { nextAttemptAt: 0 });
    }
    await this.flush();
  }

  #setSessionExpired(value) {
    this.sessionExpired = value;
    this.emit('change');
  }

  async refreshCounts() {
    const rows = await this.store.outboxSummary();
    this.counts = {
      pending: rows.filter(r => r.status === 'pending').length,
      failed: rows.filter(r => r.status !== 'pending').length,
    };
    this.failedEntries = this.store.unlocked
      ? (await this.store.outboxList()).filter(e => e.status !== 'pending')
      : [];
    this.emit('change');
  }
}
