import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../src/server.mjs';
import { PINNED_THREAD_SECTION_ID } from '../src/projects.mjs';

const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
const clone = value => structuredClone(value);

class CatalogRpc extends EventEmitter {
  connected = false; ended = false; calls = []; runs = []; projects = new Map(); threads = new Map(); preferences = new Map(); requests = new Map(); presence = new Map(); sequence = 0;
  async start() { this.connected = true; }
  close() { this.connected = false; this.ended = true; }
  async listRuns() { return clone(this.runs); }
  async replayThread(threadId) { this.calls.push({ method: 'replayThread', params: { threadId } }); }
  async answer() {}
  async getKeepRunning(threadId) { return { threadId, keepRunning: this.preferences.get(threadId) || false }; }
  async setKeepRunning(threadId, keepRunning) { this.preferences.set(threadId, keepRunning); for (const run of this.runs) if (run.threadId === threadId) run.keepRunning = keepRunning; this.calls.push({ method: 'setKeepRunning', params: { threadId, keepRunning } }); return { threadId, keepRunning }; }
  async setWebPresence(clientId, threadId) {
    this.calls.push({ method: 'setWebPresence', params: { clientId, threadId } });
    if (threadId === null) this.presence.delete(clientId); else this.presence.set(clientId, threadId);
    return { threadId, connected: threadId !== null, leaseMs: 90000 };
  }
  async reapRun(id, revision, options) { const threadId = this.runs.find(run => run.id === id)?.threadId; this.calls.push({ method: 'reapRun', params: { id, revision, options } }); this.runs = this.runs.filter(run => run.id !== id); this.onReaped?.(); return { id, threadId, stopped: true }; }
  seed(id, cwd, extra = {}) { const thread = { id, cwd, name: id, source: 'cli', projectId: null, section: null, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns: [], ...extra }; this.threads.set(id, thread); return thread; }
  addRun(thread) { const run = { id: `run-${thread.id}`, runtimeId: `run-${thread.id}`, threadId: thread.id, cwd: thread.cwd, managed: true, pid: 1000 + this.runs.length, status: 'idle', tmuxState: 'attached', tmux: { sessionId: `$${this.runs.length + 1}`, target: `$${this.runs.length + 1}:0.0` }, revision: 'fixture-revision' }; this.runs.push(run); return run; }
  async call(method, params = {}) {
    this.calls.push({ method, params: clone(params) });
    if (method === 'threadSection/list') return { data: [{ id: PINNED_THREAD_SECTION_ID, name: 'Pinned' }], nextCursor: null };
    if (method === 'project/list') { const data = [...this.projects.values()], from = Number(params.cursor || 0), limit = params.limit || 50; return { data: clone(data.slice(from, from + limit)), nextCursor: from + limit < data.length ? String(from + limit) : null }; }
    if (method === 'project/create') {
      const previous = this.requests.get(params.idempotencyKey); if (previous) return { project: clone(this.projects.get(previous)) };
      const project = { id: `project-${++this.sequence}`, name: params.name, roots: clone(params.roots), createdAt: 1, updatedAt: 2 };
      this.projects.set(project.id, project); this.requests.set(params.idempotencyKey, project.id); return { project: clone(project) };
    }
    if (method === 'project/read' || method === 'project/update') { const project = this.projects.get(params.projectId); if (!project) throw Error('Project missing'); if (method === 'project/update') for (const key of ['name', 'roots']) if (Object.hasOwn(params, key)) project[key] = clone(params[key]); return { project: clone(project) }; }
    if (method === 'thread/list') {
      const data = [...this.threads.values()].filter(thread => !params.cwd || thread.cwd === params.cwd).filter(thread => !!thread.archived === !!params.archived).filter(thread => !Object.hasOwn(params, 'projectId') || thread.projectId === params.projectId).filter(thread => !Object.hasOwn(params, 'sectionId') || (thread.section?.id || null) === params.sectionId).filter(thread => !params.searchTerm || thread.name.toLowerCase().includes(params.searchTerm.toLowerCase()));
      const from = Number(params.cursor || 0), limit = params.limit || 50; return { data: clone(data.slice(from, from + limit)), nextCursor: from + limit < data.length ? String(from + limit) : null };
    }
    if (method === 'thread/start') { const thread = this.seed(`created-${++this.sequence}`, params.cwd, { projectId: params.projectId ?? null, source: 'appServer' }); this.addRun(thread); return { thread: clone(thread) }; }
    const thread = this.threads.get(params.threadId);
    if (!thread) throw Error(`Thread missing: ${params.threadId}`);
    if (method === 'thread/read') return { thread: clone(thread) };
    if (method === 'thread/resume') { if (!this.runs.some(run => run.threadId === thread.id)) this.addRun(thread); return { thread: clone(thread) }; }
    if (method === 'thread/turns/list') return { data: clone(thread.turns), nextCursor: null };
    if (method === 'thread/metadata/update') { thread.projectId = params.projectId || null; return { thread: clone(thread) }; }
    if (method === 'thread/name/set') { thread.name = params.name; return {}; }
    if (method === 'thread/section/move') { thread.section = params.sectionId ? { id: params.sectionId, name: 'Pinned' } : null; return {}; }
    if (method === 'turn/start') { const turn = { id: `turn-${++this.sequence}`, status: 'inProgress', items: [] }; thread.turns.unshift(turn); const run = this.runs.find(row => row.threadId === thread.id); if (run) { run.status = 'working'; run.activeTurnId = turn.id; } return { turn }; }
    throw Error(`Unexpected catalog RPC: ${method}`);
  }
}

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(join(tmpdir(), 'relay-catalog-api-'));
  assert.ok(relative(tmpdir(), base).startsWith('relay-catalog-api-'));
  const a = join(base, 'alpha'), b = join(base, 'beta'); await Promise.all([a, b].map(path => fs.mkdir(path)));
  const [root, cwdA, cwdB] = await Promise.all([base, a, b].map(path => fs.realpath(path)));
  const rpc = new CatalogRpc();
  options.configureRpc?.(rpc, { root, a: cwdA, b: cwdB });
  const control = { complete: true, holders: [], frozen: new Set() };
  const runControl = {
    list: async () => clone(rpc.runs), inspectWriters: async () => ({ complete: control.complete, holders: clone(control.holders) }), isFrozen: async id => control.frozen.has(id),
    previewClose: async runtimeId => ({ planId: `stop-${runtimeId}`, scope: 'pane', affectedThreads: rpc.runs.filter(run => run.runtimeId === runtimeId).map(run => ({ id: run.threadId })), otherPanesPreserved: true }),
    close: async planId => { rpc.runs = rpc.runs.filter(run => `stop-${run.runtimeId}` !== planId); return { status: 'closed', affected: [], reports: [] }; }
  };
  const config = { chatCatalog: true, transport: 'local', workspace: { roots: [root], defaultCwd: cwdA }, projects: [{ id: 'legacy-seed', name: 'Legacy seed', cwd: cwdA }], ...(options.production ? { remoteCodex: '/opt/codex/bin/codex', publicOrigin: 'https://relay.test.example', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } } : {}) };
  const relay = await createRelay({ mock: !options.production, port: 0, config, rpc, env, runtimeManagement: true, runControl, archiveService: { listOperations: async () => [] }, observeExternalThreads: options.observeExternalThreads || (async () => ({ agents: [], complete: true })), overviewCollector: async () => ({ agents: [], metrics: {} }), projectStoreFile: null, ...options.relay });
  t.after(async () => { await relay.close(); await fs.rm(base, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = (path, body, overrides = {}) => new Promise((resolve, reject) => {
    const req = http.request(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(relay.publicOrigin).host, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...overrides } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; if (data.csrf) csrf = data.csrf; resolve({ status: res.statusCode, data }); });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const session = await request('/api/session');
  return { relay, rpc, request, session, control, root, a: cwdA, b: cwdB, credentials: () => ({ Cookie: cookie, 'X-CSRF-Token': csrf }) };
}

async function createProject(f, name = 'Group') { const result = await f.request('/api/projects', { name, defaultCwd: null, idempotencyKey: `create-${name}` }); assert.equal(result.status, 200); return result.data.project; }
const starts = f => f.rpc.calls.filter(call => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method));

test('catalog refuses organizing an unpersisted worker draft before any native metadata write', async t => {
  const f = await fixture(t, { configureRpc(rpc, paths) {
    const thread = rpc.seed('pending-draft', paths.a); rpc.addRun(thread);
    const call = rpc.call.bind(rpc);
    rpc.call = async (method, params) => {
      const result = await call(method, params);
      if (method === 'thread/list') result.data = result.data.filter(row => row.id !== thread.id);
      return result;
    };
  } });
  const result = await f.request('/api/threads/metadata', {threadId:'pending-draft',name:'Unsaved title',pinned:true});
  assert.equal(result.status,409); assert.equal(result.data.error.code,'thread_unpersisted');
  assert.equal(f.rpc.calls.some(call => ['thread/name/set','thread/metadata/update','thread/section/move'].includes(call.method)),false);
});

test('catalog starts with no native projects and an unassigned chat uses the independent workspace cwd', async t => {
  const f = await fixture(t);
  assert.equal(f.session.status, 200); assert.deepEqual(f.session.data.projects, []); assert.equal(f.session.data.capabilities.chatCatalog, true); assert.equal(f.session.data.capabilities.library, true); assert.equal(f.session.data.capabilities.runtimeIdleMinutes, 120);
  assert.deepEqual((await f.request('/api/projects')).data.projects, []);
  const created = await f.request('/api/threads', {});
  assert.equal(created.status, 200); assert.equal(created.data.thread.projectId, null); assert.equal(created.data.thread.cwd, f.a); assert.equal(created.data.runtime.threadId, created.data.thread.id); assert.match(created.data.runtime.tmux.target, /^\$\d+:0\.0$/);
  assert.equal(f.rpc.projects.size, 0); assert.equal(f.rpc.calls.some(call => call.method === 'project/create'), false);
});

test('catalog grouping and cwd stay independent through create, rename, pin, move and project edit', async t => {
  const f = await fixture(t), first = await createProject(f, 'First'), second = await createProject(f, 'Second');
  assert.equal(first.defaultCwd, null);
  const created = await f.request('/api/threads', { projectId: first.id, cwd: f.b });
  assert.equal(created.status, 200); assert.equal(created.data.thread.projectId, first.id); assert.equal(created.data.thread.cwd, f.b);
  const id = created.data.thread.id;
  const moved = await f.request('/api/threads/metadata', { threadId: id, name: 'Renamed task', pinned: true, projectId: second.id });
  assert.equal(moved.status, 200); assert.equal(moved.data.thread.id, id); assert.equal(moved.data.thread.cwd, f.b); assert.equal(moved.data.thread.projectId, second.id); assert.equal(moved.data.thread.pinned, true); assert.equal(moved.data.thread.name, 'Renamed task');
  assert.equal((await f.request('/api/threads/metadata', { threadId: id, projectId: null, cwd: f.a })).status, 400);
  assert.equal(f.rpc.threads.get(id).cwd, f.b);
  assert.equal((await f.request('/api/projects/update', { projectId: second.id, name: 'New project name', defaultCwd: null })).status, 200);
  assert.equal(f.rpc.threads.get(id).cwd, f.b); assert.equal(f.rpc.threads.get(id).projectId, second.id);
  const unassigned = await f.request('/api/threads/metadata', { threadId: id, projectId: null }); assert.equal(unassigned.data.thread.projectId, null); assert.equal(unassigned.data.thread.cwd, f.b);
});

test('catalog metadata reads use the authoritative library connection when a worker holds older metadata', async t => {
  const f = await fixture(t, { configureRpc(rpc, { a }) {
    const officialCall = rpc.call.bind(rpc); rpc.library = { call: officialCall };
    rpc.call = async (method, params) => { const result = await officialCall(method, params); if (method === 'thread/read') result.thread = { ...result.thread, name: 'Stale worker title', projectId: null, section: null }; return result; };
    rpc.seed('authority', a);
  } });
  const project = await createProject(f, 'Authority');
  const updated = await f.request('/api/threads/metadata', { threadId: 'authority', name: 'Official current title', projectId: project.id, pinned: true });
  assert.equal(updated.status, 200); assert.equal(updated.data.thread.name, 'Official current title'); assert.equal(updated.data.thread.projectId, project.id); assert.equal(updated.data.thread.pinned, true);
  const history = await f.request('/api/resume', { threadId: 'authority' }); assert.equal(history.status, 200); assert.equal(history.data.thread.name, 'Official current title'); assert.equal(history.data.thread.projectId, project.id); assert.equal(history.data.thread.pinned, true); assert.equal(history.data.thread.cwd, f.a);
  assert.equal(starts(f).length, 0);
});

test('catalog native title, pinned and unassigned filters bind opaque pagination to every filter', async t => {
  const f = await fixture(t), project = await createProject(f);
  for (let n = 0; n < 51; n++) f.rpc.seed(`matching-${n}`, n % 2 ? f.a : f.b, { name: `Needle ${n}` });
  f.rpc.seed('grouped', f.a, { name: 'Needle grouped', projectId: project.id });
  f.rpc.seed('pinned', f.b, { name: 'Needle pinned', projectId: project.id, section: { id: PINNED_THREAD_SECTION_ID, name: 'Pinned' } });
  f.rpc.seed('other', f.a, { name: 'Different title' });
  const first = await f.request('/api/threads?project=unassigned&archived=false&search=Needle');
  assert.equal(first.status, 200); assert.equal(first.data.data.length, 50); assert.ok(first.data.data.every(thread => thread.projectId === null)); assert.ok(first.data.nextCursor); assert.notEqual(first.data.nextCursor, '50');
  const lastList = f.rpc.calls.filter(call => call.method === 'thread/list').at(-1).params;
  assert.equal(lastList.projectId, null); assert.equal(lastList.searchTerm, 'Needle'); assert.equal(Object.hasOwn(lastList, 'cwd'), false);
  const cursor = encodeURIComponent(first.data.nextCursor);
  for (const query of [`project=all&archived=false&search=Needle`, `project=unassigned&archived=true&search=Needle`, `project=unassigned&archived=false&search=Other`, `project=unassigned&archived=false&search=Needle&pinned=true`]) assert.equal((await f.request(`/api/threads?${query}&cursor=${cursor}`)).status, 400);
  const second = await f.request(`/api/threads?project=unassigned&archived=false&search=Needle&cursor=${cursor}`); assert.deepEqual(second.data.data.map(thread => thread.id), ['matching-50']); assert.equal(second.data.nextCursor, null);
  const pinned = await f.request('/api/threads?project=all&archived=false&pinned=true'); assert.deepEqual(pinned.data.data.map(thread => thread.id), ['pinned']); assert.equal(pinned.data.data[0].pinned, true);
  assert.equal(f.rpc.calls.filter(call => call.method === 'thread/list').at(-1).params.sectionId, PINNED_THREAD_SECTION_ID);
  assert.equal((await f.request('/api/threads?project=all&pinned=false')).status, 400);
});

test('catalog history stays readable across stopped, missing cwd and external conversations without starting any run', async t => {
  const f = await fixture(t);
  const saved = [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-message', type: 'agentMessage', text: 'Saved history' }] }];
  f.rpc.seed('stopped', f.a, { turns: saved }); f.rpc.seed('missing', join(f.root, 'missing'), { turns: saved });
  for (const id of ['stopped', 'missing']) {
    const view = await f.request('/api/resume', { threadId: id }); assert.equal(view.status, 200); assert.equal(view.data.thread.turns[0].items[0].text, 'Saved history'); if (id === 'missing') assert.equal(view.data.thread.unavailable, true);
    assert.equal((await f.request(`/api/history?thread=${id}`)).status, 200);
  }
  assert.equal(f.rpc.runs.length, 0); assert.equal(starts(f).length, 0); assert.equal(f.rpc.projects.size, 0);
});

test('catalog stopping keeps history, then first send resumes the original thread id and deduplicates retries', async t => {
  const f = await fixture(t); const original = f.rpc.seed('old-history', f.b, { turns: [{ id: 'saved', status: 'completed', items: [] }] }); f.rpc.addRun(original);
  const preview = await f.request('/api/runtimes/close/preview', { runtimeId: 'run-old-history' }); assert.equal(preview.status, 200); assert.equal(f.rpc.runs.length, 1);
  assert.equal((await f.request('/api/runtimes/close', { planId: preview.data.planId })).data.status, 'closed'); assert.equal(f.rpc.runs.length, 0);
  const view = await f.request('/api/resume', { threadId: original.id }); assert.equal(view.data.thread.turns[0].id, 'saved'); assert.equal(starts(f).length, 0);
  const body = { threadId: original.id, text: 'Continue the same work', submissionId: 'resume-original' };
  const sent = await f.request('/api/turns', body); assert.equal(sent.status, 200); assert.equal(sent.data.thread.id, original.id); assert.equal(sent.data.thread.cwd, f.b); assert.equal(sent.data.runtime.threadId, original.id);
  assert.equal(f.rpc.calls.filter(call => call.method === 'thread/resume').length, 1); assert.equal(f.rpc.calls.find(call => call.method === 'thread/resume').params.threadId, original.id); assert.equal(f.rpc.calls.some(call => call.method === 'thread/start'), false);
  const retry = await f.request('/api/turns', body); assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal((await f.request('/api/turns', { ...body, text: 'Different payload' })).status, 409);
});

for (const reason of ['archived', 'foreign', 'outside', 'incomplete', 'external', 'frozen']) test(`catalog ${reason} admission cannot start or resume a runtime`, async t => {
  const f = await fixture(t); const id = `blocked-${reason}`; f.rpc.seed(id, reason === 'outside' ? tmpdir() : f.a, { ...(reason === 'archived' ? { archived: true } : {}) });
  if (reason === 'foreign') { const call = f.rpc.call.bind(f.rpc); f.rpc.call = async (method, params) => { const result = await call(method, params); if (method === 'thread/list') result.data = result.data.filter(thread => thread.id !== id); return result; }; }
  if (reason === 'incomplete') f.control.complete = false;
  if (reason === 'external') f.control.holders = [{ threadId: id, managed: false, pid: 4001 }];
  if (reason === 'frozen') f.control.frozen.add(id);
  const result = await f.request('/api/turns', { threadId: id, text: 'Must not run', submissionId: 'blocked-attempt' });
  const codes = { archived: 'thread_archived', foreign: 'thread_not_in_library', outside: 'workspace_forbidden', incomplete: 'writer_observation_incomplete', external: 'external_thread_open', frozen: 'thread_frozen' };
  assert.equal(result.data.error?.code, codes[reason], JSON.stringify(result)); assert.equal(starts(f).length, 0); assert.equal(f.rpc.runs.length, 0);
});

test('catalog observed external writers mark history read-only and cannot send concurrently', async t => {
  const f = await fixture(t, { observeExternalThreads: async () => ({ agents: [{ threadId: 'external', pid: 4002 }], complete: true }) }); f.rpc.seed('external', f.a);
  const history = await f.request('/api/resume', { threadId: 'external' }); assert.equal(history.status, 200); assert.equal(history.data.thread.readOnly, true); assert.equal(history.data.thread.readOnlyReason, 'external_thread_open');
  const result = await f.request('/api/turns', { threadId: 'external', text: 'Must not run', submissionId: 'external-attempt' }); assert.equal(result.data.error.code, 'external_thread_open'); assert.equal(starts(f).length, 0);
});

test('catalog keep-running is a per-thread preference, visible on history and independent from grouping', async t => {
  const f = await fixture(t); f.rpc.seed('one', f.a); f.rpc.seed('two', f.a);
  assert.deepEqual((await f.request('/api/threads/keep-running', { threadId: 'one', keepRunning: true })).data, { threadId: 'one', keepRunning: true });
  const view = await f.request('/api/resume', { threadId: 'one' }); assert.equal(view.data.thread.keepRunning, true); assert.equal(view.data.thread.projectId, null);
  assert.equal((await f.request('/api/resume', { threadId: 'two' })).data.thread.keepRunning, false);
  assert.equal((await f.request('/api/threads/keep-running', { threadId: 'one', keepRunning: 'true' })).status, 400);
  assert.equal((await f.request('/api/threads/keep-running', { threadId: 'one', keepRunning: false, force: true })).status, 400);
  assert.equal(starts(f).length, 0);
});

test('web presence is scoped to the authenticated browser and tab without starting a runtime', async t => {
  const f = await fixture(t); f.rpc.seed('viewed', f.a); f.rpc.seed('other', f.b);
  assert.equal(f.session.data.capabilities.runtimePresence, true);
  const body = { clientId: 'browser-tab-00001', threadId: 'viewed' };
  assert.deepEqual((await f.request('/api/runtime-presence', body)).data, { threadId: 'viewed', connected: true, leaseMs: 90000 });
  const firstCredentials = f.credentials(), firstKey = [...f.rpc.presence.keys()][0];
  assert.match(firstKey, /^[a-f0-9]{64}$/); assert.notEqual(firstKey, body.clientId);
  const reads = f.rpc.calls.filter(call => call.method === 'thread/read').length;
  await f.request('/api/runtime-presence', body);
  assert.equal(f.rpc.calls.filter(call => call.method === 'thread/read').length, reads, 'a renewal does not reread or resume history');
  await f.request('/api/runtime-presence', { ...body, clientId: 'browser-tab-00002' });
  assert.equal(f.rpc.presence.size, 2);
  await f.request('/api/session', undefined, { Cookie: '' });
  await f.request('/api/runtime-presence', body);
  assert.equal(f.rpc.presence.size, 3, 'same client id in a different browser cannot replace the first browser');
  await f.request('/api/runtime-presence', { ...body, threadId: 'other' }, firstCredentials);
  assert.equal(f.rpc.presence.get(firstKey), 'other');
  await f.request('/api/runtime-presence', { ...body, threadId: null }, firstCredentials);
  assert.equal(f.rpc.presence.has(firstKey), false); assert.equal(f.rpc.presence.size, 2);
  assert.equal(starts(f).length, 0);
});

test('web presence rejects extra clocks, invalid identifiers and inaccessible threads before a lease write', async t => {
  const f = await fixture(t); f.rpc.seed('saved', f.a);
  for (const body of [{ clientId: 'tiny', threadId: 'saved' }, { clientId: 'browser-tab-00001', threadId: '../foreign' }, { clientId: 'browser-tab-00001', threadId: 'saved', expiresAt: 9999999999999 }]) {
    assert.equal((await f.request('/api/runtime-presence', body)).status, 400);
  }
  assert.notEqual((await f.request('/api/runtime-presence', { clientId: 'browser-tab-00001', threadId: 'missing' })).status, 200);
  assert.equal(f.rpc.presence.size, 0); assert.equal(f.rpc.calls.some(call => call.method === 'setWebPresence'), false);
});

test('logout releases all its tabs while a delayed lease write cannot recreate the logged-out connection', async t => {
  const f = await fixture(t); f.rpc.seed('saved', f.a);
  await f.request('/api/runtime-presence', { clientId: 'browser-tab-00001', threadId: 'saved' });
  let entered, finish;
  const began = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { finish = resolve; });
  const setter = f.rpc.setWebPresence.bind(f.rpc);
  f.rpc.setWebPresence = async (clientId, threadId) => { if (threadId !== null) { entered(); await barrier; } return setter(clientId, threadId); };
  const late = f.request('/api/runtime-presence', { clientId: 'browser-tab-00002', threadId: 'saved' });
  await began; assert.equal((await f.request('/api/logout', {})).status, 200); finish();
  assert.equal((await late).status, 401);
  for (let tries = 0; tries < 30 && f.rpc.presence.size; tries++) await delay(5);
  assert.equal(f.rpc.presence.size, 0);
});

test('web presence expires with the login session and enforces a bounded tab count', async t => {
  let now = 1000;
  const f = await fixture(t, { relay: { clock: () => now, maintenanceMs: 10, idleTtlMs: 1000, sessionTtlMs: 10000 } });
  f.rpc.seed('saved', f.a);
  for (let index = 0; index < 16; index++) assert.equal((await f.request('/api/runtime-presence', { clientId: `browser-tab-${String(index).padStart(5, '0')}`, threadId: 'saved' })).status, 200);
  assert.equal((await f.request('/api/runtime-presence', { clientId: 'browser-tab-over-limit', threadId: 'saved' })).status, 429);
  assert.equal(f.rpc.presence.size, 16); now += 1000;
  await delay(30); assert.equal(f.rpc.presence.size, 0);
});

test('catalog archived metadata and keep-running requests are rejected before every write', async t => {
  const f = await fixture(t), original = await createProject(f, 'Original'), target = await createProject(f, 'Target');
  f.rpc.seed('archived-edit', f.a, { name: 'Saved title', archived: true, projectId: original.id });
  const before = clone(f.rpc.threads.get('archived-edit'));
  const metadata = await f.request('/api/threads/metadata', { threadId: 'archived-edit', name: 'Must not save', projectId: target.id, pinned: true });
  assert.equal(metadata.status, 409); assert.equal(metadata.data.error.code, 'thread_archived'); assert.deepEqual(f.rpc.threads.get('archived-edit'), before);
  const preference = await f.request('/api/threads/keep-running', { threadId: 'archived-edit', keepRunning: true });
  assert.equal(preference.status, 409); assert.equal(preference.data.error.code, 'thread_archived'); assert.equal(f.rpc.preferences.has('archived-edit'), false);
  assert.equal(f.rpc.calls.some(call => ['thread/metadata/update', 'thread/name/set', 'thread/section/move', 'setKeepRunning'].includes(call.method)), false);
  const history = await f.request('/api/resume', { threadId: 'archived-edit' }); assert.equal(history.status, 200); assert.equal(history.data.thread.archived, true); assert.equal(history.data.thread.name, 'Saved title'); assert.equal(history.data.thread.projectId, original.id);
});

test('catalog authentication, CSRF and parameter whitelists protect every metadata and runtime entry', async t => {
  const f = await fixture(t, { production: true }); f.rpc.seed('saved', f.a);
  assert.equal(f.session.data.authenticated, false); assert.deepEqual(f.session.data.projects, []); assert.equal(f.session.data.workspace, undefined); assert.equal(f.rpc.calls.length, 0);
  const actions = [['/api/projects', { name: 'Private' }], ['/api/projects/update', { projectId: 'no-project', name: 'Private' }], ['/api/threads/metadata', { threadId: 'saved', pinned: true }], ['/api/threads/keep-running', { threadId: 'saved', keepRunning: true }], ['/api/runtime-presence', { clientId: 'browser-tab-00001', threadId: 'saved' }], ['/api/threads', { cwd: f.a }], ['/api/turns', { threadId: 'saved', submissionId: 'private', text: 'Private' }]];
  for (const [path, body] of actions) assert.equal((await f.request(path, body)).status, 401);
  assert.equal((await f.request('/api/threads?project=all&archived=false&search=Private')).status, 401); assert.equal(f.rpc.calls.length, 0);
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET })).status, 200);
  for (const [path, body] of actions) assert.equal((await f.request(path, body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/threads/metadata', { threadId: 'saved', pinned: true }, { Origin: 'https://other.example' })).status, 403);
  for (const [path, body] of [['/api/threads', { cwd: f.a, model: 'forbidden' }], ['/api/threads/metadata', { threadId: 'saved', cwd: f.b }], ['/api/turns', { threadId: 'saved', text: 'x', submissionId: 'one', cwd: f.b }]]) assert.equal((await f.request(path, body)).status, 400);
  assert.equal((await f.request('/api/threads?project=all&search=one&search=two')).status, 400); assert.equal(starts(f).length, 0);
});

test('catalog gateway maintenance defaults to 120 minutes and skips keep-running, working, external and unverified runs', async t => {
  let now = 1000;
  const f = await fixture(t, { relay: { clock: () => now, maintenanceMs: 10, idleTtlMs: 86400000, sessionTtlMs: 86400000 } });
  const idleSince = now;
  for (const id of ['eligible', 'keep', 'working', 'external', 'unverified', 'connected', 'old-worker', 'new-output']) { const thread = f.rpc.seed(id, f.a), run = f.rpc.addRun(thread); run.lifecycle = { version: 2, idleSince, lastOutputAt: idleSince, terminalSavedAt: idleSince }; if (id === 'connected') run.webConnected = true; if (id === 'old-worker') run.lifecycle.version = 1; if (id === 'new-output') run.lifecycle.lastOutputAt = idleSince + 60000; if (id === 'keep') run.keepRunning = true; if (id === 'working') { run.status = 'working'; run.activeTurnId = 'active'; } if (id === 'external') run.managed = false; if (id === 'unverified') delete run.lifecycle.terminalSavedAt; }
  now = idleSince + 119 * 60 * 1000; await delay(25); assert.equal(f.rpc.calls.some(call => call.method === 'reapRun'), false);
  const reaped = new Promise(resolve => { f.rpc.onReaped = resolve; }); now = idleSince + 120 * 60 * 1000;
  await Promise.race([reaped, delay(500).then(() => { throw Error('gateway maintenance did not reap eligible idle run'); })]);
  const calls = f.rpc.calls.filter(call => call.method === 'reapRun'); assert.deepEqual(calls.map(call => call.params.id), ['run-eligible']); assert.equal(calls[0].params.options.idleMs, 120 * 60 * 1000); assert.equal(calls[0].params.revision, 'fixture-revision'); assert.equal(f.rpc.threads.has('eligible'), true);
  assert.deepEqual(f.rpc.runs.map(run => run.threadId).sort(), ['connected', 'external', 'keep', 'new-output', 'old-worker', 'unverified', 'working']);
  for (let tries = 0; tries < 20 && !f.relay.state.events.some(event => event.data.status === 'runtime-cleaned'); tries++) await delay(5);
  assert.deepEqual(f.relay.state.events.find(event => event.data.status === 'runtime-cleaned').data.closedRuntimes, [{ runtimeId: 'run-eligible', threadId: 'eligible' }]);
});

test('maintenance closed identities include only confirmed stopped receipts with complete IDs', async t => {
  let enabled = false, returned = false;
  const f = await fixture(t, { configureRpc(rpc) { rpc.cleanupStaleRuns = async () => {
    if (!enabled || returned) return []; returned = true;
    return [{ id: 'confirmed-absent', threadId: 'saved', stopped: true, reason: 'already_absent' }, { id: 'still-unknown', threadId: 'saved', stopped: false }, { id: 'missing-thread', stopped: true }, { id: 'truthy-status', threadId: 'saved', stopped: 'yes' }];
  }; }, relay: { maintenanceMs: 10 } });
  enabled = true;
  for (let tries = 0; tries < 40 && !f.relay.state.events.some(event => event.data.status === 'runtime-cleaned'); tries++) await delay(5);
  assert.deepEqual(f.relay.state.events.find(event => event.data.status === 'runtime-cleaned').data.closedRuntimes, [{ runtimeId: 'confirmed-absent', threadId: 'saved' }]);
});
