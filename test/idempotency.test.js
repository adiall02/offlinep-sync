import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyStore } from '../server/idempotency.js';

const req = (over = {}) => ({ method: 'POST', path: '/api/tasks', key: 'k1', userId: 'u1', body: { title: 'a' }, ...over });

test('runs the handler once and replays the stored response for the same key', async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const handler = async () => ({ status: 201, body: { n: ++calls } });
  const first = await store.run(req(), handler);
  const second = await store.run(req(), handler);
  assert.equal(calls, 1);
  assert.deepEqual(second.body, first.body);
  assert.equal(second.replayed, true);
});

test('requests without a key, and GETs, are never memoized', async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const handler = async () => ({ status: 200, body: ++calls });
  await store.run(req({ key: undefined }), handler);
  await store.run(req({ key: undefined }), handler);
  await store.run(req({ method: 'GET' }), handler);
  await store.run(req({ method: 'GET' }), handler);
  assert.equal(calls, 4);
});

test('key reused for a different body or path is a 422, not a silent success', async () => {
  const store = new IdempotencyStore();
  await store.run(req(), async () => ({ status: 201 }));
  const otherBody = await store.run(req({ body: { title: 'b' } }), async () => ({ status: 201 }));
  const otherPath = await store.run(req({ path: '/api/other' }), async () => ({ status: 201 }));
  assert.equal(otherBody.status, 422);
  assert.equal(otherPath.status, 422);
});

test('JSON key order does not change the request hash', async () => {
  const store = new IdempotencyStore();
  await store.run(req({ body: { a: 1, b: 2 } }), async () => ({ status: 201 }));
  const again = await store.run(req({ body: { b: 2, a: 1 } }), async () => ({ status: 201 }));
  assert.equal(again.replayed, true);
});

test('keys are scoped per user', async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const handler = async () => ({ status: 201, body: ++calls });
  await store.run(req({ userId: 'u1' }), handler);
  await store.run(req({ userId: 'u2' }), handler);
  assert.equal(calls, 2);
});

test('5xx and exceptions release the key so a retry really runs', async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  await store.run(req(), async () => { calls++; return { status: 503 }; });
  await assert.rejects(store.run(req(), async () => { calls++; throw new Error('boom'); }));
  const ok = await store.run(req(), async () => { calls++; return { status: 201 }; });
  assert.equal(calls, 3);
  assert.equal(ok.status, 201);
});

test('4xx results ARE memoized (the same bad request keeps getting the same answer)', async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  await store.run(req(), async () => { calls++; return { status: 422, body: { error: 'no' } }; });
  const again = await store.run(req(), async () => { calls++; return { status: 201 }; });
  assert.equal(calls, 1);
  assert.equal(again.status, 422);
});

test('a concurrent duplicate waits for the first request instead of executing twice', async () => {
  const store = new IdempotencyStore({ pollMs: 5 });
  let calls = 0;
  const slow = async () => { calls++; await new Promise(r => setTimeout(r, 60)); return { status: 201, body: 'x' }; };
  const [a, b] = await Promise.all([store.run(req(), slow), store.run(req(), slow)]);
  assert.equal(calls, 1);
  assert.equal(a.status, 201);
  assert.equal(b.replayed, true);
});

test('a duplicate that outwaits the first request gets a transient 429', async () => {
  const store = new IdempotencyStore({ pollMs: 5, inProgressWaitMs: 20 });
  const slow = async () => { await new Promise(r => setTimeout(r, 120)); return { status: 201 }; };
  const first = store.run(req(), slow);
  const dup = await store.run(req(), slow);
  assert.equal(dup.status, 429);
  await first;
});

test('expired records free the key', async () => {
  const store = new IdempotencyStore({ retentionMs: 1 });
  let calls = 0;
  const handler = async () => ({ status: 201, body: ++calls });
  await store.run(req(), handler);
  await new Promise(r => setTimeout(r, 5));
  await store.run(req(), handler);
  assert.equal(calls, 2);
});
