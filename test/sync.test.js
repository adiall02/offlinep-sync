import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const chaos = (ctx, body) => ctx.http('POST', '/api/_chaos', { body });

test('online: writes go straight to the server, nothing is queued', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const res = await ctx.repo.add('Buy milk');
  assert.equal(res.queued, false);
  assert.equal(ctx.serverTasks().length, 1);
  assert.equal((await ctx.store.outboxSummary()).length, 0);
});

test('offline: writes are queued, the UI sees them optimistically, reconnect delivers them in order', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;

  const a = await ctx.repo.add('first');
  const b = await ctx.repo.add('second');
  assert.equal(a.queued && b.queued, true);
  assert.equal(ctx.serverTasks().length, 0);

  const view = await ctx.repo.view();
  assert.deepEqual(view.tasks.map(x => [x.title, x.sync]), [['first', 'pending'], ['second', 'pending']]);

  ctx.net.online = true;
  await ctx.sync.flush();
  assert.deepEqual(ctx.serverTasks().map(x => x.title), ['first', 'second']);
  assert.equal((await ctx.store.outboxSummary()).length, 0);
});

test('offline reads fall back to the encrypted cache and are flagged fromCache', async t => {
  const ctx = await setup(); t.after(ctx.close);
  await ctx.repo.add('cached one');
  assert.equal((await ctx.repo.load()).fromCache, false); // write-through
  ctx.net.online = false;
  const offline = await ctx.repo.load();
  assert.equal(offline.fromCache, true);
  assert.deepEqual(offline.tasks.map(x => x.title), ['cached one']);
});

test('lost response after commit: the replay carries the same key, so the server creates it ONCE', async t => {
  const ctx = await setup(); t.after(ctx.close);
  await chaos(ctx, { dropResponseNext: 1 });

  const res = await ctx.repo.add('only once'); // server commits, socket dies → client queues it
  assert.equal(res.queued, true);
  assert.equal(ctx.serverTasks().length, 1);

  await ctx.sync.flush(); // replays with the same Idempotency-Key
  assert.equal(ctx.serverTasks().length, 1);
  assert.equal((await ctx.store.outboxSummary()).length, 0);
  assert.ok(ctx.app.idempotency.list().some(r => r.status === 201));
});

test('5xx is transient: entry stays pending, backs off, then succeeds', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('retry me');
  ctx.net.online = true;
  await chaos(ctx, { failNext: 1 });

  await ctx.sync.flush();
  let [row] = await ctx.store.outboxSummary();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt > 0);

  await new Promise(r => setTimeout(r, 10)); // backoff (1ms base in tests) elapses
  await ctx.sync.flush();
  assert.equal((await ctx.store.outboxSummary()).length, 0);
  assert.equal(ctx.serverTasks().length, 1);
});

test('entry still in backoff blocks the ones behind it (strict ordering)', async t => {
  const ctx = await setup({ syncOptions: { backoffBaseMs: 60_000 } }); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('one');
  await ctx.repo.add('two');
  ctx.net.online = true;
  await chaos(ctx, { failNext: 1 });
  await ctx.sync.flush(); // 'one' fails transiently → loop stops
  await ctx.sync.flush(); // still in backoff → nothing is sent, 'two' must not jump ahead
  assert.equal(ctx.serverTasks().length, 0);
});

test('permanent 4xx parks the entry as failed, does not block the queue, and is never dropped', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('bad !reject');
  await ctx.repo.add('good');
  ctx.net.online = true;
  await ctx.sync.flush();

  assert.deepEqual(ctx.serverTasks().map(x => x.title), ['good']);
  const [failed] = ctx.sync.failedEntries;
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError, /Rejected by business rule/);

  const view = await ctx.repo.view();
  assert.equal(view.tasks.find(x => x.title === 'bad !reject').sync, 'failed');
});

test('retry re-queues a failed entry; abandon removes only failed ones, never pending', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  const { id: pendingId } = await ctx.repo.add('later');
  await assert.rejects(ctx.sync.abandon(pendingId), /cannot be abandoned/);

  await ctx.repo.add('x !reject');
  ctx.net.online = true;
  await ctx.sync.flush();
  const failedId = ctx.sync.failedEntries[0].id;
  await ctx.sync.retry(failedId);
  assert.equal(ctx.sync.failedEntries.length, 1); // rejected again, still parked
  await ctx.sync.abandon(failedId);
  assert.equal(ctx.sync.failedEntries.length, 0);
});

test('412 precondition failure (edited elsewhere) is parked as a conflict, not overwritten', async t => {
  const ctx = await setup(); t.after(ctx.close);
  await ctx.repo.add('shared');
  const task = (await ctx.repo.load()).tasks[0];

  ctx.net.online = false;
  await ctx.repo.rename(task, 'my edit');
  ctx.net.online = true; // someone else edits on the server while we were offline
  await ctx.http('POST', '/api/_debug/edit', { body: { id: task.id, title: 'their edit' } });
  await ctx.sync.flush();

  assert.equal(ctx.serverTasks()[0].title, 'their edit');
  assert.equal(ctx.sync.failedEntries[0].status, 'failed');
});

test('401 pauses the queue without burning attempts; resume after re-login delivers', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('survives expiry');
  ctx.net.online = true;
  await chaos(ctx, { expireSessions: true });

  await ctx.sync.flush();
  assert.equal(ctx.sync.sessionExpired, true);
  const [row] = await ctx.store.outboxSummary();
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);

  await ctx.login(); // user typed the password again
  await ctx.sync.resumeAfterReauth();
  assert.equal(ctx.serverTasks().length, 1);
  assert.equal(ctx.sync.sessionExpired, false);
});

test('logout is blocked while anything is unsent, allowed once the queue drains', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('unsent');
  assert.equal(await ctx.sync.logoutBlocked(), true);
  ctx.net.online = true;
  assert.equal(await ctx.sync.logoutBlocked(), false); // flushes first, then re-checks
  assert.equal(ctx.serverTasks().length, 1);
});

test('replaying the same outbox entry twice never duplicates (crash between send and delete)', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('crashy');
  ctx.net.online = true;
  const [entry] = await ctx.store.outboxList();
  // Simulate: request delivered, app crashed before outboxDelete → entry replays on next start.
  await ctx.http(entry.method, entry.url, { body: entry.body, headers: { 'Idempotency-Key': entry.id } });
  await ctx.sync.flush();
  assert.equal(ctx.serverTasks().length, 1);
  assert.equal((await ctx.store.outboxSummary()).length, 0);
});

test('foreign mode: another user\'s unsent data stays untouched and the new user is online-only', async t => {
  const ctx = await setup(); t.after(ctx.close);
  ctx.net.online = false;
  await ctx.repo.add('alice-ish data');
  const { LocalStore } = await import('../public/lib/local-store.js');
  const other = new LocalStore(ctx.backend, { kdfIterations: 1000 });
  await other.init();
  await other.open('someone-else', 'pw');
  assert.equal(other.mode, 'foreign');
  const { SyncService } = await import('../public/lib/sync.js');
  const sync2 = new SyncService({ store: other, http: ctx.http, isOnline: () => ctx.net.online });
  await assert.rejects(sync2.mutate('task', 'POST', '/api/tasks', { id: 'x', title: 'y' }), /only save while online/);
  assert.equal(ctx.backend.outbox.size, 1);
});
