import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../public/lib/backends.js';
import { LocalStore } from '../public/lib/local-store.js';

const make = async (backend = new MemoryBackend()) => {
  const store = new LocalStore(backend, { kdfIterations: 1000 });
  await store.init();
  return { store, backend };
};
const entry = (id = 'e1') => ({ id, entity: 'task', method: 'POST', url: '/api/tasks', body: { title: 'Secret diagnosis' }, headers: {} });

test('payloads are encrypted at rest: no plaintext in the backend', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  await store.cachePut('tasks', 'task-id-123', { title: 'Secret diagnosis' });
  const dump = JSON.stringify([...backend.outbox.values(), ...backend.cache.entries(), ...backend.meta.entries()]);
  assert.ok(!dump.includes('Secret diagnosis'));
  assert.ok(!dump.includes('/api/tasks'));
  assert.ok(!dump.includes('task-id-123'));
});

test('outbox and cache round-trip through encryption', async () => {
  const { store } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  await store.cachePut('tasks', 'k', { a: 1 });
  const [e] = await store.outboxList();
  assert.equal(e.body.title, 'Secret diagnosis');
  assert.deepEqual(await store.cacheGet('tasks', 'k'), { a: 1 });
});

test('same-millisecond writes keep their order', async () => {
  const { store } = await make();
  await store.open('u1', 'pw');
  for (const id of ['a', 'b', 'c']) await store.outboxAdd(entry(id));
  assert.deepEqual((await store.outboxList()).map(e => e.id), ['a', 'b', 'c']);
});

test('after lock() the data stays but needs the password again; works with no network at all', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  store.lock();
  await assert.rejects(store.outboxList(), /locked/);
  assert.equal((await store.outboxSummary()).length, 1); // counts readable while locked
  const fresh = new LocalStore(backend, { kdfIterations: 1000 }); // simulates a page refresh
  await fresh.init();
  assert.equal((await fresh.open('u1', 'pw')).ok, true);
  assert.equal((await fresh.outboxList()).length, 1);
});

test('a wrong password never wipes data and is throttled after 5 failures', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  store.lock();
  for (let i = 0; i < 5; i++) assert.equal((await store.unlock('nope')).reason, 'wrong-password');
  assert.equal((await store.unlock('pw')).reason, 'throttled'); // even the right one, until the delay passes
  assert.equal(backend.outbox.size, 1);
  store.now = () => Date.now() + 60_000;
  assert.equal((await store.unlock('pw')).ok, true);
});

test('a different user with unsent data on the device gets online-only "foreign" mode and nothing is wiped', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  const other = new LocalStore(backend, { kdfIterations: 1000 });
  await other.init();
  assert.deepEqual(await other.open('u2', 'pw2'), { ok: true, mode: 'foreign' });
  assert.equal(other.unlocked, false);
  assert.equal(backend.outbox.size, 1);
});

test('a different user on a device with an EMPTY outbox gets a fresh store', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.cachePut('tasks', 'k', { a: 1 });
  const other = new LocalStore(backend, { kdfIterations: 1000 });
  await other.init();
  assert.equal((await other.open('u2', 'pw2')).mode, 'unlocked');
  assert.equal(await other.cacheGet('tasks', 'k'), null);
});

test('rows that cannot be decrypted surface as unrecoverable instead of throwing or vanishing', async () => {
  const { store, backend } = await make();
  await store.open('u1', 'pw');
  await store.outboxAdd(entry());
  backend.outbox.get('e1').payloadEnc = 'AAAA' + backend.outbox.get('e1').payloadEnc.slice(4);
  const [e] = await store.outboxList();
  assert.equal(e.status, 'unrecoverable');
});
