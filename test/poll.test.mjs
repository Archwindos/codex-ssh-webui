import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRelay } from '../src/server.mjs';

const config = { projects: [{ id: 'home', name: 'Home', cwd: '/workspace' }] };
const productionConfig = { ...config, sshTarget: 'codex-server', remoteCodex: '/opt/codex/bin/codex', publicOrigin: 'https://relay.test.example', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
const fixtureEnv = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 150; n++) { if (fn()) return; await delay(10); } assert.fail('Timed out waiting for fixture'); }

class FixtureRpc extends EventEmitter {
  connected = false; ended = false; calls = [];
  async start() { this.connected = true; }
  close() { this.connected = false; }
  answer() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/workspace', turns: [] } };
    if (method === 'thread/start') return { thread: { id: 'new-thread', cwd: '/workspace', turns: [] } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
    throw new Error(`Unexpected fixture method ${method}`);
  }
}
async function fixture(t, options = {}) {
  const relay = await createRelay({ port: 0, rpc: new FixtureRpc(), ...options }); t.after(() => relay.close());
  let cookie = '', csrf = '';
  const request = (path, body, headers = {}, signal) => new Promise((resolve, reject) => {
    const req = http.request(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', signal, headers: { Host: new URL(relay.publicOrigin).host, Cookie: cookie, ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          if (data.csrf) csrf = data.csrf;
          resolve({ status: res.statusCode, data, headers: res.headers });
        } catch (error) { reject(error); }
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const emit = delta => relay.rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta, private: 'MUST_NOT_LEAK' } });
  return { relay, request, emit, cookie: () => cookie, session: () => request('/api/session') };
}

test('poll requires an authenticated cookie and preserves Origin, Host and query checks in production', async t => {
  const f = await fixture(t, { mock: false, config: productionConfig, env: fixtureEnv });
  assert.equal((await f.request('/api/poll?wait=0')).status, 401);
  const session = await f.session(); assert.equal(session.data.authenticated, false);
  assert.equal((await f.request('/api/poll?wait=0')).status, 401);
  assert.equal((await f.request('/api/login', { secret: fixtureEnv.RELAY_ACCESS_SECRET })).status, 200);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/api/poll?wait=0&token=anything')).status, 400);
  const page = await f.request('/api/poll?wait=0');
  assert.deepEqual(page.data, { events: [], cursor: 0, resync: false, upstreamStatus: 'idle' }); assert.equal(page.headers['cache-control'], 'no-store');
});

test('session reports the trusted poll preference and otherwise defaults to SSE', async t => {
  const standard = await fixture(t), polling = await fixture(t, { config: { ...config, eventTransport: 'poll' } });
  assert.equal((await standard.session()).data.eventTransport, 'sse');
  assert.equal((await polling.session()).data.eventTransport, 'poll');
  assert.equal((await standard.request('/api/session?eventTransport=poll')).status, 400);
  await assert.rejects(createRelay({ port: 0, config: { ...config, eventTransport: 'anything' }, rpc: new FixtureRpc() }), /sse 或 poll/);
});

test('reopening after upstream exit stays offline even when the closed event is before the snapshot cursor', async t => {
  const f = await fixture(t);
  assert.equal((await f.session()).data.upstreamStatus, 'idle'); assert.equal(f.relay.rpc.calls.length, 0);
  await f.request('/api/threads?project=home'); assert.equal((await f.session()).data.upstreamStatus, 'connected');
  f.relay.rpc.connected = false; f.relay.rpc.ended = true; f.relay.rpc.emit('closed');
  const snapshot = await f.session(); assert.equal(snapshot.data.upstreamStatus, 'closed'); assert.equal(snapshot.data.connected, false); assert.equal(snapshot.data.eventCursor, 1);
  const page = await f.request('/api/poll?cursor=1');
  assert.deepEqual(page.data, { events: [], cursor: 1, resync: false, upstreamStatus: 'closed' }); assert.equal(f.relay.state.polls.size, 0);
  const calls = [], browser = await browserFixture(t, async (url, options) => {
    calls.push(url); const result = await f.request(url, options?.body ? JSON.parse(options.body) : undefined);
    return { ok: result.status < 400, status: result.status, json: async () => result.data };
  });
  await browser.run('hydrate()'); browser.run("$('prompt').value = 'must remain disabled'; controls(); subscribe();");
  assert.equal(browser.run('state.eventCursor'), 1); assert.equal(browser.run('state.upstreamStatus'), 'closed'); assert.equal(browser.run('state.connected'), false);
  assert.equal(browser.nodes.get('prompt').disabled, true); assert.equal(browser.nodes.get('send').disabled, true); assert.equal(browser.nodes.get('new-thread').disabled, true);
  assert.equal(browser.sources.length, 0); assert.equal(browser.timers.size, 0); assert.deepEqual(calls, ['/api/session']);
  assert.equal((await f.request('/api/threads?project=home')).status, 503); assert.equal(f.relay.rpc.calls.length, 1);
});

test('poll replays only sanitized new events and requests resync for expired or future cursors', async t => {
  const f = await fixture(t); await f.session(); f.relay.state.authorizedThreads.set('thread-1', '/workspace');
  f.emit('中文🙂');
  const first = await f.request('/api/poll?cursor=0&wait=0');
  assert.equal(first.data.events.length, 1); assert.equal(first.data.events[0].id, 1); assert.equal(first.data.events[0].event, 'rpc'); assert.equal(first.data.events[0].data.params.delta, '中文🙂');
  assert.ok(!JSON.stringify(first.data).includes('MUST_NOT_LEAK'));
  assert.deepEqual((await f.request('/api/poll?cursor=1&wait=0')).data, { events: [], cursor: 1, resync: false, upstreamStatus: 'idle' });
  const pending = f.request('/api/poll?cursor=1&wait=20000'); await until(() => f.relay.state.polls.size === 1); f.emit('下一段');
  const second = await pending; assert.equal(second.data.events.length, 1); assert.equal(second.data.events[0].id, 2); assert.equal(second.data.cursor, 2); assert.equal(f.relay.state.polls.size, 0);
  for (let n = 0; n < 301; n++) f.emit(String(n));
  assert.equal(f.relay.state.events.length, 300);
  for (const cursor of [0, 999999]) { const page = await f.request(`/api/poll?cursor=${cursor}&wait=0`); assert.deepEqual(page.data, { events: [], cursor: 303, resync: true, upstreamStatus: 'idle' }); }
  assert.equal((await f.request('/api/poll?cursor=3&wait=0')).data.events[0].id, 4);
  for (const query of ['cursor=', 'cursor=-1', 'cursor=1.5', 'cursor=1&cursor=2', 'wait=20001', 'wait=-1', 'wait=0&wait=0']) assert.equal((await f.request(`/api/poll?${query}`)).status, 400, query);
});

test('poll timeout is bounded and default requests stop at absolute session expiry', async t => {
  const f = await fixture(t); await f.session();
  const start = performance.now(); const page = await f.request('/api/poll?cursor=0&wait=35'); const elapsed = performance.now() - start;
  assert.equal(page.status, 200); assert.deepEqual(page.data, { events: [], cursor: 0, resync: false, upstreamStatus: 'idle' }); assert.ok(elapsed >= 20 && elapsed < 1000, String(elapsed)); assert.equal(f.relay.state.polls.size, 0);
  let now = 1000;
  const expiring = await fixture(t, { clock: () => now, sessionTtlMs: 50, idleTtlMs: 1000, maintenanceMs: 5 }); await expiring.session();
  const oldCookie = expiring.cookie(), pending = expiring.request('/api/poll?cursor=0'); await until(() => expiring.relay.state.polls.size === 1); now = 1051;
  assert.equal((await pending).status, 401); assert.equal(expiring.relay.state.polls.size, 0); assert.equal(expiring.relay.state.sessions.size, 0);
  assert.equal((await expiring.request('/api/poll?wait=0', undefined, { Cookie: oldCookie })).status, 401);
});

test('logout and client abort release pending polls without retaining prior authentication', async t => {
  const f = await fixture(t); await f.session();
  const abort = new AbortController(), abandoned = f.request('/api/poll?cursor=0', undefined, {}, abort.signal); abandoned.catch(() => {});
  await until(() => f.relay.state.polls.size === 1); abort.abort(); await assert.rejects(abandoned, { name: 'AbortError' }); await until(() => f.relay.state.polls.size === 0);
  const cookie = f.cookie(), pending = f.request('/api/poll?cursor=0'); await until(() => f.relay.state.polls.size === 1);
  assert.equal((await f.request('/api/logout', {})).status, 200); assert.equal((await pending).status, 401); assert.equal(f.relay.state.polls.size, 0);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Cookie: cookie })).status, 401);
});

test('one session shares a limit of two SSE and pending poll connections', async t => {
  const f = await fixture(t); await f.session();
  const stream = await new Promise((resolve, reject) => { const req = http.get(f.relay.origin + '/api/events?cursor=0', { headers: { Cookie: f.cookie() } }, res => { res.once('data', () => resolve({ req, res })); }); req.on('error', reject); });
  t.after(() => { stream.res.destroy(); stream.req.destroy(); });
  const abort = new AbortController(), pending = f.request('/api/poll?cursor=0', undefined, {}, abort.signal); pending.catch(() => {});
  await until(() => f.relay.state.polls.size === 1);
  assert.equal((await f.request('/api/poll?cursor=0&wait=0')).status, 429); assert.equal((await f.request('/api/events')).status, 429);
  stream.res.destroy(); stream.req.destroy(); await until(() => f.relay.state.streams.size === 0);
  assert.equal((await f.request('/api/poll?cursor=0&wait=0')).status, 200);
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); await until(() => f.relay.state.polls.size === 0);
});

test('metadata history does not count as loaded; resume happens once before a turn', async t => {
  const f = await fixture(t); await f.session();
  assert.equal((await f.request('/api/history?project=home&thread=thread-1')).status, 200);
  assert.equal(f.relay.state.authorizedThreads.has('thread-1'), true); assert.equal(f.relay.state.loadedThreads.has('thread-1'), false);
  assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: 'thread-1' })).status, 200);
  assert.equal(f.relay.state.loadedThreads.has('thread-1'), true);
  assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: 'thread-1' })).status, 200);
  assert.equal((await f.request('/api/turns', { projectId: 'home', threadId: 'thread-1', text: 'fixture only', submissionId: 'loaded-test' })).status, 200);
  const resumes = f.relay.rpc.calls.filter(call => call.method === 'thread/resume'); assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].params, { threadId: 'thread-1', cwd: '/workspace', excludeTurns: true, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  await f.request('/api/threads', { projectId: 'home' }); assert.equal(f.relay.state.loadedThreads.has('new-thread'), true);
  const pending = f.request('/api/poll?cursor=0'); await until(() => f.relay.state.polls.size === 1); f.relay.rpc.emit('closed');
  assert.equal((await pending).data.events[0].data.status, 'disconnected'); assert.equal(f.relay.state.polls.size, 0); assert.equal(f.relay.state.loadedThreads.size, 0);
});

async function browserFixture(t, fetcher = async () => { throw new Error('Unexpected browser request'); }) {
  const nodes = new Map(), listeners = new Map(), timers = new Map(), sources = []; let timerId = 0;
  const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', children: [], dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, toggleAttribute() {}, setAttribute() {}, focus() {}, querySelectorAll() { return []; }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, prepend() {} });
  class EventSourceFixture {
    constructor(url) { this.url = url; this.listeners = {}; sources.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
  }
  const document = { visibilityState: 'visible', getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, createDocumentFragment: node, addEventListener(name, fn) { listeners.set(name, fn); } };
  const context = vm.createContext({ document, window: { addEventListener(name, fn) { listeners.set(name, fn); } }, sessionStorage: { getItem() { return null; }, setItem() {} }, EventSource: EventSourceFixture, AbortController, fetch: fetcher, setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, crypto: { randomUUID() { return 'fixture-id'; } } });
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/run\(\(\) => hydrate\(\)\);\s*$/, ''); vm.runInContext(source, context);
  vm.runInContext("state.session = { authenticated: true, mode: 'mock', csrf: 'TEST_ONLY', connected: true, upstreamStatus: 'connected' }; state.eventCursor = 0; state.upstreamStatus = 'connected';", context);
  t.after(() => vm.runInContext('stopSubscription()', context));
  return { context, sources, timers, nodes, listeners, document, run: code => vm.runInContext(code, context) };
}

test('browser closes failed SSE before poll fallback, deduplicates deltas, and aborts while hidden', async t => {
  const requests = [];
  const f = await browserFixture(t, (url, options) => { requests.push({ url, options }); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))); });
  f.run('subscribe()'); const source = f.sources[0]; assert.equal(source.url, '/api/events?cursor=0');
  source.onerror(); assert.equal(requests.length, 0); source.onerror(); assert.equal(source.closed, true); assert.equal(requests.length, 1); assert.match(requests[0].url, /^\/api\/poll\?cursor=0&wait=20000$/);
  f.run("state.thread = { id: 'thread-1' }; handleEvent('rpc', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'item-1', delta: '中' } }, 1); handleEvent('rpc', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'item-1', delta: '中' } }, 1); handleEvent('rpc', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'item-1', delta: '文' } }, 2);");
  assert.equal(f.run("state.items.get('item-1').text"), '中文');
  f.document.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); assert.equal(requests[0].options.signal.aborted, true); await delay(0); assert.equal(f.timers.size, 0);
});

test('browser falls back after SSE handshake timeout and stops polling on authentication failure', async t => {
  let requests = 0;
  const f = await browserFixture(t, async () => { requests++; return { ok: false, status: 401, json: async () => ({ error: { message: 'expired' } }) }; });
  f.run('subscribe()'); const handshake = [...f.timers.values()].find(timer => timer.ms === 12000); assert.ok(handshake); handshake.fn(); await delay(0);
  assert.equal(f.sources[0].closed, true); assert.equal(requests, 1); assert.equal(f.run('state.session.authenticated'), false); assert.equal(f.timers.size, 0);
  await delay(20); assert.equal(requests, 1);
});

test('SSE transport opening cannot enable sending and a current closed poll stops without a replayed event', async t => {
  const f = await browserFixture(t, async () => ({ ok: true, status: 200, json: async () => ({ events: [], cursor: 9, resync: false, upstreamStatus: 'closed' }) }));
  f.run("state.upstreamStatus = 'idle'; $('prompt').value = 'fixture'; subscribe();");
  const source = f.sources[0]; source.onopen(); assert.equal(f.run('state.connected'), false); assert.equal(f.nodes.get('send').disabled, true);
  source.listeners.relay({ data: JSON.stringify({ status: 'connected' }), lastEventId: '' }); assert.equal(f.run('state.connected'), true); assert.equal(f.nodes.get('send').disabled, false);
  f.run("state.eventCursor = 9; state.transportMode = 'poll'; subscribe();"); await delay(0);
  assert.equal(source.closed, true); assert.equal(f.run('state.upstreamStatus'), 'closed'); assert.equal(f.run('state.connected'), false);
  assert.equal(f.nodes.get('send').disabled, true); assert.equal(f.timers.size, 0);
});

test('browser uses the configured poll preference immediately and receives events without EventSource', async t => {
  const calls = []; let sessionReads = 0;
  const f = await browserFixture(t, async url => {
    calls.push(url);
    if (url.startsWith('/api/threads?')) { assert.equal(f.run('state.connected'), false); assert.equal(f.nodes.get('prompt').disabled, true); }
    const body = url === '/api/session' ? { authenticated: true, mode: 'mock', connected: sessionReads > 0, upstreamStatus: ++sessionReads === 1 ? 'idle' : 'connected', csrf: 'TEST_ONLY', eventTransport: 'poll', eventCursor: 0, projects: [config.projects[0]], pendingApprovals: [] }
      : url === '/api/resume' ? { thread: { id: 'thread-1', turns: [] }, nextCursor: null, eventCursor: 0 }
        : url.startsWith('/api/threads?') ? { data: [], nextCursor: null }
          : url === '/api/poll?cursor=0&wait=20000' ? { events: [{ id: 1, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'item-1', delta: '直接轮询收到事件' } } }], cursor: 1, resync: false, upstreamStatus: 'connected' }
            : assert.fail(`Unexpected request ${url}`);
    return { ok: true, status: 200, json: async () => body };
  });
  f.run("state.thread = { id: 'thread-1' }; state.projectId = 'home';"); await f.run('hydrate()'); await delay(0);
  assert.equal(f.sources.length, 0); assert.equal(f.run('state.transportMode'), 'poll'); assert.equal(f.run('state.eventCursor'), 1);
  assert.equal(f.run("state.items.get('item-1').text"), '直接轮询收到事件');
  assert.equal(f.run('state.connected'), true); assert.equal(f.nodes.get('prompt').disabled, false);
  assert.equal(calls.filter(url => url.startsWith('/api/poll')).length, 1); assert.ok(![...f.timers.values()].some(timer => timer.ms === 12000));
});

test('browser poll resync hydrates snapshots and reconnects without submitting a turn', async t => {
  const calls = [], approval = { id: 'approval-1', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } };
  let sessionReads = 0;
  const f = await browserFixture(t, async (url, options) => {
    calls.push(url);
    if (url.startsWith('/api/poll') && calls.filter(call => call.startsWith('/api/poll')).length > 1) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    const body = url.startsWith('/api/poll') ? { events: [], cursor: 400, resync: true, upstreamStatus: 'connected' }
      : url === '/api/session' ? { authenticated: true, mode: 'mock', connected: true, upstreamStatus: 'connected', csrf: 'TEST_ONLY', eventCursor: ++sessionReads === 1 ? 400 : 402, projects: [config.projects[0]], pendingApprovals: sessionReads === 1 ? [] : [approval] }
        : url === '/api/resume' ? { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [{ id: 'item-1', type: 'agentMessage', text: 'snapshot' }] }] }, nextCursor: null, eventCursor: 401 }
          : url.startsWith('/api/threads?') ? { data: [], nextCursor: null } : assert.fail(`Unexpected request ${url}`);
    return { ok: true, status: 200, json: async () => body };
  });
  f.run("state.thread = { id: 'thread-1' }; state.projectId = 'home'; state.transportMode = 'poll';");
  await f.run('pollEvents(state.transportEpoch)');
  assert.equal(calls.filter(url => url === '/api/turns').length, 0); assert.equal(calls.filter(url => url === '/api/resume').length, 1);
  assert.equal(f.run('state.eventCursor'), 401); assert.equal(f.run("state.approvals.has('approval-1')"), true);
  assert.equal(f.run("state.items.get('item-1').text"), 'snapshot');
});
