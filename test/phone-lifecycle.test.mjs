import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { appFixtureSource } from './ui-source-fixture.mjs';

const appPath = process.env.PHONE_LIFECYCLE_APP_PATH || new URL('../public/app.js', import.meta.url);
const source = appFixtureSource(await readFile(appPath, 'utf8'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const response = body => ({ ok: true, status: 200, json: async () => body });

function fixture(t, { bearer = true, presence = false } = {}) {
  const nodes = new Map(), documentListeners = new Map(), timers = new Map(), sources = [], requests = [], polls = [];
  const turn = deferred(), sessionRead = deferred(); let timerId = 0;
  const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', children: [], dataset: {}, listeners: new Map(), scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {}, contains() { return false; } },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, toggleAttribute() {}, setAttribute() {}, focus() {}, querySelectorAll() { return []; },
    append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, prepend() {} });
  const document = { visibilityState: 'visible', getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, createDocumentFragment: node, addEventListener(name, fn) { documentListeners.set(name, fn); } };
  const storage = new Map(bearer ? [['relay-session-token', 'a'.repeat(43)]] : []);
  class EventSourceFixture {
    constructor(url) { this.url = url; this.closed = false; this.listeners = new Map(); sources.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({ document, window: { addEventListener() {} }, location: bearer ? { origin: 'http://127.0.0.1:59119', port: '59119' } : { origin: 'https://relay.test.example', port: '' },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    AbortController, EventSource: EventSourceFixture, crypto: { randomUUID: () => 'fixture-submission-id' },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      requests.push({ url, options });
      if (url === '/api/runtime-presence') { const body = JSON.parse(options.body); return Promise.resolve(response({ ...body, connected: !!body.threadId, leaseMs: 90000 })); }
      if (url === '/api/turns') return turn.promise;
      if (url === '/api/session') return sessionRead.promise;
      if (url.startsWith('/api/poll?')) {
        const pending = deferred(); const entry = { ...pending, options, url }; polls.push(entry);
        const abort = () => pending.resolve(Promise.reject(new DOMException('Aborted', 'AbortError')));
        if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
        return pending.promise;
      }
      throw Error(`Unexpected fixture request: ${url}`);
    } });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`state.session = { authenticated: true, mode: 'production', csrf: 'fixture-csrf', ${bearer ? "authTransport: 'bearer', eventTransport: 'poll'," : ''} projects: [{ id: 'acceptance', name: 'Acceptance', cwd: '/isolated' }], pendingApprovals: [] }; state.projectId = 'acceptance'; state.thread = { id: 'thread-1', turns: [] }; state.upstreamStatus = 'connected'; state.connected = true; state.eventCursor = 7; ${presence ? "state.view = 'chat'; state.session.capabilities = { runtimePresence: true };" : ''} $('prompt').value = 'single fixture turn'; controls();`);
  t.after(async () => { run('stopSubscription()'); await flush(); });
  const visibility = async value => { document.visibilityState = value; documentListeners.get('visibilitychange')(); await flush(); };
  const submit = async () => { nodes.get('composer').listeners.get('submit')({ preventDefault() {} }); await flush(); };
  const finishTurn = async () => { turn.resolve(response({ turn: { id: 'turn-1', status: 'inProgress' } })); await flush(); };
  const deliverDelta = async poll => { poll.resolve(response({ events: [{ id: 8, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'agent-1', delta: 'fixture reply' } } }], cursor: 8, resync: false, upstreamStatus: 'connected' })); await flush(); };
  return { run, nodes, document, timers, sources, requests, polls, submit, visibility, finishTurn, deliverDelta,
    activePolls: () => polls.filter(poll => !poll.options.signal.aborted), turnRequests: () => requests.filter(request => request.url === '/api/turns') };
}

test('pending POST survives hidden-to-visible and resumes delta display without another visibility event or turn', async t => {
  const f = fixture(t); f.run('subscribe()'); await flush();
  assert.equal(f.polls.length, 1); await f.submit(); assert.equal(f.run('state.posting'), true);
  await f.visibility('hidden'); assert.equal(f.polls[0].options.signal.aborted, true);
  await f.visibility('visible');
  assert.equal(f.polls.length, 2, 'returning while POST is pending must immediately restore the event poll');
  assert.equal(f.polls[1].options.signal.aborted, false, 'the obsolete poll cleanup must not abort the replacement poll');
  assert.equal(f.requests.filter(request => request.url === '/api/session').length, 0, 'pending thread state must not be rehydrated');
  await f.finishTurn(); assert.equal(f.run('state.posting'), false);
  await f.deliverDelta(f.polls[1]);
  assert.equal(f.run("state.items.get('agent-1').text"), 'fixture reply');
  assert.equal(f.turnRequests().length, 1); assert.equal(f.sources.length, 0);
  assert.equal(f.polls[1].options.credentials, 'omit');
  assert.equal(f.polls[1].options.headers.Authorization, `Bearer ${'a'.repeat(43)}`);
  assert.equal(f.polls[1].options.headers['X-Relay-Origin'], 'http://127.0.0.1:59119');
});

test('finishing the POST while still hidden does not restore polls or resend the turn', async t => {
  const f = fixture(t); f.run('subscribe()'); await f.submit(); await f.visibility('hidden'); await f.finishTurn();
  assert.equal(f.run('state.posting'), false); assert.equal(f.polls.length, 1); assert.equal(f.polls[0].options.signal.aborted, true);
  assert.equal(f.turnRequests().length, 1); assert.equal(f.requests.filter(request => request.url === '/api/session').length, 0);
});

test('a session logged out during the pending POST is not subscribed on return', async t => {
  const f = fixture(t); f.run('subscribe()'); await f.submit(); await f.visibility('hidden'); f.run('setAuthenticated(false)');
  await f.visibility('visible'); await f.finishTurn();
  assert.equal(f.polls.length, 1); assert.equal(f.run('state.session.authenticated'), false); assert.equal(f.turnRequests().length, 1);
});

test('a closed upstream during the pending POST is not subscribed on return', async t => {
  const f = fixture(t); f.run('subscribe()'); await f.submit(); await f.visibility('hidden'); f.run("upstream('closed')");
  await f.visibility('visible'); await f.finishTurn();
  assert.equal(f.polls.length, 1); assert.equal(f.run('state.upstreamStatus'), 'closed'); assert.equal(f.run('state.connected'), false); assert.equal(f.turnRequests().length, 1);
});

test('HTTPS restores its existing cookie-based SSE and retains one submission', async t => {
  const f = fixture(t, { bearer: false }); f.run('subscribe()'); assert.equal(f.sources.length, 1);
  await f.submit(); await f.visibility('hidden'); assert.equal(f.sources[0].closed, true);
  await f.visibility('visible'); await f.finishTurn();
  assert.equal(f.sources.length, 2); assert.equal(f.sources[1].url, '/api/events?cursor=7'); assert.equal(f.sources[1].closed, false);
  assert.equal(f.polls.length, 0); assert.equal(f.turnRequests().length, 1); assert.equal(f.turnRequests()[0].options.credentials, 'same-origin');
  assert.equal(f.turnRequests()[0].options.headers.Authorization, undefined);
});

test('normal foreground recovery still uses the existing hydrate deduplication', async t => {
  const f = fixture(t); f.run('subscribe()'); await f.visibility('hidden'); await f.visibility('visible'); await f.visibility('visible');
  assert.equal(f.run('state.posting'), false); assert.equal(f.requests.filter(request => request.url === '/api/session').length, 1);
  assert.equal(f.polls.length, 1); assert.equal(f.polls[0].options.signal.aborted, true); assert.equal(f.turnRequests().length, 0);
});


test('a pending mobile turn releases presence in background and renews its same chat on foreground without a duplicate turn', async t => {
  const f = fixture(t, { presence: true }); f.run('subscribe()'); await f.run('runtimePresence.queue');
  const presence = () => f.requests.filter(request => request.url === '/api/runtime-presence').map(request => ({ ...request, body: JSON.parse(request.options.body) }));
  assert.equal(presence().at(-1).body.threadId, 'thread-1');
  await f.submit(); await f.visibility('hidden'); await f.run('runtimePresence.queue'); assert.equal(presence().at(-1).body.threadId, null);
  await f.visibility('visible'); await f.run('runtimePresence.queue'); assert.equal(presence().at(-1).body.threadId, 'thread-1'); assert.equal(new Set(presence().map(request => request.body.clientId)).size, 1);
  assert.ok(presence().every(request => request.options.keepalive && request.options.headers.Authorization === `Bearer ${'a'.repeat(43)}`)); assert.equal(f.turnRequests().length, 1);
  await f.finishTurn(); assert.equal(f.turnRequests().length, 1);
});
