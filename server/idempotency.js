import { createHash } from 'node:crypto';

/**
 * Idempotency layer — a port of SankTec's IdempotencyFilter.cs.
 *
 * Contract:
 *  - Only POST/PATCH carrying an `Idempotency-Key` header are affected.
 *  - The key is RESERVED (status 0 = in progress) before the handler runs, so a concurrent
 *    duplicate never executes twice: it waits for the first result, or gets a transient 429.
 *  - Keys are scoped per user and bound to ONE request (method + path + body hash). Reusing a
 *    key for something else is a 422, never a silent "success" that skips the write.
 *  - Successful and 4xx results are memoized and replayed with `Idempotency-Replayed: true`.
 *  - 5xx / exceptions release the key so the client can retry for real.
 *  - Records expire after a retention window (7 days by default).
 */
export class IdempotencyStore {
  constructor({ retentionMs = 7 * 24 * 3600_000, inProgressWaitMs = 10_000, pollMs = 25 } = {}) {
    this.records = new Map(); // `${userId}|${key}` -> record
    this.retentionMs = retentionMs;
    this.inProgressWaitMs = inProgressWaitMs;
    this.pollMs = pollMs;
  }

  /** Snapshot for the demo's "server view" panel. */
  list() {
    return [...this.records.values()].map(r => ({
      key: r.key, userId: r.userId, method: r.method, path: r.path, status: r.status,
    }));
  }

  /**
   * Runs `handler` at most once per (user, key).
   * @param {{method:string, path:string, key:string|undefined, userId:string, body:unknown}} req
   * @param {() => Promise<{status:number, body?:unknown}>} handler
   * @returns {Promise<{status:number, body?:unknown, replayed?:boolean}>}
   */
  async run(req, handler) {
    const { method, path, key, userId, body } = req;
    if (!key || (method !== 'POST' && method !== 'PATCH')) return handler();
    if (key.length > 128) return { status: 400, body: { error: 'Idempotency-Key too long (max 128).' } };

    const id = `${userId}|${key}`;
    const hash = hashBody(body);

    let existing = this.records.get(id);
    if (existing && existing.expiresAt <= Date.now()) {
      this.records.delete(id); // expired: the key may be used again
      existing = undefined;
    }

    if (!existing) {
      // Synchronous check-then-set: JS is single threaded, so this IS the atomic reservation.
      // (In a real DB this is a unique index + INSERT; the loser of the race gets a conflict.)
      const reservation = {
        key, userId, method, path, hash,
        status: 0, body: undefined, expiresAt: Date.now() + this.retentionMs,
      };
      this.records.set(id, reservation);
      let result;
      try {
        result = await handler();
      } catch (err) {
        this.records.delete(id); // exception: stay retryable
        throw err;
      }
      if (result.status >= 500) this.records.delete(id); // 5xx: stay retryable
      else Object.assign(reservation, { status: result.status, body: result.body });
      return result;
    }

    return this.#respondToDuplicate(id, existing, { method, path, hash });
  }

  async #respondToDuplicate(id, existing, { method, path, hash }) {
    if (existing.status === 0) existing = await this.#waitForCompletion(id);
    if (!existing || existing.status === 0) {
      return { status: 429, body: { error: 'Identical request still being processed — retry shortly.' } };
    }
    const same = existing.method === method && existing.path === path && existing.hash === hash;
    if (!same) {
      return { status: 422, body: { error: 'Idempotency-Key already used for a different request.' } };
    }
    return { status: existing.status, body: existing.body, replayed: true };
  }

  async #waitForCompletion(id) {
    const deadline = Date.now() + this.inProgressWaitMs;
    let record;
    do {
      await new Promise(r => setTimeout(r, this.pollMs));
      record = this.records.get(id);
    } while (record && record.status === 0 && Date.now() < deadline);
    return record;
  }
}

/** Canonical hash: key order / whitespace in the JSON body do not matter. */
export function hashBody(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
