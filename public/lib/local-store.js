import {
  aesDecryptBytes, aesDecryptJson, aesEncryptBytes, aesEncryptJson, base64ToBytes, bytesToBase64,
  deriveKek, hmacHex, importDataKey, importHmacKey, randomBytes, sha256Hex,
} from './crypto.js';
import { Emitter } from './emitter.js';

const MAX_FREE_FAILURES = 5;

/**
 * Encrypted local store: outbox + read cache + meta, on top of any backend (see backends.js).
 * Port of SankTec's LocalStoreService with its beta rules:
 *
 *  - One owner per device. `open()` decides the mode:
 *      'unlocked' — owner's password unwrapped the data key (key lives in memory only)
 *      'locked'   — owner known, waiting for the password (e.g. after a page refresh)
 *      'foreign'  — someone else's UNSENT data is on the device: online-only mode, data is kept
 *  - A different user logging in on a device with an EMPTY outbox gets a fresh store.
 *  - Wrong passwords never wipe anything; repeated failures add a growing delay.
 *  - Outbox rows keep only non-sensitive scheduling columns in the clear; url, body, headers
 *    and last error live inside `payloadEnc`. Cache keys are HMACs, never raw ids.
 */
export class LocalStore extends Emitter {
  /** @param {import('./backends.js').MemoryBackend} backend */
  constructor(backend, { kdfIterations = 310_000, now = () => Date.now() } = {}) {
    super();
    this.backend = backend;
    this.kdfIterations = kdfIterations;
    this.now = now;
    this.mode = 'locked';
    this.persistent = false;
    this.dataKey = null;
    this.hmacKey = null;
    this.lastQueuedAt = 0;
  }

  get unlocked() { return this.mode === 'unlocked'; }

  async init() {
    this.persistent = (await this.backend.init()).persistent;
  }

  /**
   * Called at login (with a password) or app start. Never throws on a wrong password —
   * returns { ok:false, reason }.
   */
  async open(userId, password) {
    const ownerHash = await sha256Hex(`owner:${userId}`);
    const storedOwner = await this.backend.metaGet('owner');

    if (storedOwner && storedOwner !== ownerHash) {
      if ((await this.backend.outboxAll()).length > 0) {
        this.#setMode('foreign');
        return { ok: true, mode: 'foreign' };
      }
      await this.backend.clearData(); // nothing unsent: safe to hand the device to a new user
    }
    if (!(await this.backend.metaGet('owner'))) return this.#setup(ownerHash, password);
    return this.unlock(password);
  }

  async #setup(ownerHash, password) {
    const raw = randomBytes(32);
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, this.kdfIterations);
    await this.backend.metaSet('owner', ownerHash);
    await this.backend.metaSet('kdf', JSON.stringify({ salt: bytesToBase64(salt), iterations: this.kdfIterations }));
    await this.backend.metaSet('wrappedKey', await aesEncryptBytes(kek, raw));
    await this.#activate(raw);
    return { ok: true, mode: 'unlocked' };
  }

  /** Password check is local and works offline: it is just "can I unwrap the data key?". */
  async unlock(password) {
    const lockedUntil = Number(await this.backend.metaGet('lockedUntil') ?? 0);
    if (lockedUntil > this.now()) return { ok: false, reason: 'throttled', lockedUntil };
    try {
      const { salt, iterations } = JSON.parse(await this.backend.metaGet('kdf'));
      const kek = await deriveKek(password, base64ToBytes(salt), iterations);
      const raw = await aesDecryptBytes(kek, await this.backend.metaGet('wrappedKey'));
      await this.backend.metaDelete('failures');
      await this.#activate(raw);
      return { ok: true, mode: 'unlocked' };
    } catch {
      const failures = Number(await this.backend.metaGet('failures') ?? 0) + 1;
      await this.backend.metaSet('failures', String(failures));
      if (failures >= MAX_FREE_FAILURES) {
        // 30s, 1m, 2m, 4m … capped at 30m. Data is NEVER wiped on failure.
        const delay = Math.min(30_000 * 2 ** (failures - MAX_FREE_FAILURES), 30 * 60_000);
        await this.backend.metaSet('lockedUntil', String(this.now() + delay));
      }
      return { ok: false, reason: 'wrong-password', failures };
    }
  }

  async #activate(raw) {
    this.dataKey = await importDataKey(raw);
    this.hmacKey = await importHmacKey(raw);
    raw.fill(0);
    this.#setMode('unlocked');
  }

  /** Forget the key (logout / lock screen). Encrypted data stays on disk. */
  lock() {
    this.dataKey = null;
    this.hmacKey = null;
    this.#setMode('locked');
  }

  #setMode(mode) {
    this.mode = mode;
    this.emit('mode', mode);
  }

  #requireKey() {
    if (!this.dataKey) throw new Error('Local store is locked.');
    return this.dataKey;
  }

  // ── Outbox ─────────────────────────────────────────────────────────────────

  /** @returns {Promise<string>} the new entry id (doubles as the Idempotency-Key). */
  async outboxAdd({ id, entity, method, url, body, headers }) {
    const key = this.#requireKey();
    // Strictly increasing so same-millisecond writes keep their order.
    this.lastQueuedAt = Math.max(this.now(), this.lastQueuedAt + 1);
    await this.backend.outboxInsert({
      id, entity, method,
      payloadEnc: await aesEncryptJson(key, { url, body, headers: headers ?? {}, lastError: '' }),
      queuedAt: this.lastQueuedAt, attempts: 0, status: 'pending', nextAttemptAt: 0,
    });
    this.emit('outbox');
    return id;
  }

  /** Decrypted entries (needs the key), oldest first. */
  async outboxList() {
    const key = this.#requireKey();
    const rows = await this.backend.outboxAll();
    return Promise.all(rows.map(async row => {
      try {
        return { ...row, ...(await aesDecryptJson(key, row.payloadEnc)) };
      } catch {
        // Encrypted with a key we can no longer derive (e.g. server-side password reset).
        return { ...row, status: 'unrecoverable', url: '', body: null, headers: {}, lastError: '' };
      }
    }));
  }

  /** Metadata only — readable while locked (counts for the badge, logout guard). */
  outboxSummary() { return this.backend.outboxAll(); }

  /** patch: attempts / status / nextAttemptAt (plain columns) and lastError (re-encrypted). */
  async outboxUpdate(id, patch) {
    const { lastError, ...columns } = patch;
    if (lastError !== undefined) {
      const key = this.#requireKey();
      const row = (await this.backend.outboxAll()).find(r => r.id === id);
      if (row) {
        const payload = await aesDecryptJson(key, row.payloadEnc);
        columns.payloadEnc = await aesEncryptJson(key, { ...payload, lastError });
      }
    }
    await this.backend.outboxUpdate(id, columns);
    this.emit('outbox');
  }

  async outboxDelete(id) {
    await this.backend.outboxDelete(id);
    this.emit('outbox');
  }

  // ── Read cache (write-through) ─────────────────────────────────────────────

  async cachePut(collection, id, value) {
    const key = this.#requireKey();
    await this.backend.cachePut(collection, await hmacHex(this.hmacKey, id), await aesEncryptJson(key, value), this.now());
  }

  async cacheGet(collection, id) {
    const key = this.#requireKey();
    const enc = await this.backend.cacheGet(collection, await hmacHex(this.hmacKey, id));
    if (!enc) return null;
    try { return await aesDecryptJson(key, enc); } catch { return null; }
  }
}
