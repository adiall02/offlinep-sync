// Wiring + UI. All the interesting logic lives in /lib; this file only connects it to the DOM.
import { IndexedDbBackend, MemoryBackend } from './lib/backends.js';
import { LocalStore } from './lib/local-store.js';
import { createHttp, HttpError } from './lib/http.js';
import { SyncService } from './lib/sync.js';
import { TasksRepo } from './lib/tasks.js';

const $ = id => document.getElementById(id);
const FLUSH_INTERVAL_MS = 60_000;

// ── Wiring ───────────────────────────────────────────────────────────────────
const net = { simulatedOffline: false };
const isOnline = () => navigator.onLine && !net.simulatedOffline;
const session = JSON.parse(sessionStorage.getItem('session') ?? 'null'); // { token, userId, username }
const setSession = s => { Object.assign(state, { session: s }); s ? sessionStorage.setItem('session', JSON.stringify(s)) : sessionStorage.removeItem('session'); };
const state = { session, view: null };

const http = createHttp({ getToken: () => state.session?.token, isOnline });
const rawFetch = createHttp({ getToken: () => null }); // god's-eye calls: ignore the simulated outage

let store;
try {
  store = new LocalStore(new IndexedDbBackend());
  await store.init();
} catch {
  store = new LocalStore(new MemoryBackend()); // IndexedDB blocked (private mode): data dies with the tab
  await store.init();
}
const sync = new SyncService({ store, http, isOnline });
const repo = new TasksRepo({ http, store, sync });

// ── Logging ──────────────────────────────────────────────────────────────────
const eventsLog = [];
function logEvent(text) {
  eventsLog.push(`${new Date().toLocaleTimeString()}  ${text}`);
  $('events').textContent = eventsLog.slice(-60).join('\n');
  $('events').scrollTop = $('events').scrollHeight;
}
sync.on('replayed', e => logEvent(`replay ${e.entity} ${e.id.slice(0, 8)}… → ${e.result}${e.error ? ` (${e.error})` : ''}${e.attempts ? ` attempt ${e.attempts}` : ''}`));
sync.on('delivered', e => { logEvent(`${e.count} queued write(s) delivered — refreshing`); refresh(); });
sync.on('change', () => { renderStatus(); maybePromptReauth(); });
store.on('mode', () => renderStatus());

// ── Auth dialog (login · unlock after refresh · re-auth after 401) ──────────
let authMode = 'login';
function showAuth(mode, hint = '') {
  authMode = mode;
  $('auth-title').textContent = { login: 'Sign in', unlock: 'Unlock', reauth: 'Session expired' }[mode];
  $('auth-hint').textContent = hint;
  $('auth-user-row').hidden = mode !== 'login';
  $('auth-error').hidden = true;
  $('auth-pass').value = mode === 'login' ? 'demo' : ''; // demo convenience only
  if (!$('auth').open) $('auth').showModal();
  $('auth-pass').focus();
}
const authError = msg => { $('auth-error').textContent = msg; $('auth-error').hidden = false; };

$('auth').addEventListener('cancel', e => e.preventDefault()); // can't be skipped
$('auth-form').addEventListener('submit', async e => {
  e.preventDefault();
  const password = $('auth-pass').value;
  try {
    if (authMode === 'login') {
      if (!isOnline()) return authError('First sign-in needs a connection.');
      const res = await http('POST', '/api/login', { body: { username: $('auth-user').value, password } });
      setSession({ token: res.token, userId: res.userId, username: res.username });
      const opened = await store.open(res.userId, password);
      if (!opened.ok) return authError(openFailure(opened));
    } else {
      // Unlock is a LOCAL check (unwrap the data key) — it works with no network at all.
      if (store.mode !== 'unlocked') {
        const unlocked = await store.unlock(password);
        if (!unlocked.ok) return authError(openFailure(unlocked));
      }
      // If we can reach the server, also get a fresh token (handles the expired-session case).
      if (isOnline()) {
        try {
          const res = await http('POST', '/api/login', { body: { username: state.session.username, password } });
          setSession({ ...state.session, token: res.token });
        } catch (err) {
          if (err instanceof HttpError && err.status === 401) return authError('Wrong password for the server.');
        }
      }
    }
    $('auth').close();
    await onUnlocked();
  } catch (err) {
    authError(err.message);
  }
});

function openFailure(r) {
  if (r.reason === 'throttled') return `Too many attempts. Try again at ${new Date(r.lockedUntil).toLocaleTimeString()}.`;
  return 'Wrong password. (Your data is safe — nothing is deleted on a wrong password.)';
}

/** Expired token seen by the sync engine → ask for the password instead of logging out. */
function maybePromptReauth() {
  if (sync.sessionExpired && !$('auth').open && store.unlocked) {
    showAuth('reauth', 'Your queued changes are safe. Enter your password to resume syncing.');
  }
}

async function onUnlocked() {
  await sync.refreshCounts();
  if (state.session) await sync.resumeAfterReauth();
  await refresh();
}

// ── Triggers: every way the queue gets another chance to drain ──────────────
async function syncNow() {
  await sync.flush();
  await refresh();
}
addEventListener('online', () => { logEvent('browser reports online'); syncNow(); });
addEventListener('offline', () => logEvent('browser reports offline'));
setInterval(() => syncNow(), FLUSH_INTERVAL_MS);
$('sim-offline').addEventListener('change', e => {
  net.simulatedOffline = e.target.checked;
  logEvent(net.simulatedOffline ? 'simulated OFFLINE' : 'simulated ONLINE');
  renderStatus();
  if (!net.simulatedOffline) syncNow(); else refresh();
});

// ── Rendering ────────────────────────────────────────────────────────────────
async function refresh() {
  if (store.mode === 'foreign') {
    $('banner').hidden = false;
    $('banner').textContent = 'Another user has unsent data on this device. You are in online-only mode; nothing was deleted.';
  } else if ($('banner').textContent.startsWith('Another user')) $('banner').hidden = true;
  try {
    state.view = await repo.view();
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) { sync.sessionExpired = true; sync.emit('change'); }
    else logEvent(`load failed: ${err.message}`);
  }
  renderTasks();
  renderStatus();
}

function renderStatus() {
  const online = isOnline();
  Object.assign($('chip-net'), { textContent: online ? 'online' : 'offline', className: `chip ${online ? 'ok' : 'bad'}` });
  const { pending, failed } = sync.counts;
  const queue = $('chip-queue');
  queue.textContent = sync.syncing ? 'syncing…' : `${pending} pending · ${failed} failed`;
  queue.className = `chip ${failed ? 'bad' : pending ? 'warn' : 'ok'}`;
  $('chip-cache').hidden = !state.view?.fromCache;
  $('chip-storage').hidden = store.persistent;
  $('chip-storage').textContent = 'memory only (not persisted)';
  $('chip-storage').className = 'chip warn';

  $('failed-box').hidden = sync.failedEntries.length === 0;
  $('failed').replaceChildren(...sync.failedEntries.map(e => {
    const li = el('li', {},
      el('span', { class: 'tag failed' }, e.status),
      el('span', { class: 'title' }, `${e.method} ${e.url} — ${e.lastError}`),
      button('Retry', () => sync.retry(e.id).then(refresh)),
      button('Abandon', async () => {
        if (confirm('Discard this change permanently?')) { await sync.abandon(e.id); logEvent(`abandoned ${e.id.slice(0, 8)}…`); await refresh(); }
      }));
    return li;
  }));
}

function renderTasks() {
  const tasks = state.view?.tasks ?? [];
  $('tasks').replaceChildren(...(tasks.length ? tasks : [el('li', { class: 'muted' }, 'No tasks yet.')]).map(t => {
    if (!t.id) return t;
    const box = el('input', { type: 'checkbox' });
    box.checked = t.done;
    box.addEventListener('change', () => act('toggle', () => repo.toggle(t)));
    return el('li', { class: t.done ? 'done' : '' },
      box,
      el('span', { class: 'title' }, t.title),
      el('span', { class: `tag ${t.sync}`, title: t.error ?? '' }, t.sync),
      button('Rename', () => { const title = prompt('New title', t.title); if (title) act('rename', () => repo.rename(t, title)); }));
  }));
}

/** Runs a write, reports whether it was sent or queued, shows permanent rejections inline. */
async function act(label, fn) {
  try {
    const res = await fn();
    logEvent(`${label}: ${res.queued ? `queued ${res.id.slice(0, 8)}…` : 'sent'}`);
  } catch (err) {
    logEvent(`${label} rejected: ${err.message}`);
    alert(err.message);
  }
  await refresh();
}

$('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('add-title').value;
  $('add-title').value = '';
  await act('add', () => repo.add(title));
});

$('logout').addEventListener('click', async () => {
  if (await sync.logoutBlocked()) {
    $('banner').hidden = false;
    $('banner').textContent = 'Cannot log out: you still have unsent or failed changes on this device. Reconnect to sync them, or resolve the failed ones.';
    return;
  }
  store.lock();
  setSession(null);
  location.reload();
});

// ── Server view + chaos controls (demo only) ────────────────────────────────
async function pollServer() {
  try {
    const dbg = await rawFetch('GET', '/api/_debug');
    $('server-tasks').replaceChildren(...(dbg.tasks.length ? dbg.tasks : [{ title: '(empty)', done: false, version: '' }]).map(t =>
      el('li', {}, el('span', { class: 'title' }, `${t.done ? '✓ ' : ''}${t.title}`), el('span', { class: 'muted' }, t.version ? `v${t.version}` : ''))));
    $('idem').replaceChildren(...dbg.idempotency.slice(-8).map(r => el('li', {}, `${r.key.slice(0, 8)}…  ${r.method} ${r.path} → ${r.status}`)));
    $('log').textContent = dbg.log.slice(-12).join('\n');
  } catch { /* server stopped */ }
}
setInterval(pollServer, 1500);
pollServer();

document.querySelectorAll('[data-chaos]').forEach(b => b.addEventListener('click', async () => {
  await rawFetch('POST', '/api/_chaos', { body: JSON.parse(b.dataset.chaos) });
  logEvent(`chaos armed: ${b.textContent}`);
}));
$('latency').addEventListener('change', e => rawFetch('POST', '/api/_chaos', { body: { latencyMs: Number(e.target.value) } }));
$('edit-elsewhere').addEventListener('click', async () => {
  const first = (await rawFetch('GET', '/api/_debug')).tasks[0];
  if (!first) return alert('Create a task first.');
  await rawFetch('POST', '/api/_debug/edit', { body: { id: first.id, title: `${first.title} (edited elsewhere)` } });
  logEvent('server copy edited by "someone else"');
});

// ── Tiny DOM helpers ─────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}
function button(label, onClick) {
  const b = el('button', {}, label);
  b.addEventListener('click', onClick);
  return b;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (state.session && await store.backend.metaGet('owner')) {
  // Page refresh: the data key lived in memory only, so it is gone. Ask for the password.
  store.lock();
  await sync.refreshCounts();
  renderStatus();
  showAuth('unlock', `Signed in as ${state.session.username}. Enter your password to unlock the offline store.`);
} else {
  setSession(null);
  showAuth('login', 'Demo logins: demo / demo, alice / alice');
}
