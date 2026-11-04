import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRelay } from '../src/server.mjs';
import { RelayError } from '../src/protocol.mjs';

class RuntimeFixture extends EventEmitter {
  connected = false; ended = false; calls = []; runs = []; counter = 0;
  threads = new Map([
    ['old', { id: 'old', cwd: '/workspace', name: 'Old history', source: 'cli', status: { type: 'idle' } }],
    ['missing', { id: 'missing', cwd: '/missing', name: 'Missing directory', source: 'cli', status: { type: 'idle' } }],
    ['archived', { id: 'archived', cwd: '/workspace', source: 'cli', archived: true, status: { type: 'idle' } }]
  ]);
  async start() { this.connected = true; }
  close() { this.connected = false; }
  async listRuns() { return this.runs; }
  async replayThread(id) { this.calls.push(['replay', id]); }
  async answer(id) { if (this.rejectAnswer) throw new RelayError(503, 'runtime_disconnected', '运行已断开。'); this.calls.push(['answer', id]); }
  async call(method, params) {
    this.calls.push([method, params]);
    if (method === 'thread/list') return { data: [...this.threads.values()].filter(row => !!row.archived === !!params.archived && (!params.cwd || params.cwd === row.cwd)), nextCursor: null };
    if (method === 'thread/read') return { thread: this.threads.get(params.threadId) };
    if (method === 'thread/turns/list') return { data: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-item', type: 'agentMessage', text: 'Preserved history' }] }], nextCursor: null };
    if (method === 'thread/start' || method === 'thread/resume') {
      const thread = method === 'thread/start' ? { id: `new-${++this.counter}`, cwd: params.cwd, source: 'appServer', status: { type: 'idle' } } : this.threads.get(params.threadId);
      this.threads.set(thread.id, thread);
      if (!this.runs.some(run => run.threadId === thread.id)) this.runs.push({ id: `run-${thread.id}`, runtimeId: `run-${thread.id}`, threadId: thread.id, cwd: thread.cwd, status: 'idle', pid: 100 + this.runs.length, managed: true, tmuxState: 'attached', tmux: { sessionId: `$${this.counter}`, sessionName: `codex-chat-${thread.id}`, paneId: `%${this.counter}` } });
      return { thread };
    }
    if (method === 'turn/start') return { turn: { id: 'turn-one', status: 'inProgress', items: [] } };
    throw new Error(`Unexpected fixture method ${method}`);
  }
}
async function fixture(t, options = {}) {
  const rpc = options.rpc || new RuntimeFixture();
  const runControl = {
    list: async () => rpc.runs,
    inspectWriters: async () => ({ complete: true, holders: [] }),
    isFrozen: async () => false,
    previewClose: async runtimeId => ({ planId: `close-${runtimeId}`, scope: 'pane', affectedThreads: [{ id: rpc.runs.find(run => run.id === runtimeId)?.threadId }], otherPanesPreserved: true }),
    close: async planId => { rpc.runs = rpc.runs.filter(run => `close-${run.id}` !== planId); return { status: 'closed', affected: [], reports: [] }; },
    ...options.runControl
  };
  const archiveService = options.archiveService || { listOperations: async () => [], preview: async id => ({ planId: `archive-${id}`, affected: [{ id }, { id: 'child' }], requiresConfirmation: true, canArchive: true }), execute: async () => ({ operationId: 'operation', status: 'partial', affected: [{ id: 'old', status: 'archived' }, { id: 'child', status: 'notArchived' }], freezeRetained: false }), recheck: async id => ({ operationId: id, status: 'complete', affected: [] }) };
  const relay = await createRelay({ port: 0, rpc, config: { projects: [{ id: 'home', name: 'Home', cwd: '/workspace' }] }, runtimeManagement: true, runControl, archiveService, observeExternalThreads: async () => ({ complete: true, agents: [] }), overviewCollector: async () => ({ metrics: {}, agents: [{ threadId: 'ordinary-shell' }], coverage: { externalComplete: true } }), ...options.relay });
  t.after(() => relay.close());
  let cookie, csrf;
  async function request(path, body, overrides = {}) {
    const response = await fetch(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; if (data.csrf) csrf = data.csrf; return { status: response.status, data };
  }
  await request('/api/session');
  return { rpc, relay, request };
}

test('library view reads saved history without resume or tmux creation, even missing cwd', async t => {
  const f = await fixture(t);
  const view = await f.request('/api/resume', { threadId: 'missing' });
  assert.equal(view.status, 200); assert.equal(view.data.thread.turns[0].items[0].text, 'Preserved history'); assert.equal(view.data.thread.unavailable, undefined);
  assert.equal(f.rpc.calls.some(([method]) => ['thread/resume', 'thread/start'].includes(method)), false);
  assert.equal((await f.request('/api/history?thread=missing')).status, 200);
  assert.equal(f.rpc.runs.length, 0);
});
test('each phone-created chat gets its own runtime; joining old chat preserves threadId and history', async t => {
  const f = await fixture(t);
  const a = await f.request('/api/threads', { projectId: 'home' }), b = await f.request('/api/threads', { projectId: 'home' });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.data.runtime.runtimeId, b.data.runtime.runtimeId);
  const joined = await f.request('/api/runtimes/join', { threadId: 'old', projectId: 'ignored-selection' });
  assert.equal(joined.status, 200); assert.equal(joined.data.thread.id, 'old'); assert.equal(joined.data.runtime.threadId, 'old');
  assert.equal(f.rpc.calls.find(([method]) => method === 'thread/resume')[1].cwd, '/workspace');
});
test('killing a runtime leaves the library and original conversation resumable', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  const preview = await f.request('/api/runtimes/close/preview', { runtimeId: 'run-old' });
  assert.equal((await f.request('/api/runtimes/close', { planId: preview.data.planId })).data.status, 'closed');
  assert.equal(f.rpc.runs.length, 0); assert.equal(f.rpc.threads.has('old'), true);
  assert.equal((await f.request('/api/threads?project=all')).status, 400); // Fixed-project fixture has no all-directory browser.
  assert.equal((await f.request('/api/resume', { threadId: 'old' })).data.thread.id, 'old');
  assert.equal(f.rpc.calls.some(([method]) => method === 'thread/archive'), false);
  assert.equal((await f.request('/api/runtimes/join', { threadId: 'old' })).data.thread.id, 'old');
});

test('current runtime closure clears active execution and approvals, invalidates rows, and permits same-ID continuation', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  f.rpc.emit('notification', { method: 'turn/started', params: { threadId: 'old', turn: { id: 'active-turn', status: 'inProgress' } } });
  f.rpc.emit('approval', { id: 'pending-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'old', turnId: 'active-turn', itemId: 'item', cwd: '/workspace' } });
  assert.equal((await f.request('/api/runtimes')).data.data.length, 1); assert.equal(f.relay.state.approvals.size, 1);
  f.rpc.runs = []; f.rpc.emit('runtimeClosed', { runtimeId: 'run-old', threadId: 'old', superseded: false });
  assert.equal(f.relay.state.loadedThreads.has('old'), false); assert.equal(f.relay.state.activeTurns.has('old'), false); assert.equal(f.relay.state.approvals.size, 0);
  assert.deepEqual((await f.request('/api/runtimes')).data.data, []);
  const event = f.relay.state.events.find(event => event.data.status === 'runtime-closed'); assert.equal(event.data.runtimeId, 'run-old'); assert.equal(event.data.threadId, 'old');
  assert.equal((await f.request('/api/runtimes/join', { threadId: 'old' })).data.thread.id, 'old');
  assert.equal((await f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'after-external-close', text: 'continue' })).status, 200);
});

test('superseded runtime closure preserves the new same-thread turn and its approvals', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' }); await f.request('/api/runtimes');
  f.rpc.runs = [{ ...f.rpc.runs[0], id: 'replacement-run', runtimeId: 'replacement-run' }];
  f.rpc.emit('notification', { method: 'turn/started', params: { threadId: 'old', turn: { id: 'replacement-turn', status: 'inProgress' } } });
  f.rpc.emit('approval', { id: 'replacement-approval', method: 'item/fileChange/requestApproval', params: { threadId: 'old', turnId: 'replacement-turn', itemId: 'item', cwd: '/workspace' } });
  f.rpc.emit('runtimeClosed', { runtimeId: 'run-old', threadId: 'old', superseded: true });
  assert.equal(f.relay.state.loadedThreads.has('old'), true); assert.equal(f.relay.state.activeTurns.get('old'), 'replacement-turn'); assert.equal(f.relay.state.approvals.has('replacement-approval'), true);
  assert.equal((await f.request('/api/runtimes')).data.data[0].runtimeId, 'replacement-run');
  assert.equal((await f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'must-stay-busy', text: 'do not overlap' })).data.error.code, 'turn_busy');
});

test('a disconnected pending turn releases its reservation after rejection so the same thread can send again', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  const entered = Promise.withResolvers(), response = Promise.withResolvers(), call = f.rpc.call.bind(f.rpc); let held = false;
  f.rpc.call = async (method, params) => { if (method === 'turn/start' && !held) { held = true; entered.resolve(); return response.promise; } return call(method, params); };
  const pending = f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'disconnected-submit', text: 'first' });
  await entered.promise; f.rpc.runs = []; f.rpc.emit('runtimeClosed', { runtimeId: 'run-old', threadId: 'old', superseded: false });
  response.reject(new RelayError(503, 'runtime_disconnected', '运行已断开。')); assert.equal((await pending).status, 503);
  await f.request('/api/runtimes/join', { threadId: 'old' });
  assert.equal((await f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'continued-submit', text: 'continue' })).status, 200);
});
test('runtime homepage contains actual idle and working rows, not unrelated overview shells', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  const overview = await f.request('/api/overview');
  assert.equal(overview.data.agents.length, 1); assert.equal(overview.data.agents[0].status, 'idle'); assert.equal(overview.data.agents[0].runtimeId, 'run-old');
  const session = await f.request('/api/session'); assert.equal(session.data.capabilities.library, true); assert.equal(session.data.capabilities.archiveManagement, true);
});
test('archived conversations remain readable but cannot join runtime', async t => {
  const f = await fixture(t);
  const view = await f.request('/api/resume', { threadId: 'archived' }); assert.equal(view.status, 200); assert.equal(view.data.thread.archived, true);
  assert.equal((await f.request('/api/runtimes/join', { threadId: 'archived' })).data.error.code, 'thread_archived');
  assert.equal(f.rpc.runs.length, 0);
  assert.equal((await f.request('/api/threads?project=home&archived=true')).data.data[0].archived, true);
  assert.equal((await f.request('/api/threads?project=home&archived=1')).status, 400);
});
test('library-only conversation cannot send until explicitly joined', async t => {
  const f = await fixture(t); await f.request('/api/resume', { threadId: 'old' });
  const turn = await f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'one', text: 'hello' });
  assert.equal(turn.status, 409); assert.equal(turn.data.error.code, 'runtime_required');
  assert.equal(f.rpc.calls.some(([method]) => method === 'thread/resume'), false);
});
test('archive preview does not execute; partial per-thread receipts pass through unchanged', async t => {
  let executed = 0;
  const f = await fixture(t, { archiveService: { listOperations: async () => [], preview: async () => ({ planId: 'confirmed', affected: [{ id: 'old' }, { id: 'child' }], requiresConfirmation: true }), execute: async () => { executed++; return { status: 'partial', affected: [{ id: 'old', status: 'archived' }, { id: 'child', status: 'notArchived' }] }; } } });
  assert.equal((await f.request('/api/library/archive/preview', { threadId: 'old' })).data.affected.length, 2); assert.equal(executed, 0);
  const result = await f.request('/api/library/archive', { planId: 'confirmed' }); assert.equal(executed, 1); assert.equal(result.data.status, 'partial'); assert.equal(result.data.affected[1].status, 'notArchived');
});
test('uncertain archive error exposes only operation identity/freeze and allows receipt recheck', async t => {
  const f = await fixture(t, { archiveService: { listOperations: async () => [{ operationId: 'op', freezeRetained: true }], execute: async () => { const error = new RelayError(503, 'archive_check_failed', '待核验'); error.operationId = 'op'; error.freezeRetained = true; error.secret = 'private'; throw error; }, recheck: async id => ({ operationId: id, status: 'partial', affected: [] }) } });
  const result = await f.request('/api/library/archive', { planId: 'plan' }); assert.equal(result.status, 503); assert.equal(result.data.error.freezeRetained, true); assert.equal(result.data.error.operationId, 'op'); assert.equal(result.data.error.secret, undefined);
  assert.equal((await f.request('/api/library/archive/recheck', { operationId: 'op' })).data.status, 'partial');
  assert.equal((await f.request('/api/session')).data.pendingArchiveOperations[0].operationId, 'op');
});
test('runtime and archive mutations require CSRF and reject extra parameters', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/runtimes/join', { threadId: 'old' }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await f.request('/api/runtimes/close', { planId: 'plan', force: true })).status, 400);
  assert.equal((await f.request('/api/library/archive', { planId: 'plan', threadId: 'unconfirmed' })).status, 400);
});
test('failed asynchronous approval acknowledgement preserves pending approval', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  f.relay.state.activeTurns.set('old', 'turn'); f.rpc.emit('approval', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'old', turnId: 'turn', itemId: 'item', cwd: '/workspace' } });
  f.rpc.rejectAnswer = true;
  assert.equal((await f.request('/api/approvals', { requestId: 'approval', decision: 'accept' })).status, 503);
  assert.equal(f.relay.state.approvals.has('approval'), true);
});
test('startup approval is buffered until recovered runtime authorization and survives replay', async t => {
  const rpc = new RuntimeFixture();
  const approval = { id: 'startup-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'old', turnId: 'active-turn', itemId: 'item', cwd: '/workspace' } };
  rpc.runs.push({ id: 'existing-run', threadId: 'old', cwd: '/workspace', activeTurnId: 'active-turn', status: 'waitingApproval', managed: true });
  rpc.start = async () => { rpc.connected = true; rpc.emit('approval', approval); };
  rpc.replayThread = async () => rpc.emit('approval', approval);
  const f = await fixture(t, { rpc }); await f.request('/api/runtimes');
  assert.equal(f.relay.state.approvals.has('startup-approval'), true);
  assert.equal(rpc.calls.some(([method]) => method === 'answer'), false);
});
test('incomplete original-writer observation blocks joining an existing conversation', async t => {
  const f = await fixture(t, { runControl: { inspectWriters: async () => ({ complete: false, holders: [] }) } });
  const result = await f.request('/api/runtimes/join', { threadId: 'old' });
  assert.equal(result.data.error.code, 'writer_observation_incomplete');
  assert.equal(f.rpc.calls.some(([method]) => method === 'thread/resume'), false);
});
test('fresh external archive state prevents sending to a previously managed runtime', async t => {
  const f = await fixture(t); await f.request('/api/runtimes/join', { threadId: 'old' });
  f.rpc.threads.get('old').archived = true;
  const result = await f.request('/api/turns', { projectId: 'home', threadId: 'old', submissionId: 'archived-turn', text: 'hello' });
  assert.equal(result.data.error.code, 'thread_archived');
  assert.equal(f.rpc.calls.some(([method]) => method === 'turn/start'), false);
});
test('an older in-flight overview cannot hide a newly created runtime or poison its cache', async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const rpc = new RuntimeFixture(); let reads = 0;
  const f = await fixture(t, { rpc, runControl: { list: async () => { if (++reads === 1) { started(); return new Promise(resolve => { release = () => resolve([]); }); } return rpc.runs; } } });
  const old = f.request('/api/runtimes'); await began;
  const created = await f.request('/api/threads', { projectId: 'home' });
  assert.equal(created.data.runtime.threadId, created.data.thread.id);
  release(); await old;
  const current = await f.request('/api/runtimes'); assert.equal(current.data.data.length, 1);
});
test('the verified loaded empty thread can receive its first real message before official persistence', async t => {
  const rpc = new RuntimeFixture(), call = rpc.call.bind(rpc);
  rpc.call = async (method, params) => { const result = await call(method, params); if (method === 'thread/list') result.data = result.data.filter(row => !row.id.startsWith('new-')); return result; };
  const f = await fixture(t, { rpc }); const created = (await f.request('/api/threads', { projectId: 'home' })).data.thread;
  const resumed = await f.request('/api/resume', { threadId: created.id }); assert.equal(resumed.status, 200); assert.deepEqual(resumed.data.thread.turns, []);
  const turn = await f.request('/api/turns', { projectId: 'home', threadId: created.id, submissionId: 'first-real-task', text: 'This is the actual user message' });
  assert.equal(turn.status, 200); assert.equal(rpc.calls.filter(([method]) => method === 'turn/start').length, 1);
});
