import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../src/server.mjs';
import { RelayError } from '../src/protocol.mjs';
import { createSharedThreadControl } from '../src/shared-control.mjs';

const clone = value => structuredClone(value);
class NativeRpc extends EventEmitter {
  connected = false; ended = false; calls = []; answers = []; threads = new Map(); loaded = new Set(); starts = 0; closes = 0; sequence = 0;
  async start() { this.starts++; this.connected = true; this.ended = false; }
  close() { this.closes++; this.connected = false; this.ended = true; }
  disconnect() { this.connected = false; this.ended = true; this.emit('closed'); }
  seed(id, cwd, loaded = true, extra = {}) { const thread = { id, cwd, name: id, projectId: null, section: null, source: 'cli', turns: [], status: { type: loaded ? 'idle' : 'notLoaded' }, ...extra }; this.threads.set(id, thread); if (loaded) this.loaded.add(id); return thread; }
  async answer(id, result) { this.answers.push({ id, result: clone(result) }); }
  async call(method, params = {}) {
    this.calls.push({ method, params: clone(params) });
    if (!this.connected) throw new RelayError(503, 'disconnected', 'Disconnected');
    if (method === 'project/list' || method === 'threadSection/list') return { data: [], nextCursor: null };
    if (method === 'thread/loaded/list') return { data: [...this.loaded], nextCursor: null };
    if (method === 'thread/list') {
      let data = [...this.threads.values()].filter(thread => thread.id !== this.unpersistedDraft && !!thread.archived === !!params.archived);
      if (params.ancestorThreadId) {
        const ids = new Set([params.ancestorThreadId]); let changed = true;
        while (changed) { changed = false; for (const row of this.threads.values()) if (!ids.has(row.id) && ids.has(row.parentThreadId || row.source?.subAgent?.thread_spawn?.parent_thread_id)) { ids.add(row.id); changed = true; } }
        data = data.filter(row => row.id !== params.ancestorThreadId && ids.has(row.id));
      }
      return { data: clone(data), nextCursor: null };
    }
    if (method === 'thread/start') { const thread = this.seed(`draft-${++this.sequence}`, params.cwd); this.unpersistedDraft = thread.id; return { thread: clone(thread) }; }
    const thread = this.threads.get(params.threadId);
    assert.ok(thread, `Unexpected thread ${params.threadId}`);
    if (method === 'thread/read') { assert.equal(params.includeTurns, false, 'bootstrap and metadata must not fetch unbounded full history'); const { turns, ...metadata } = thread; return { thread: clone({ ...metadata, turns: [] }) }; }
    if (method === 'thread/turns/list') return { data: clone(thread.turns.slice(0, params.limit).map(turn => params.itemsView === 'summary' ? { ...turn, items: [], itemsView: 'summary' } : turn)), nextCursor: null };
    if (method === 'thread/items/list') { const entries = [...thread.turns].reverse().flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), from = Number(params.cursor || 0); return { data: clone(entries.slice(from, from + params.limit)), nextCursor: from + params.limit < entries.length ? String(from + params.limit) : null }; }
    if (method === 'thread/resume') { assert.notEqual(thread.id, this.unpersistedDraft, 'native peer cannot resume an empty unpersisted draft'); this.loaded.add(thread.id); if (thread.status.type === 'notLoaded') thread.status = { type: 'idle' }; return { thread: clone({ ...thread, turns: [] }) }; }
    if (method === 'thread/archive') {
      const ids = new Set([thread.id]); let changed = true;
      while (changed) { changed = false; for (const row of this.threads.values()) if (!ids.has(row.id) && ids.has(row.parentThreadId || row.source?.subAgent?.thread_spawn?.parent_thread_id)) { ids.add(row.id); changed = true; } }
      for (const id of ids) { const row = this.threads.get(id); row.archived = true; row.status = { type: 'notLoaded' }; this.loaded.delete(id); }
      return {};
    }
    if (method === 'turn/start') {
      if (this.failNextTurn) { this.failNextTurn = false; this.disconnect(); throw new RelayError(503, 'disconnected', 'Unknown result; no replay'); }
      if (this.unpersistedDraft === thread.id) this.unpersistedDraft = null;
      const turn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [] }; thread.turns.unshift(turn); thread.status = { type: 'active', activeFlags: [] }; this.emit('notification', { method: 'turn/started', params: { threadId: thread.id, turn: clone(turn) } }); return { turn };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/interrupt') return {};
    assert.fail(`Shared mode must not invoke ${method}`);
  }
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'relay-shared-api-')), cwd = await fs.realpath(directory);
  const rpc = new NativeRpc(); rpc.seed('shared-live', cwd); rpc.seed('saved-only', cwd, false);
  options.configure?.(rpc, cwd);
  const relay = await createRelay({ mock: true, port: 0, rpc, config: { transport: 'local', sharedDaemonSocket: '/test/native.sock', workspace: { roots: [cwd], defaultCwd: cwd }, projects: [{ id: 'seed', name: 'Seed', cwd }] }, runtimeManagement: true, archiveStoreFile: options.archiveStoreFile ?? null, observeExternalThreads: async () => ({ agents: [{ threadId: 'shared-live', pid: 420, cwd, status: 'working' }], complete: true }), overviewCollector: async () => ({ agents: [], metrics: { fixture: true } }) });
  t.after(async () => { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '', csrf = '';
    return (path, body) => new Promise((resolve, reject) => {
      const request = http.request(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) } }, response => {
        const chunks = []; response.on('data', part => chunks.push(part)); response.on('end', () => { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (response.headers['set-cookie']) cookie = response.headers['set-cookie'][0].split(';')[0]; if (data.csrf) csrf = data.csrf; resolve({ status: response.statusCode, data }); });
      }); request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  const request = client(), session = await request('/api/session');
  assert.equal(session.status, 200);
  return { relay, rpc, cwd, request, client, session };
}
const mutations = rpc => rpc.calls.filter(call => ['thread/resume', 'thread/start', 'turn/start', 'turn/steer', 'turn/interrupt'].includes(call.method));

test('subagent inspection reads the direct child and binds history cursors to its parent and browser session', async t => {
  const f = await fixture(t, { configure(rpc, cwd) {
    rpc.seed('worker', cwd, true, {
      name: 'Independent review', parentThreadId: 'shared-live', agentNickname: 'Review',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'shared-live', agent_path: '/root/independent_review' } } },
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      turns: [{ id: 'worker-turn', status: 'inProgress', items: Array.from({ length: 101 }, (_, i) => ({ id: `worker-item-${i}`, type: 'agentMessage', text: `Progress ${i}` })) }],
    });
    rpc.seed('nested', cwd, true, { parentThreadId: 'worker' });
    rpc.seed('conflict', cwd, true, { parentThreadId: 'shared-live', source: { subAgent: { thread_spawn: { parent_thread_id: 'saved-only' } } } });
  } });
  assert.equal(f.session.data.capabilities.subagents, true);
  const roster = await f.request('/api/subagents?parent=shared-live');
  assert.equal(roster.status, 200);
  assert.deepEqual(roster.data.agents.map(agent => [agent.id, agent.status.activeFlags]), [['worker', ['waitingOnApproval']]]);
  const path = '/api/subagents?parent=shared-live&thread=worker';
  const first = await f.request(path);
  assert.equal(first.status, 200);
  assert.equal(first.data.agent.name, 'Independent review');
  assert.equal(first.data.turns[0].items.length, 100);
  const cursor = encodeURIComponent(first.data.nextCursor);
  assert.equal((await f.request(`${path}&cursor=${cursor}`)).data.turns[0].items[0].id, 'worker-item-0');
  const other = f.client(); await other('/api/session');
  assert.equal((await other(`${path}&cursor=${cursor}`)).status, 400);
  for (const id of ['nested', 'conflict', 'saved-only']) assert.equal((await f.request(`/api/subagents?parent=shared-live&thread=${id}`)).status, 404);
  assert.deepEqual(mutations(f.rpc), []);
});

test('native activity metadata survives the history response for command summaries and child links', async t => {
  const f = await fixture(t, { configure(rpc) {
    rpc.threads.get('shared-live').turns = [{ id: 'work', status: 'completed', items: [
      { id: 'read', type: 'commandExecution', command: 'cat notes.md', commandActions: [{ type: 'read', path: 'notes.md', name: 'notes.md' }] },
      { id: 'worker', type: 'subAgentActivity', kind: 'started', agentThreadId: 'review', agentPath: '/root/review' },
    ] }];
  } });
  const history = await f.request('/api/history?thread=shared-live');
  const [command, agent] = history.data.turns[0].items;
  assert.equal(command.commandActions[0].name, 'notes.md');
  assert.deepEqual(agent, { id: 'worker', type: 'subAgentActivity', kind: 'started', agentThreadId: 'review', agentPath: '/root/review' });
});

test('shared mode uses native loaded threads and preserves peer-writable conversations without runtime ownership', async t => {
  const f = await fixture(t), caps = f.session.data.capabilities;
  assert.equal(caps.sharedDaemon, true); assert.equal(caps.chatCatalog, true); assert.equal(caps.runtimeManagement, false); assert.equal(caps.archiveManagement, true);
  const list = await f.request('/api/threads'); assert.equal(list.status, 200);
  assert.equal(list.data.data.find(thread => thread.id === 'shared-live').readOnly, false);
  assert.equal(list.data.data.find(thread => thread.id === 'shared-live').nativeLoaded, true);
  assert.equal(list.data.data.find(thread => thread.id === 'saved-only').nativeLoaded, false);
  const overview = await f.request('/api/overview'); assert.equal(overview.status, 200); assert.equal(overview.data.metrics.fixture, true); assert.deepEqual(overview.data.agents.map(row => row.threadId), ['shared-live']);
  await f.request('/api/history?thread=saved-only'); assert.equal(f.relay.state.loadedThreads.has('saved-only'), false); assert.deepEqual(mutations(f.rpc), []);
});

test('resume attaches an already loaded native thread and reads bounded active state and paginated history', async t => {
  const f = await fixture(t, { configure(rpc) { const thread = rpc.threads.get('shared-live'); thread.status = { type: 'active', activeFlags: [] }; thread.turns = [{ id: 'native-current', status: 'inProgress', items: [] }]; } });
  const result = await f.request('/api/resume', { threadId: 'shared-live' }); assert.equal(result.status, 200); assert.equal(result.data.thread.activeTurnId, 'native-current'); assert.equal(result.data.thread.turns[0].id, 'native-current');
  assert.deepEqual(f.rpc.calls.find(call => call.method === 'thread/resume').params, { threadId: 'shared-live', excludeTurns: true });
  assert.ok(f.rpc.calls.some(call => call.method === 'thread/turns/list' && call.params.limit === 1 && call.params.itemsView === 'summary'));
  assert.equal(mutations(f.rpc).length, 1);
});

test('a gateway-created empty draft sends its first turn without trying to resume the unpersisted draft', async t => {
  const f = await fixture(t), created = await f.request('/api/threads', {});
  assert.equal(created.status, 200);
  const result = await f.request('/api/turns', { threadId: created.data.thread.id, text: 'first task', submissionId: 'draft-first' });
  assert.equal(result.status, 200);
  assert.equal(f.rpc.calls.filter(call => call.method === 'thread/resume' && call.params.threadId === created.data.thread.id).length, 0);
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start' && call.params.threadId === created.data.thread.id).length, 1);
});

test('a native turn event supersedes an older metadata read waiting on canonical validation', async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const maps = { authorizedThreads: new Map(), loadedThreads: new Set(), activeTurns: new Map(), busy: new Set(), pendingTurns: new Set(), threadNames: new Map() };
  const control = createSharedThreadControl({ ...maps, rpc: { connected: true, call: async () => ({ thread: { id: 'race', cwd: '/workspace', status: { type: 'idle' }, turns: [] } }) }, canonical: async cwd => { entered(); await gate; return cwd; } });
  const read = control.read('race'); await waiting;
  control.turn('race', { id: 'newer-turn' }, true); maps.activeTurns.set('race', 'newer-turn'); maps.busy.add('race'); release(); await read;
  assert.equal(maps.activeTurns.get('race'), 'newer-turn'); assert.equal(maps.busy.has('race'), true); assert.equal(maps.loadedThreads.has('race'), true); assert.equal(control.agents()[0].status, 'working');
});

test('native events reach two browser clients and one gateway submission creates only one turn', async t => {
  const f = await fixture(t), second = f.client(); await second('/api/session');
  await f.request('/api/resume', { threadId: 'shared-live' });
  const cursor = f.relay.state.events.at(-1)?.id || 0;
  const body = { threadId: 'shared-live', text: 'first', submissionId: 'same-submission' };
  const results = await Promise.all([f.request('/api/turns', body), second('/api/turns', body)]);
  assert.ok(results.every(result => result.status === 200)); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1); assert.equal(results.filter(result => result.data.duplicate).length, 1);
  f.rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'shared-live', turnId: results[0].data.turn.id, itemId: 'item-1', delta: 'from native peer' } });
  await delay(5);
  const pages = await Promise.all([f.request(`/api/poll?cursor=${cursor}&wait=0`), second(`/api/poll?cursor=${cursor}&wait=0`)]);
  for (const page of pages) assert.ok(page.data.events.some(event => event.data.method === 'item/agentMessage/delta' && event.data.params.delta === 'from native peer'));
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('steering is idempotent and sends the native expectedTurnId precondition', async t => {
  const f = await fixture(t); const started = await f.request('/api/turns', { threadId: 'shared-live', text: 'start', submissionId: 'start' });
  const body = { threadId: 'shared-live', turnId: started.data.turn.id, text: 'adjust', submissionId: 'steer' };
  const results = await Promise.all([f.request('/api/steer', body), f.request('/api/steer', body)]); assert.ok(results.every(result => result.status === 200));
  const calls = f.rpc.calls.filter(call => call.method === 'turn/steer'); assert.equal(calls.length, 1); assert.equal(calls[0].params.expectedTurnId, body.turnId); assert.equal(calls[0].params.turnId, undefined);
  assert.equal((await f.request('/api/steer', { ...body, text: 'changed' })).status, 409);
  assert.equal((await f.request('/api/steer', { ...body, submissionId: 'wrong-turn', turnId: 'stale' })).status, 409); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/steer').length, 1);
});

test('explicit reconnect restores native state without replaying an uncertain mutation', async t => {
  const f = await fixture(t); f.rpc.failNextTurn = true;
  const body = { threadId: 'shared-live', text: 'unknown outcome', submissionId: 'uncertain' };
  assert.equal((await f.request('/api/turns', body)).status, 503); assert.equal(f.relay.state.loadedThreads.size, 0);
  const connected = await f.request('/api/connect', {}); assert.equal(connected.status, 200); assert.equal(connected.data.connected, true); assert.equal(f.rpc.starts, 2);
  assert.equal((await f.request('/api/turns', body)).status, 503); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(f.relay.state.loadedThreads.has('shared-live'), true); assert.equal(f.rpc.closes, 0);
});

test('shared runtime lifecycle operations remain unavailable without stopping native processes', async t => {
  const f = await fixture(t);
  for (const [path, body] of [['/api/runtimes/close/preview', { runtimeId: 'unknown' }], ['/api/runtimes/close', { planId: 'unknown' }]]) {
    const result = await f.request(path, body); assert.equal(result.status, 503); assert.match(result.data.error.code, /management_unavailable$/);
  }
  assert.deepEqual(mutations(f.rpc), []);
});

const archiveCalls = rpc => rpc.calls.filter(call => call.method === 'thread/archive');
test('shared archive confirms the complete native spawn cascade, preserves forks and verifies each result once', async t => {
  const f = await fixture(t, { configure(rpc, cwd) {
    rpc.seed('child', cwd, false, { parentThreadId: 'shared-live' }); rpc.seed('grandchild', cwd, false, { parentThreadId: 'child' });
    rpc.seed('old-child', cwd, false, { parentThreadId: 'shared-live', archived: true }); rpc.seed('fork', cwd, false, { forkedFromId: 'shared-live' });
  } });
  const archiveStart = f.rpc.calls.length, preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' });
  assert.equal(preview.status, 200); assert.equal(preview.data.canArchive, true); assert.equal(preview.data.requiresConfirmation, true); assert.equal(preview.data.atomicity, 'gateway-admission-only'); assert.match(preview.data.atomicityMessage, /其他 Codex 客户端/);
  assert.deepEqual(preview.data.affected.map(row => row.id).sort(), ['child', 'grandchild', 'old-child', 'shared-live']); assert.equal(archiveCalls(f.rpc).length, 0);
  const [result, duplicate] = await Promise.all([f.request('/api/library/archive', { planId: preview.data.planId }), f.request('/api/library/archive', { planId: preview.data.planId })]);
  assert.equal(result.status, 200); assert.equal(result.data.status, 'complete'); assert.deepEqual(duplicate.data, result.data); assert.equal(archiveCalls(f.rpc).length, 1);
  assert.equal(result.data.affected.find(row => row.id === 'old-child').status, 'alreadyArchived'); assert.equal(f.rpc.threads.get('fork').archived, undefined); assert.equal(result.data.freezeRetained, false); assert.equal(f.rpc.closes, 0); assert.equal(f.rpc.answers.length, 0); assert.deepEqual(mutations(f.rpc), []);
  for (const call of f.rpc.calls.slice(archiveStart).filter(call => call.method === 'thread/list')) assert.equal(call.params.useStateDbOnly, true);
});

test('an active, approval-waiting or input-waiting descendant blocks the entire shared archive without declining requests', async t => {
  for (const activeFlags of [[], ['waitingOnApproval'], ['waitingOnUserInput']]) {
    const f = await fixture(t, { configure(rpc, cwd) { rpc.seed('active-child', cwd, true, { parentThreadId: 'shared-live', status: { type: 'active', activeFlags }, turns: [{ id: 'child-turn', status: 'inProgress', items: [] }] }); } });
    const preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' });
    assert.equal(preview.status, 200); assert.equal(preview.data.canArchive, false); assert.equal(preview.data.planId, null); assert.ok(preview.data.blockedReasons.some(reason => reason.code === 'archive_thread_active' && reason.threadIds.includes('active-child'))); assert.equal(archiveCalls(f.rpc).length, 0); assert.equal(f.rpc.answers.length, 0); assert.equal(f.rpc.closes, 0);
  }
});

test('shared archive requires fresh confirmation after native task history or descendant topology changes', async t => {
  for (const change of [f => { f.rpc.threads.get('shared-live').turns = [{ id: 'new-native-turn', status: 'completed', items: [] }]; }, f => { f.rpc.threads.get('shared-live').status = { type: 'active', activeFlags: [] }; }, f => f.rpc.seed('new-child', f.cwd, false, { parentThreadId: 'shared-live' })]) {
    const f = await fixture(t), preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' }); assert.equal(preview.data.canArchive, true); change(f);
    const result = await f.request('/api/library/archive', { planId: preview.data.planId }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'archive_plan_changed'); assert.equal(archiveCalls(f.rpc).length, 0); assert.equal(f.rpc.closes, 0);
  }
});

test('partial native archive remains explicit for every confirmed child and recheck never repeats archive', async t => {
  const f = await fixture(t, { configure(rpc, cwd) {
    rpc.seed('left-child', cwd, false, { parentThreadId: 'shared-live' }); const call = rpc.call.bind(rpc);
    rpc.call = async (method, params) => { if (method !== 'thread/archive') return call(method, params); rpc.calls.push({ method, params: clone(params) }); rpc.threads.get(params.threadId).archived = true; return {}; };
  } });
  const preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' }), result = await f.request('/api/library/archive', { planId: preview.data.planId });
  assert.equal(result.status, 200); assert.equal(result.data.status, 'partial'); assert.equal(result.data.freezeRetained, false); assert.equal(result.data.affected.find(row => row.id === 'shared-live').status, 'archived'); assert.equal(result.data.affected.find(row => row.id === 'left-child').status, 'notArchived');
  const checked = await f.request('/api/library/archive/recheck', { operationId: result.data.operationId }); assert.equal(checked.data.status, 'partial'); assert.equal(archiveCalls(f.rpc).length, 1);
});

test('an uncertain shared archive freezes gateway writes until read-only recheck proves the outcome', async t => {
  const f = await fixture(t, { configure(rpc) {
    const call = rpc.call.bind(rpc); rpc.call = async (method, params) => { if (method !== 'thread/archive') return call(method, params); rpc.calls.push({ method, params: clone(params) }); throw new RelayError(504, 'rpc_timeout', 'Unknown archive outcome'); };
  } });
  const preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' }), result = await f.request('/api/library/archive', { planId: preview.data.planId });
  assert.equal(result.data.status, 'unknown'); assert.equal(result.data.freezeRetained, true);
  for (const [path, body] of [['/api/turns', { threadId: 'shared-live', text: 'must not send', submissionId: 'frozen-turn' }], ['/api/resume', { threadId: 'shared-live' }], ['/api/threads/metadata', { threadId: 'shared-live', name: 'must not change' }]]) {
    const blocked = await f.request(path, body); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'thread_frozen');
  }
  assert.equal(mutations(f.rpc).length, 0); assert.equal((await f.request('/api/session')).data.pendingArchiveOperations.length, 1);
  const thread = f.rpc.threads.get('shared-live'); thread.archived = true; thread.status = { type: 'notLoaded' }; f.rpc.loaded.delete(thread.id);
  const checked = await f.request('/api/library/archive/recheck', { operationId: result.data.operationId }); assert.equal(checked.data.status, 'complete'); assert.equal(checked.data.freezeRetained, false); assert.equal(archiveCalls(f.rpc).length, 1);
});

test('a child appearing at the native archive boundary prevents a complete claim after the unconfirmed cascade', async t => {
  const f = await fixture(t, { configure(rpc, cwd) { const call = rpc.call.bind(rpc); rpc.call = async (method, params) => { if (method === 'thread/archive') rpc.seed('unconfirmed-child', cwd, false, { parentThreadId: params.threadId }); return call(method, params); }; } });
  const preview = await f.request('/api/library/archive/preview', { threadId: 'shared-live' }), result = await f.request('/api/library/archive', { planId: preview.data.planId });
  assert.equal(result.data.status, 'unknown'); assert.equal(result.data.freezeRetained, true); assert.equal(archiveCalls(f.rpc).length, 1); assert.ok(result.data.reports.some(report => report.phase === 'nativeScopeVerification' && report.status === 'changed' && report.unconfirmedThreadIds.includes('unconfirmed-child')));
});

test('native approvals and questions remain pending for both clients and answers are bounded and consumed once', async t => {
  const f = await fixture(t); const started = await f.request('/api/turns', { threadId: 'shared-live', text: 'start', submissionId: 'request-start' }), turnId = started.data.turn.id;
  const params = { threadId: 'shared-live', turnId, itemId: 'question-item', isBlocking: true, questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', isOther: false, isSecret: false, options: [{ label: 'A', description: 'Option A' }] }] };
  f.rpc.emit('userInput', { id: 'shared-gen-1-question', method: 'item/tool/requestUserInput', params }); await delay(5);
  const second = f.client(), session = await second('/api/session'); assert.equal(session.data.pendingUserInputs.length, 1);
  assert.equal((await second('/api/user-input', { requestId: 'shared-gen-1-question', answers: { wrong: { answers: ['A'] } } })).status, 400);
  assert.equal((await second('/api/user-input', { requestId: 'shared-gen-1-question', answers: { choice: { answers: ['B'] } } })).status, 400);
  const answers = { requestId: 'shared-gen-1-question', answers: { choice: { answers: ['A'] } } };
  assert.equal((await second('/api/user-input', answers)).status, 200); assert.equal((await f.request('/api/user-input', answers)).status, 409); assert.equal(f.rpc.answers.length, 1);
  f.rpc.emit('userInput', { id: 'shared-gen-1-other-question', method: 'item/tool/requestUserInput', params }); await delay(5);
  f.rpc.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'shared-live', requestId: 'shared-gen-1-other-question' } }); await delay(5);
  assert.equal((await f.request('/api/session')).data.pendingUserInputs.length, 0);
  f.rpc.emit('approval', { id: 'unverified-approval', method: 'item/commandExecution/requestApproval', params: { ...params, turnId: 'stale-turn' } });
  f.rpc.emit('unsupported', { method: 'unknown/nativeRequest', threadId: 'shared-live', requestId: 'unsupported' }); await delay(5); assert.equal(f.rpc.answers.length, 1);
});
