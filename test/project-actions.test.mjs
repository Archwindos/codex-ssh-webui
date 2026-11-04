import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectActions } from '../src/project-actions.mjs';
import { createArchiveService } from '../src/library.mjs';
import { createNativeProjectService } from '../src/projects.mjs';
import { createRelay } from '../src/server.mjs';
import { RelayError } from '../src/protocol.mjs';

const owner = 'fixture-owner', clone = value => structuredClone(value), digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const project = id => ({ id, name: id, roots: [{ path: '/workspace/a' }, { path: '/workspace/b' }], metadata: {}, position: 1, createdAt: 1, updatedAt: 1 });
const row = (id, projectId = 'p', extra = {}) => ({ id, projectId, name: id, cwd: '/workspace', source: 'cli', parentThreadId: null, section: null, status: { type: 'notLoaded' }, turns: [], archived: false, ...extra });
class ProjectRpc extends EventEmitter {
  connected = false; ended = false; calls = []; projects = new Map([['p', project('p')], ['q', project('q')]]); threads = new Map([['a', row('a')], ['b', row('b')]]); edges = []; archiveCount = 0;
  async start() { this.connected = true; }
  close() { this.connected = false; this.ended = true; }
  descendants(threadId) { const ids = new Set(), queue = [threadId], edges = this.edges.length ? this.edges : [...this.threads.values()].map(row => [row.parentThreadId, row.id]); while (queue.length) { const parent = queue.shift(); for (const [from, id] of edges) if (from === parent && !ids.has(id)) { ids.add(id); queue.push(id); } } ids.delete(threadId); return ids; }
  async call(method, params = {}) {
    this.calls.push({ method, params: clone(params) });
    if (method === 'project/list') { const data = [...this.projects.values()], from = Number(params.cursor || 0), limit = params.limit || 100; return { data: clone(data.slice(from, from + limit)), nextCursor: from + limit < data.length ? String(from + limit) : null }; }
    if (method === 'project/read') { if (!this.projects.has(params.projectId)) throw new RelayError(502, 'upstream_error', 'Missing project'); return { project: clone(this.projects.get(params.projectId)) }; }
    if (method === 'project/update') { const value = this.projects.get(params.projectId); for (const key of ['name', 'roots']) if (Object.hasOwn(params, key)) value[key] = clone(params[key]); return { project: clone(value) }; }
    if (method === 'project/move') { this.projects.get(params.projectId).position = 0; return {}; }
    if (method === 'project/delete') { if (this.deleteHandler) return this.deleteHandler(params); this.projects.delete(params.projectId); for (const row of this.threads.values()) if (row.projectId === params.projectId) row.projectId = null; return {}; }
    if (method === 'threadSection/list' || method === 'thread/loaded/list') return { data: [], nextCursor: null };
    if (method === 'thread/list') {
      assert.equal(params.useStateDbOnly, true, 'all project/archive inventories use the native state DB');
      let data = [...this.threads.values()].filter(row => !!row.archived === !!params.archived);
      if (Object.hasOwn(params, 'projectId')) data = data.filter(row => row.projectId === params.projectId);
      if (params.ancestorThreadId) { const descendants = this.descendants(params.ancestorThreadId); data = data.filter(row => descendants.has(row.id)); }
      const from = Number(params.cursor || 0), size = params.limit || 100; return { data: clone(data.slice(from, from + size)), nextCursor: from + size < data.length ? String(from + size) : null };
    }
    if (method === 'thread/read') { if (!this.threads.has(params.threadId)) throw new RelayError(404, 'missing', 'Missing thread'); return { thread: clone(this.threads.get(params.threadId)) }; }
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'thread/archive') {
      this.archiveCount++;
      if (this.archiveHandler) return this.archiveHandler(params);
      for (const id of [params.threadId, ...this.descendants(params.threadId)]) if (this.threads.has(id)) this.threads.get(id).archived = true; return {};
    }
    assert.fail(`Project actions must not invoke ${method}`);
  }
}
async function fixture(t, configure = () => {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'relay-project-actions-'))), rpc = new ProjectRpc(); configure(rpc);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = createNativeProjectService({ rpc, canonical: async value => value });
  const archiveOptions = { rpc, authoritativeDescendants: true, atomicity: 'gateway-admission-only', inspectWriters: async () => ({ complete: true, holders: [] }), stopManagedRuns: async () => ({ complete: true, receipts: [] }), freezeThreads: async () => ({ release: async () => {} }), releaseFrozenThreads: async () => {}, storeFile: join(root, 'archive.json'), inspectThreadStates: async ids => ({ complete: true, states: ids.map(threadId => ({ threadId, status: rpc.threads.get(threadId).status.type, fingerprint: digest([threadId, rpc.threads.get(threadId).status.type]) })) }) };
  const archive = createArchiveService(archiveOptions), options = { catalog, archive, storeFile: join(root, 'operations.json'), viewStoreFile: join(root, 'view.json') }, actions = await createProjectActions(options);
  return { root, rpc, catalog, archive, actions, options, archiveOptions };
}

test('project batch archive confirms independent roots, preserves all rows and does not repeat a descendant cascade', async t => {
  const f = await fixture(t, rpc => { rpc.threads.get('b').parentThreadId = 'a'; });
  const preview = await f.actions.preview('archive', 'p', owner); assert.equal(preview.canArchive, true); assert.equal(preview.roots.length, 1); assert.deepEqual(preview.affected.map(row => row.id).sort(), ['a', 'b']); assert.equal(f.rpc.archiveCount, 0);
  const [result, duplicate] = await Promise.all([f.actions.execute('archive', preview.planId, owner), f.actions.execute('archive', preview.planId, owner)]); assert.equal(result.status, 'complete'); assert.deepEqual(duplicate, result); assert.equal(result.operationId, preview.operationId); assert.equal(f.rpc.archiveCount, 1); assert.equal(result.affected.length, 2); assert.equal(result.chatsDeleted, false); assert.equal(result.filesDeleted, false);
  for (const row of result.affected) { assert.equal(row.status, 'archived'); assert.equal(row.projectId, 'p'); assert.equal(row.isProjectMember, true); }
});

test('authoritative descendants across a missing intermediate include unassigned Guardian and require explicit associated confirmation', async t => {
  const f = await fixture(t, rpc => { rpc.threads.delete('b'); rpc.threads.set('guardian', row('guardian', null, { parentThreadId: 'missing', source: { subAgent: { other: 'guardian' } } })); rpc.edges = [['a', 'missing'], ['missing', 'guardian']]; });
  const preview = await f.actions.preview('archive', 'p', owner); assert.equal(preview.canArchive, true); assert.deepEqual(preview.outsideProjectIds, ['guardian']); assert.equal(preview.affected.find(row => row.id === 'guardian').isProjectMember, false);
  await assert.rejects(f.actions.execute('archive', preview.planId, owner), { code: 'project_associated_confirmation' }); assert.equal(f.rpc.archiveCount, 0);
  const result = await f.actions.execute('archive', preview.planId, owner, { includeAssociated: true }); assert.equal(result.status, 'complete'); assert.equal(f.rpc.archiveCount, 1); assert.deepEqual(result.outsideProjectIds, ['guardian']);
});

test('member additions, cross-project reassignment and project edits after confirmation stop before any native archive', async t => {
  for (const mutate of [f => f.rpc.threads.set('new', row('new')), f => { f.rpc.threads.get('b').projectId = 'q'; }, f => { f.rpc.projects.get('p').name = 'Changed'; }]) {
    const f = await fixture(t), preview = await f.actions.preview('archive', 'p', owner); mutate(f);
    const result = await f.actions.execute('archive', preview.planId, owner); assert.equal(result.status, 'failed'); assert.equal(result.reports[0].code, 'project_plan_changed'); assert.equal(f.rpc.archiveCount, 0);
  }
});

test('new project members during one root archive stop remaining roots and read-only recheck never executes them', async t => {
  const f = await fixture(t, rpc => { rpc.archiveHandler = params => { rpc.threads.get(params.threadId).archived = true; rpc.threads.set('new', row('new')); return {}; }; });
  const preview = await f.actions.preview('archive', 'p', owner), result = await f.actions.execute('archive', preview.planId, owner);
  assert.equal(result.status, 'partial'); assert.equal(f.rpc.archiveCount, 1); assert.ok(result.roots.some(root => root.status === 'notAttempted')); assert.equal(f.rpc.threads.get('b').archived, false);
  const checked = await f.actions.recheck(result.operationId, owner); assert.equal(checked.status, 'partial'); assert.equal(f.rpc.archiveCount, 1);
});

test('unknown archive receipts survive restart, freeze all confirmed gateway inputs and recheck only attempted roots', async t => {
  const f = await fixture(t, rpc => { rpc.archiveHandler = () => { throw new RelayError(504, 'rpc_timeout', 'Unknown result'); }; });
  const preview = await f.actions.preview('archive', 'p', owner), result = await f.actions.execute('archive', preview.planId, owner); assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true); assert.equal(f.rpc.archiveCount, 1);
  const linked = JSON.parse(await fs.readFile(f.options.storeFile, 'utf8')); assert.ok(linked.operations[0].roots[0].operationId); assert.equal(linked.operations[0].roots[1].operationId, null);
  const restartedArchive = createArchiveService(f.archiveOptions), restored = await createProjectActions({ ...f.options, archive: restartedArchive }); assert.equal(restored.isFrozen('b'), true); await assert.rejects(restored.admit('b', () => { assert.fail('must not dispatch'); }), { code: 'thread_frozen' });
  f.rpc.threads.get('a').archived = true;
  const checked = await restored.recheck(result.operationId, owner); assert.equal(checked.status, 'partial'); assert.equal(checked.freezeRetained, false); assert.equal(checked.affected.find(row => row.id === 'b').status, 'notAttempted'); assert.equal(f.rpc.archiveCount, 1);
});

test('project removal previews active and archived membership and preserves both chats and actual files', async t => {
  const f = await fixture(t, rpc => { rpc.threads.get('b').archived = true; }), sentinel = join(f.root, 'fixture-data.txt'); await fs.writeFile(sentinel, 'must stay');
  await f.actions.pin('p', true); const preview = await f.actions.preview('remove', 'p', owner); assert.equal(preview.canRemove, true); assert.equal(preview.affected.length, 2); assert.equal(f.rpc.projects.has('p'), true);
  const result = await f.actions.execute('remove', preview.planId, owner); assert.equal(result.status, 'complete'); assert.equal(result.projectRemoved, true); assert.ok(result.affected.every(row => row.status === 'unassigned')); assert.equal(f.rpc.threads.size, 2); assert.equal(f.rpc.threads.get('b').archived, true); assert.equal(await fs.readFile(sentinel, 'utf8'), 'must stay'); assert.deepEqual(f.actions.view().pinnedProjectIds, []); assert.equal(f.rpc.archiveCount, 0);
  assert.equal((await f.actions.recheck(result.operationId, owner)).status, 'complete'); assert.equal(f.rpc.calls.filter(call => call.method === 'project/delete').length, 1);
});

test('uncertain project removal does not resend delete and is recoverable from its stable preview operation id', async t => {
  const f = await fixture(t, rpc => { rpc.deleteHandler = () => { throw new RelayError(504, 'rpc_timeout', 'Unknown delete'); }; });
  const preview = await f.actions.preview('remove', 'p', owner), result = await f.actions.execute('remove', preview.planId, owner); assert.equal(result.status, 'unknown'); assert.equal(result.operationId, preview.operationId);
  f.rpc.projects.delete('p'); for (const row of f.rpc.threads.values()) row.projectId = null;
  const restored = await createProjectActions(f.options), checked = await restored.recheck(preview.operationId, owner); assert.equal(checked.status, 'complete'); assert.equal(f.rpc.calls.filter(call => call.method === 'project/delete').length, 1); assert.equal(restored.listOperations(owner, { includeComplete: true }).length, 1);
});

test('web pin preferences persist across clients without modifying native metadata, and name-only edit preserves every root', async t => {
  const f = await fixture(t); await Promise.all([f.actions.pin('p', true), f.actions.pin('q', true)]); const restored = await createProjectActions(f.options); assert.deepEqual(restored.view().pinnedProjectIds, ['p', 'q']); assert.equal(restored.view().viewScope, 'webui'); assert.equal(f.rpc.calls.some(call => call.method === 'project/update'), false);
  const before = clone(f.rpc.projects.get('p').roots); await f.catalog.update('p', { name: 'New name' }); assert.deepEqual(f.rpc.projects.get('p').roots, before); const update = f.rpc.calls.find(call => call.method === 'project/update'); assert.deepEqual(Object.keys(update.params).sort(), ['name', 'projectId']);
  await assert.rejects(f.catalog.update('p', { defaultCwd: '/new' }), { code: 'multiple_project_roots' });
});

test('failed archive operation-link persistence prevents native archive and does not retry the callback', async t => {
  const f = await fixture(t), preview = await f.archive.preview('a', owner); let calls = 0;
  await assert.rejects(f.archive.execute(preview.planId, owner, { onOperation: async operationId => { assert.match(operationId, /^archive-/); calls++; throw new RelayError(500, 'link_failed', 'Failed linking'); } }), { code: 'link_failed' });
  await assert.rejects(f.archive.execute(preview.planId, owner), { code: 'link_failed' }); assert.equal(calls, 1); assert.equal(f.rpc.archiveCount, 0);
});

test('a linked archive id is durable before the callback and preflight failures remain recoverable without archive', async t => {
  const f = await fixture(t), preview = await f.archive.preview('a', owner); let entered, rejectHook, linkedId;
  const linked = new Promise(resolve => { entered = resolve; }), gate = new Promise((resolve, reject) => { rejectHook = reject; });
  const pending = f.archive.execute(preview.planId, owner, { onOperation: async operationId => { linkedId = operationId; entered(); await gate; } }).catch(error => error);
  await linked;
  const restored = createArchiveService(f.archiveOptions), checked = await restored.recheck(linkedId, owner); assert.equal(checked.status, 'failed'); assert.equal(checked.archiveAttempted, false); assert.equal(f.rpc.archiveCount, 0);
  rejectHook(new RelayError(500, 'fixture_exit', 'Simulated gateway exit')); await pending;
  const next = await f.archive.preview('a', owner); let nextId;
  await assert.rejects(f.archive.execute(next.planId, owner, { onOperation: async operationId => { nextId = operationId; f.rpc.threads.get('a').cwd = '/changed'; } }), { code: 'archive_plan_changed' });
  const checkedAgain = await createArchiveService(f.archiveOptions).recheck(nextId, owner); assert.equal(checkedAgain.status, 'failed'); assert.equal(checkedAgain.archiveAttempted, false); assert.equal(f.rpc.archiveCount, 0);
});

test('distinct confirmed plans for one project cannot execute concurrently', async t => {
  const f = await fixture(t), one = await f.actions.preview('archive', 'p', owner), two = await f.actions.preview('archive', 'p', owner);
  const first = f.actions.execute('archive', one.planId, owner);
  await assert.rejects(f.actions.execute('archive', two.planId, owner), { code: 'project_frozen' }); assert.equal((await first).status, 'complete'); assert.equal(f.rpc.archiveCount, 2);
});

test('shared HTTP project actions enforce CSRF, expose persistent web pin state and preserve multi-root name edits', async t => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'project-actions-http-'))), rpc = new ProjectRpc(); for (const row of rpc.threads.values()) row.cwd = base;
  const relay = await createRelay({ mock: true, port: 0, rpc, config: { transport: 'local', sharedDaemonSocket: '/test/native.sock', workspace: { roots: [base], defaultCwd: base }, projects: [{ id: 'seed', name: 'Seed', cwd: base }] }, projectActionsStoreFile: join(base, 'actions.json'), projectViewStoreFile: join(base, 'view.json'), archiveStoreFile: join(base, 'archive.json') });
  t.after(async () => { await relay.close(); await fs.rm(base, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = async (path, body, headers = {}) => { const response = await fetch(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; const data = await response.json(); if (data.csrf) csrf = data.csrf; return { status: response.status, data }; };
  const session = await request('/api/session'); assert.equal(session.data.capabilities.projectArchive, true); assert.equal(session.data.capabilities.projectViewPreferences, true); assert.equal(session.data.capabilities.projectViewSections, false);
  assert.equal((await request('/api/project-view/pin', { projectId: 'p', pinned: true }, { 'X-CSRF-Token': 'bad' })).status, 403); assert.equal((await request('/api/project-view/pin', { projectId: 'p', pinned: true })).status, 200); assert.deepEqual((await request('/api/projects')).data.projectView.pinnedProjectIds, ['p']);
  assert.equal((await request('/api/projects/update', { projectId: 'p', name: 'Renamed' })).status, 200); assert.equal(rpc.projects.get('p').roots.length, 2); assert.equal((await request('/api/projects/update', { projectId: 'p', roots: [], defaultCwd: null })).status, 400);
  assert.equal((await request('/api/project-view/sections', { name: 'Not enabled' })).status, 404);
  const preview = await request('/api/projects/archive/preview', { projectId: 'p' }); assert.equal(preview.data.canArchive, true); const archived = await request('/api/projects/archive', { planId: preview.data.planId }); assert.equal(archived.data.status, 'complete'); assert.equal(rpc.archiveCount, 2);
  const removing = await request('/api/projects/remove/preview', { projectId: 'p' }), removed = await request('/api/projects/remove', { planId: removing.data.planId }); assert.equal(removed.data.status, 'complete'); assert.equal(rpc.threads.size, 2); assert.ok([...rpc.threads.values()].every(row => row.projectId === null && row.archived));
  assert.equal((await request('/api/project-operations')).data.operations.length, 2); assert.equal((await request('/api/session')).data.recentProjectOperations.length, 2);
});

test('an in-flight project removal blocks new chats and moves into its target before native dispatch', async t => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'project-freeze-http-'))), rpc = new ProjectRpc(); for (const row of rpc.threads.values()) row.cwd = base; rpc.threads.set('outside', row('outside', 'q', { cwd: base }));
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  rpc.deleteHandler = async params => { entered(); await gate; rpc.projects.delete(params.projectId); for (const row of rpc.threads.values()) if (row.projectId === params.projectId) row.projectId = null; return {}; };
  const relay = await createRelay({ mock: true, port: 0, rpc, config: { transport: 'local', sharedDaemonSocket: '/test/native.sock', workspace: { roots: [base], defaultCwd: base }, projects: [{ id: 'seed', name: 'Seed', cwd: base }] }, archiveStoreFile: null });
  t.after(async () => { release(); await relay.close(); await fs.rm(base, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = async (path, body) => { const response = await fetch(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; const data = await response.json(); if (data.csrf) csrf = data.csrf; return { status: response.status, data }; };
  await request('/api/session'); const preview = await request('/api/projects/remove/preview', { projectId: 'p' }), removing = request('/api/projects/remove', { planId: preview.data.planId }); await started;
  assert.equal((await request('/api/threads', { projectId: 'p', cwd: base })).status, 409); assert.equal((await request('/api/threads/metadata', { threadId: 'outside', projectId: 'p' })).status, 409); assert.equal(rpc.calls.some(call => ['thread/start', 'thread/metadata/update'].includes(call.method)), false);
  release(); assert.equal((await removing).data.status, 'complete'); assert.equal(rpc.threads.get('outside').projectId, 'q');
});
