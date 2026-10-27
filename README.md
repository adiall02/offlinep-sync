# Offline Sync Demo

A small, **dependency-free** reference implementation of the offline-first sync pattern used in
**SankTec** (a clinical records app that must keep working when the clinic's internet drops).

It shows, end to end and runnable in one command:

| Pattern | Where |
|---|---|
| **Outbox**: writes made offline are persisted and replayed later, in order | [`public/lib/sync.js`](public/lib/sync.js) |
| **Idempotent replay**: a retried write can never be applied twice | [`server/idempotency.js`](server/idempotency.js) |
| **Encryption at rest**: no plaintext data or identifiers on the device | [`public/lib/crypto.js`](public/lib/crypto.js), [`public/lib/local-store.js`](public/lib/local-store.js) |
| **Read cache**: network first, encrypted cache fallback, flagged `fromCache` | [`public/lib/tasks.js`](public/lib/tasks.js) |
| **Honest failure handling**: transient errors retry, permanent ones are parked, nothing is silently dropped | [`public/lib/sync.js`](public/lib/sync.js) |
| **Safe multi-user devices**: never wipe unsent data, never let a different user read it | [`public/lib/local-store.js`](public/lib/local-store.js) |
| **Chaos panel**: break the server on purpose and watch the client recover | [`public/app.js`](public/app.js), [`server/server.js`](server/server.js) |

No framework, no build step, no `npm install`. Node ≥ 20 and a modern browser.

```bash
git clone https://github.com/adiall02/offlinep-sync.git
cd offlinep-sync
npm start          # → http://localhost:3000   (logins: demo/demo, alice/alice)
npm test           # 31 tests: idempotency, encryption, and full client↔server sync scenarios
```

---

## Try it in 2 minutes

1. Open <http://localhost:3000>, sign in as `demo` / `demo`.
2. Add a task. It is sent immediately (chip: `0 pending`).
3. Tick **Simulate offline**. Add two tasks. They appear instantly, tagged `pending`, and the header shows `2 pending`.
4. Untick **Simulate offline**. They are replayed in order and flip to `synced`.
5. **Lost response**: click *Commit, then drop response*, add a task. The server saves it but the client never hears back, so the client queues it. On the next sync it is replayed with the *same* idempotency key. The request log shows `(idempotent replay)` and the server still holds **one** copy.
6. **Permanent rejection**: add a task titled `x !reject`. The server answers 422. It goes to *Needs your attention* with **Retry / Abandon**. It never disappears, and it does not block the tasks behind it.
7. **Server hiccup**: click *Fail next write (503)*, then add a task while online. The write is kept in the outbox as `pending` and retried with backoff (the first retry waits 30 s; edit `backoffBaseMs` in `app.js` to speed it up).
8. **Session expiry**: click *Expire sessions (401)* with queued changes. The queue pauses and asks for your password (it does *not* log you out or drop anything), then resumes.
9. **Conflict**: queue a *Rename* while offline, click *Edit first task "elsewhere"*, reconnect. The server answers 412, and your edit is parked as failed instead of overwriting theirs.
10. **Refresh the page** while data is queued. The encryption key lived only in memory, so you get an *Unlock* dialog. A wrong password never deletes anything; 5 failures add a growing delay.
11. Try **Log out** with unsent changes. It is refused.

Open DevTools → Application → IndexedDB → `offline-sync-demo` to confirm there is only ciphertext.

---

## How it works

```
 UI ──► TasksRepo ──► SyncService.mutate()
                         │ online  ─────────────► fetch POST/PATCH  + Idempotency-Key: <uuid>
                         │ offline / transient failure
                         ▼
                   LocalStore (encrypted)           ◄── PBKDF2(password) unwraps the AES data key (memory only)
                    ├─ outbox  (id, entity, method, payload_enc, status, attempts, next_attempt_at)
                    ├─ cache   (collection, HMAC(key), payload_enc)
                    └─ meta    (owner hash, wrapped key, KDF params, failure counter)
                         │ triggers: `online` event · unlock · every 60 s · after retry/re-auth
                         ▼
                   SyncService.flush()  ── replays IN ORDER to the ORIGINAL endpoint,
                                           same Idempotency-Key ──► server IdempotencyStore
```

### 1. Replay is "re-issue the original request"

There is **no** generic `/api/sync/replay` endpoint. A queued write stores its real
`method + url + body + headers` and is simply sent again. This keeps the server's validation,
auth and business rules as the single source of truth, with no second code path to maintain.
(SankTec's first attempt used a bespoke replay endpoint that did not exist, so every queued write
404'd. See their `OFFLINE-SYNC-DESIGN.md`.)

### 2. The outbox id *is* the idempotency key

`mutate()` generates a UUID, sends it as `Idempotency-Key`, and if the request needs queueing it
stores the **same** UUID as the outbox row id. Whichever attempt reaches the server first wins; every
later attempt gets the stored response back. This also fixes the ambiguous case: a request that
timed out may or may not have been applied, so queueing it and replaying is always safe.

Server rules ([`server/idempotency.js`](server/idempotency.js), ported from SankTec's `IdempotencyFilter.cs`):

| Situation | Behaviour |
|---|---|
| First request with a key | Key is **reserved before** the handler runs, then the result is stored |
| Same key, same request again | Stored response replayed, header `Idempotency-Replayed: true` |
| Same key **while the first is still running** | Waits for it, replays it (or `429` if it takes too long) so it never runs twice |
| Same key, **different** method/path/body | `422`. Replaying another request's response would silently skip this write |
| Result is `5xx` or an exception | Key is **released**; the client's retry really runs |
| `2xx` / `4xx` | Memoized |
| Keys are per user and expire (7 days) | |

The body hash is canonical (key order and whitespace don't matter).

### 3. Which errors retry and which stop

This is the most important policy in the engine ([`sync.js`](public/lib/sync.js)):

| Outcome of a replay | Meaning | Action |
|---|---|---|
| Network error, timeout, `5xx` | Server/transport problem | Keep `pending`, exponential backoff (30 s → 30 min), **stop the loop** to preserve order |
| `401` | Token expired while offline | **Pause** the queue, ask for the password, resume. No attempt burnt, nothing parked |
| `408`, `429` | Transient | Same as network error |
| Any other `4xx` (400/404/409/412/422…) | The payload will *never* succeed | Mark `failed`, surface to the user, **continue** with the rest |
| 8 consecutive transient failures | Poison entry | Escalate to `failed` so it can't block the queue forever |

**Nothing is dropped automatically.** Failed entries wait for an explicit **Retry** or **Abandon**
(only *failed* entries can be abandoned; pending ones can't). The old SankTec code deleted entries
after 3 attempts, which is the data-loss bug this design exists to prevent.

Strict ordering: an entry still in backoff blocks the ones behind it, because replaying a later
update against stale state could corrupt data.

### 4. Encrypted local store

Everything on disk is ciphertext, and the backend never sees plaintext
([`local-store.js`](public/lib/local-store.js), [`crypto.js`](public/lib/crypto.js)):

- A random 256-bit **AES-GCM data key** per device encrypts every payload (`base64(iv ‖ ciphertext)`, fresh IV each time).
- The data key is **wrapped** by a key derived from the user's password (**PBKDF2-SHA256**, random salt; the demo uses 310 000 iterations) and stored in `meta`.
- The unwrapped key is a **non-extractable `CryptoKey` held in memory only**. After a refresh the user re-enters their password (works offline: the check is "can I unwrap the key?").
- Outbox `url`, `body`, `headers` and `last_error` live **inside** the encrypted payload. Only scheduling columns are plaintext.
- Cache keys are an **HMAC** of the record id, so even ids aren't readable from the file.

### 5. One owner per device; never wipe

| Situation | Result |
|---|---|
| Same user logs in again | Unlock |
| Different user, **empty** outbox | Fresh store for them |
| Different user, **unsent data** from someone else | `foreign` mode: online-only, the other user's data is kept untouched and unreadable |
| Wrong password | Never wipes. After 5 failures, delays of 30 s, 1 m, 2 m… |
| Log out with pending/failed entries | **Refused** (it tries a flush first when online) |

### 6. Reading while offline

`TasksRepo.load()` is network-first with write-through caching, so the encrypted cache always holds
the last good snapshot. Offline it returns that snapshot with `fromCache: true` (the UI shows an
"offline data" chip). `TasksRepo.view()` then overlays still-queued writes onto the list
(optimistic UI), each row marked `pending` / `failed` / `synced`. Reads are never queued.

### 7. Conflicts

| Write | Policy |
|---|---|
| Toggle done | Last writer wins (no precondition) |
| Rename | `If-Match: <version>`. If the server copy changed, `412` → parked as failed with the server's message, never overwritten |
| Create | Client generates the id, so the optimistic row and the server row are the same row; duplicates are impossible thanks to the idempotency key |

---

## Project layout

```
server/
  server.js        Plain node:http API + static files + chaos/debug endpoints
  idempotency.js   The idempotency layer (no framework, drop-in for any handler)
public/
  index.html, style.css, app.js     UI wiring only
  sw.js                             App-shell service worker (page loads offline; no API caching)
  lib/
    crypto.js         WebCrypto helpers (AES-GCM, PBKDF2, HMAC)
    backends.js       MemoryBackend + IndexedDbBackend (same interface)
    local-store.js    Encrypted outbox / cache / meta, owner + lockout rules
    http.js           fetch wrapper: token, timeout, simulated-offline hook
    sync.js           The engine: mutate / flush / retry / abandon / logout guard
    tasks.js          Example feature: read-with-fallback, optimistic view, writes
    emitter.js        Tiny event emitter (stand-in for signals)
test/                 node:test: idempotency, local-store, and end-to-end scenarios
```

All client modules are plain ES modules with **no DOM access at import time**, which is why the
tests run them in Node against the real server.

## API (demo server)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/login` | `{username,password}` → `{token,userId}` |
| GET | `/api/tasks` | `{serverTime, tasks[]}` for the signed-in user |
| POST | `/api/tasks` | `{id?, title}`; `422` if title contains `!reject` (demo rule) |
| PATCH | `/api/tasks/:id` | `{done?, title?}`; honours `If-Match` |
| GET/POST | `/api/_debug`, `/api/_chaos`, `/api/_debug/edit` | Demo only: server view, fault injection |

Chaos switches (`POST /api/_chaos`): `failNext: n` (503 before commit), `dropResponseNext: n`
(commit, then kill the socket), `expireSessions: true`, `latencyMs: n`.

## Replicating this in your own project

You need three pieces. Copy them, then replace the example feature.

**Server**
1. Accept an `Idempotency-Key` header on every non-idempotent endpoint. Copy
   [`server/idempotency.js`](server/idempotency.js) or port it: in a real database use a unique
   index on `(user_id, key)`, an `INSERT` to reserve, and store `{method, path, request_hash, status, body, expires_at}`.
2. Return proper status codes. The client relies on the split: `5xx`/`408`/`429` retry, other `4xx` are permanent.
3. (Optional) Add `If-Match`/ETag for updates that must not overwrite.

**Client**
1. Copy `crypto.js`, `backends.js`, `local-store.js`, `http.js`, `sync.js`, `emitter.js`.
2. Route **every mutation** through `sync.mutate(entity, method, url, body, headers)`. Never call `fetch` directly for writes.
3. For reads, copy the `load()` pattern in `tasks.js`: network first, `cachePut`, fall back to `cacheGet`.
4. Start triggers (see the bottom of `app.js`): `online` event, after unlock, a timer, and after retry or re-auth.
5. Add UI for: pending/failed counts, the failed list (Retry/Abandon), the unlock dialog (also used for 401), and the logout guard.

**Porting to a framework**: `SyncService` and `LocalStore` are framework-free and expose
`on('change')`. In Angular, wrap them with signals (this is what SankTec does); in React, a
`useSyncExternalStore` over the emitter.

**Swapping the storage**: implement the backend interface at the top of `backends.js` (SankTec uses
SQLite WASM on OPFS inside a worker). Backends only see opaque strings, so crypto and sync are unaffected.

## How this maps to SankTec

| Demo | SankTec (`SankTec.UI` / `SankTec.Api`) |
|---|---|
| `lib/sync.js` | `core/services/sync.service.ts` |
| `lib/local-store.js`, `lib/crypto.js` | `core/services/local-store.service.ts`, `core/offline/crypto.util.ts` |
| `lib/backends.js` (IndexedDB) | `core/offline/sqlite.worker.ts` (SQLite WASM + OPFS) |
| `lib/tasks.js` | `PullService` + per-feature services (vitals, encounters, …) |
| `server/idempotency.js` | `SankTec.Api/Filters/IdempotencyFilter.cs` |
| Demo has no equivalent | `/api/sync/report` admin telemetry, `/api/sync/changes` delta pull, second-tab lock, 5-minute pull timer |

## Honest limitations (it's a demo)

- Server state is **in memory** (restart = empty). Swap in a database; keep the idempotency table in the same transaction as the write.
- Auth is a toy token. Real systems should use short-lived access tokens plus refresh and tie the unlock password to it (SankTec has an open item for OIDC unlock).
- The pull is a full list. For large data sets use a delta endpoint (`GET /changes?since=<serverTime>`); the repo already stores `serverTime` for that.
- One tab only is assumed. Use a Web Lock / `BroadcastChannel` to block a second tab (SankTec does).
- IndexedDB persistence can be evicted by the browser; call `navigator.storage.persist()` in production.
- Key loss (e.g. a server-side password reset) makes rows undecryptable. They're kept and reported as `unrecoverable`, never silently deleted.
- A queued rename uses the version it saw. Several queued renames of one task can conflict with each other. Coalesce them if that matters to you.

## License

MIT
