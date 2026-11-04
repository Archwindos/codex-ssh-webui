import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient, RelayError, METHODS, safeThread, THREAD_SOURCE_KINDS } from '../src/protocol.mjs';
import { createNativeProjectService, legacyProjectMigrationCandidates, PINNED_THREAD_SECTION_ID, safeProject } from '../src/projects.mjs';

const project = (id = 'project-a', roots = []) => ({ id, name: id, roots, metadata: {}, position: 1, createdAt: 10, updatedAt: 10, recencyAt: null });
const thread = (id = 'thread-a', projectId = null) => ({ id, cwd: '/workspace/original', name: 'Original title', projectId, section: null, sectionEnteredAt: null, createdAt: 5, updatedAt: 10, recencyAt: 10, status: { type: 'notLoaded' }, source: 'cli', turns: [] });
const guardian = id => ({ ...thread(id), name: 'Guardian review', parentThreadId: 'parent-conversation', source: { subAgent: { other: 'guardian' } } });
function fixture({ rows = [thread()], projects = [project()], failMethod, canonical } = {}) {
  const calls = [], state = { rows: structuredClone(rows), projects: structuredClone(projects) };
  const rpc = { call: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === failMethod) throw new RelayError(502, 'upstream_error', 'Suppressed upstream failure');
    if (method === 'project/list') return { data: structuredClone(state.projects.slice(0, params.limit)), nextCursor: null };
    if (method === 'threadSection/list') return { data: [{ id: PINNED_THREAD_SECTION_ID, name: 'Pinned', appearance: null }], nextCursor: null };
    if (method === 'thread/list') {
      const rows = state.rows.filter(t => !Object.hasOwn(params, 'projectId') || t.projectId === params.projectId).filter(t => !Object.hasOwn(params, 'sectionId') || t.section?.id === params.sectionId).filter(t => !params.searchTerm || t.name.includes(params.searchTerm));
      const from = Number(params.cursor || 0), data = rows.slice(from, from + params.limit);
      return { data: structuredClone(data), nextCursor: from + params.limit < rows.length ? String(from + params.limit) : null };
    }
    if (method === 'project/read') {
      const value = state.projects.find(p => p.id === params.projectId);
      if (!value) throw new RelayError(502, 'upstream_error', 'Suppressed missing project');
      return { project: structuredClone(value) };
    }
    if (method === 'project/create') { const value = { ...project(`project-${state.projects.length + 1}`), ...params }; state.projects.push(value); return { project: structuredClone(value) }; }
    if (method === 'project/update') { const value = state.projects.find(p => p.id === params.projectId); Object.assign(value, params); return { project: structuredClone(value) }; }
    const value = state.rows.find(t => t.id === params.threadId);
    if (method === 'thread/read') return { thread: structuredClone(value) };
    if (method === 'thread/name/set') { value.name = params.name; return {}; }
    if (method === 'thread/metadata/update') { value.projectId = params.projectId || null; return { thread: structuredClone(value) }; }
    if (method === 'thread/section/move') { value.section = params.sectionId ? { id: params.sectionId, name: 'Pinned', appearance: null } : null; return {}; }
    throw Error(`Unexpected method ${method}`);
  } };
  return { service: createNativeProjectService({ rpc, canonical }), rpc, calls, state };
}
const writes = calls => calls.filter(call => ['project/create', 'project/update', 'thread/name/set', 'thread/metadata/update', 'thread/section/move'].includes(call.method));

test('capability probe is read-only, cached, and includes the complete source kinds', async () => {
  const f = fixture(), capabilities = await f.service.probe();
  assert.equal(capabilities.nativeProjects, true); assert.equal(capabilities.threadPinning, true);
  assert.deepEqual(f.calls.map(call => call.method), ['project/list', 'threadSection/list', 'thread/list']);
  assert.deepEqual(f.calls[2].params.sourceKinds, THREAD_SOURCE_KINDS);
  assert.equal(f.calls[2].params.useStateDbOnly, true);
  await f.service.probe(); assert.equal(f.calls.length, 3); assert.deepEqual(writes(f.calls), []);
});

test('native unavailable is explicit and does not invent directory projects', async () => {
  const f = fixture({ failMethod: 'project/list' });
  const capabilities = await f.service.probe();
  assert.equal(capabilities.nativeProjects, false); assert.equal(capabilities.error.code, 'native_projects_unavailable');
  await assert.rejects(f.service.create({ name: 'No fallback', defaultCwd: '/workspace' }), error => error.status === 503 && error.code === 'native_projects_unavailable');
  assert.deepEqual(writes(f.calls), []);
});

test('project roots are optional; changing them preserves existing thread cwd and history', async () => {
  const f = fixture({ canonical: async value => value.replace('/alias', '/canonical') });
  const empty = await f.service.create({ name: 'Independent project', idempotencyKey: 'request-1' });
  assert.equal(empty.defaultCwd, null); assert.deepEqual(empty.roots, []);
  const original = structuredClone(f.state.rows);
  const updated = await f.service.update('project-a', { name: 'Renamed project', defaultCwd: '/workspace/alias' });
  assert.equal(updated.defaultCwd, '/workspace/canonical'); assert.deepEqual(f.state.rows, original);
  assert.deepEqual(writes(f.calls).map(call => call.method), ['project/create', 'project/update']);
  assert.equal(f.calls.find(call => call.method === 'project/create').params.idempotencyKey, 'request-1');
});

test('native projects sharing a directory remain separate and thread filtering is by project ID', async () => {
  const rows = [thread('old-a', 'project-a'), thread('old-b', 'project-b'), thread('old-c', null)];
  const f = fixture({ rows, projects: [project('project-a', [{ path: '/same' }]), project('project-b', [{ path: '/same' }])] });
  assert.equal((await f.service.list()).data.length, 2);
  assert.deepEqual((await f.service.listThreads({ projectId: 'project-b' })).data.map(t => t.id), ['old-b']);
  assert.deepEqual((await f.service.listThreads({ projectId: null })).data.map(t => t.id), ['old-c']);
  assert.equal((await f.service.listThreads()).data.length, 3);
  for (const call of f.calls.filter(call => call.method === 'thread/list')) assert.equal(Object.hasOwn(call.params, 'cwd'), false);
});

test('thread lists use the state database and collapse repeated ids without merging equal titles', async () => {
  const first = { ...thread('original'), name: 'ExampleLab 数据集制备' };
  const repeated = { ...first, name: 'Repeated scan entry' };
  const sameTitle = { ...thread('different-conversation'), name: first.name };
  const f = fixture({ rows: [first, repeated, sameTitle] });
  const page = await f.service.listThreads();
  assert.deepEqual(page.data.map(value => value.id), ['original', 'different-conversation']);
  assert.deepEqual(page.data.map(value => value.name), [first.name, first.name]);
  assert.equal(page.nextCursor, null);
  for (const call of f.calls.filter(value => value.method === 'thread/list')) assert.equal(call.params.useStateDbOnly, true);
  assert.deepEqual(writes(f.calls), []);
});

test('only the verified guardian source is internal, and including it preserves native identity and parent links', async () => {
  const rows = [guardian('internal'), { ...thread('user-named-review'), name: 'Guardian review' }, { ...thread('different-subagent'), source: { subAgent: { other: 'review' } } }, { ...thread('not-exact'), source: { subAgent: { other: 'guardian-like' } } }, { ...thread('explicit-review'), source: { subAgent: 'review' } }];
  const f = fixture({ rows }), original = structuredClone(f.state.rows);
  assert.deepEqual((await f.service.listThreads()).data.map(value => value.id), rows.slice(1).map(value => value.id));
  const all = await f.service.listThreads({ includeInternal: true });
  assert.deepEqual(all.data.map(value => value.id), rows.map(value => value.id));
  assert.deepEqual(all.data[0].source, { subAgent: { other: 'guardian' } }); assert.equal(all.data[0].parentThreadId, 'parent-conversation');
  assert.deepEqual(f.state.rows, original); assert.deepEqual(writes(f.calls), []);
  for (const call of f.calls.filter(value => value.method === 'thread/list')) assert.equal(Object.hasOwn(call.params, 'includeInternal'), false);
  for (const includeInternal of [null, 'true', 1]) await assert.rejects(f.service.listThreads({ includeInternal }), error => error.code === 'invalid_query');
});

test('default lists scan past 58 internal reviews to reach normal conversations', async () => {
  const rows = [...Array.from({ length: 58 }, (_, index) => guardian(`guardian-${index}`)), thread('normal-a'), thread('normal-b')];
  const f = fixture({ rows }), page = await f.service.listThreads();
  assert.deepEqual(page.data.map(value => value.id), ['normal-a', 'normal-b']); assert.equal(page.nextCursor, null);
  const calls = f.calls.filter(value => value.method === 'thread/list').slice(1);
  assert.deepEqual(calls.map(value => value.params.limit), [50, 50]);
  assert.deepEqual(calls.map(value => value.params.cursor || null), [null, '50']);
});

test('filtered pages retain the native cursor without skipping later visible conversations', async () => {
  const f = fixture({ rows: [guardian('g0'), guardian('g1'), guardian('g2'), thread('a'), thread('a'), thread('b'), thread('c')] });
  const first = await f.service.listThreads({ limit: 2 });
  assert.deepEqual(first.data.map(value => value.id), ['a', 'b']); assert.equal(first.nextCursor, '6');
  const second = await f.service.listThreads({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.data.map(value => value.id), ['c']); assert.equal(second.nextCursor, null);
});

test('internal filtering is bounded and returns a continuation instead of looping', async () => {
  const f = fixture({ rows: [...Array.from({ length: 11 }, (_, index) => guardian(`g-${index}`)), thread('visible')] });
  const first = await f.service.listThreads({ limit: 1 });
  assert.deepEqual(first.data, []); assert.equal(first.nextCursor, '10');
  assert.equal(f.calls.filter(value => value.method === 'thread/list').length, 11, 'one capability probe plus ten scan pages');
  const second = await f.service.listThreads({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.data[0].id, 'visible'); assert.equal(second.nextCursor, null);
});

test('a repeated native cursor is rejected even when it would fill the visible page', async () => {
  const f = fixture(); await f.service.probe();
  f.rpc.call = async () => ({ data: [thread()], nextCursor: 'same-cursor' });
  await assert.rejects(f.service.listThreads({ limit: 1, cursor: 'same-cursor' }), error => error.code === 'thread_metadata_invalid');
});

test('internal visibility applies with project, pinned, and search filters', async () => {
  const section = { id: PINNED_THREAD_SECTION_ID, name: 'Pinned', appearance: null };
  const rows = [{ ...guardian('g'), projectId: 'project-a', section }, { ...thread('normal', 'project-a'), name: 'Guardian review', section }];
  const f = fixture({ rows }), options = { projectId: 'project-a', pinned: true, searchTerm: 'Guardian', limit: 1 };
  assert.equal((await f.service.listThreads(options)).data[0].id, 'normal');
  assert.equal((await f.service.listThreads({ ...options, includeInternal: true })).data[0].id, 'g');
  const call = f.calls.at(-1); assert.equal(call.params.projectId, 'project-a'); assert.equal(call.params.sectionId, PINNED_THREAD_SECTION_ID); assert.equal(call.params.searchTerm, 'Guardian');
});

test('global native search and pin filters retain pagination and include old conversations', async () => {
  const rows = ['old-a', 'old-b', 'old-c'].map(id => ({ ...thread(id), name: 'Historical needle', section: { id: PINNED_THREAD_SECTION_ID, name: 'Pinned', appearance: null } }));
  const f = fixture({ rows });
  const first = await f.service.listThreads({ searchTerm: 'needle', pinned: true, limit: 1 });
  const second = await f.service.listThreads({ searchTerm: 'needle', pinned: true, limit: 1, cursor: first.nextCursor });
  assert.equal(first.data[0].id, 'old-a'); assert.equal(second.data[0].id, 'old-b'); assert.equal(second.nextCursor, '2');
  const call = f.calls.at(-1); assert.equal(call.params.searchTerm, 'needle'); assert.equal(call.params.sectionId, PINNED_THREAD_SECTION_ID);
  await assert.rejects(f.service.listThreads({ pinned: false }), error => error.code === 'invalid_query');
});

test('rename, pin and project membership use native RPCs, preserving original identity and cwd', async () => {
  const f = fixture(), initial = structuredClone(f.state.rows[0]);
  const result = await f.service.updateThread('thread-a', { name: 'New title', pinned: true, projectId: 'project-a' });
  assert.equal(result.id, initial.id); assert.equal(result.cwd, initial.cwd); assert.deepEqual(result.turns, initial.turns);
  assert.equal(result.projectId, 'project-a'); assert.equal(result.name, 'New title'); assert.equal(result.pinned, true);
  assert.deepEqual(writes(f.calls).map(call => call.method), ['thread/metadata/update', 'thread/name/set', 'thread/section/move']);
  await f.service.updateThread('thread-a', { projectId: null, pinned: false });
  const clearing = writes(f.calls).find(call => call.method === 'thread/metadata/update' && call.params.projectId === '');
  assert.ok(clearing); assert.equal(f.state.rows[0].projectId, null); assert.equal(f.state.rows[0].section, null);
  assert.equal(f.calls.some(call => /thread\/(start|resume)|turn\//.test(call.method)), false);
});

test('all patch fields and assignment targets are checked before any mutation', async () => {
  for (const patch of [{ name: 'Valid', pinned: 'yes' }, { name: 'Valid', projectId: '' }, { name: 'Valid', cwd: '/other' }, { name: 'Valid', projectId: 'missing-project' }]) {
    const f = fixture(); await assert.rejects(f.service.updateThread('thread-a', patch)); assert.deepEqual(writes(f.calls), []);
  }
  const f = fixture({ canonical: async () => { throw new RelayError(403, 'workspace_forbidden', 'Outside roots'); } });
  await assert.rejects(f.service.create({ name: 'Valid', defaultCwd: '/outside' }), error => error.code === 'workspace_forbidden');
  assert.deepEqual(f.calls, []);
});

test('partial writes are explicit, are not retried, and are not rolled back', async () => {
  const f = fixture({ failMethod: 'thread/name/set' });
  await assert.rejects(f.service.updateThread('thread-a', { projectId: 'project-a', name: 'New title', pinned: true }), error => {
    assert.equal(error.code, 'metadata_update_partial'); assert.match(error.message, /部分字段可能已经改变/);
    assert.deepEqual(error.attemptedFields, ['projectId', 'name']); return true;
  });
  assert.equal(f.state.rows[0].projectId, 'project-a'); assert.equal(f.state.rows[0].name, 'Original title');
  assert.deepEqual(writes(f.calls).map(call => call.method), ['thread/metadata/update', 'thread/name/set']);
});

test('unpinning an already unpinned custom section does not clear that section', async () => {
  const f = fixture({ rows: [{ ...thread(), section: { id: 'custom-section', name: 'Research', appearance: null } }] });
  const result = await f.service.updateThread('thread-a', { pinned: false });
  assert.equal(result.section.id, 'custom-section'); assert.deepEqual(writes(f.calls), []);
});

test('a one-directory UI cannot silently collapse existing multi-root projects', async () => {
  const f = fixture({ projects: [project('project-a', [{ path: '/one' }, { path: '/two' }])] });
  await assert.rejects(f.service.update('project-a', { defaultCwd: '/three' }), error => error.code === 'multiple_project_roots');
  assert.deepEqual(writes(f.calls), []);
});

test('safe metadata preserves native bindings and strips extra fields', () => {
  const value = safeThread({ ...thread(), projectId: 'native-project', section: { id: PINNED_THREAD_SECTION_ID, name: 'Pinned', appearance: { icon: 'star', color: 'blue', secret: 'hidden' }, private: 'hidden' }, sectionEnteredAt: 12, recencyAt: 15, extra: { token: 'hidden' } });
  assert.equal(value.projectId, 'native-project'); assert.equal(value.pinned, true); assert.equal(value.sectionEnteredAt, 12); assert.equal(value.recencyAt, 15);
  assert.equal(JSON.stringify(value).includes('hidden'), false);
  assert.equal(safeProject({ ...project(), metadata: { token: 'hidden' } }).metadata, undefined);
});

test('missing native metadata is rejected instead of appearing as an unassigned conversation', async () => {
  const f = fixture(); await f.service.probe(); delete f.state.rows[0].projectId;
  await assert.rejects(f.service.readThread('thread-a'), error => error.code === 'thread_metadata_invalid');
  await assert.rejects(f.service.listThreads(), error => error.code === 'thread_metadata_invalid');
});

test('legacy migration is only a bounded proposal for saved entries, without auto-classification', () => {
  const records = [{ id: 'manual', name: 'Saved', cwd: '/same', revision: 2, managed: true }, { id: 'discovered', name: 'Temporary', cwd: '/same', managed: false }], original = structuredClone(records);
  assert.deepEqual(legacyProjectMigrationCandidates(records), [{ legacyId: 'manual', name: 'Saved', defaultCwd: '/same', revision: 2, nativeProjectId: null, status: 'requires_explicit_mapping' }]);
  assert.deepEqual(records, original);
});

test('actual mock process implements native create, metadata updates and idempotency without model turns', async t => {
  const rpc = new RpcClient({}, { mock: true, experimentalApi: true }); t.after(() => rpc.close()); await rpc.start();
  const service = createNativeProjectService({ rpc }), created = await service.create({ name: 'Mock project', defaultCwd: null, idempotencyKey: 'stable-create' });
  assert.equal((await service.create({ name: 'Mock project', defaultCwd: null, idempotencyKey: 'stable-create' })).id, created.id);
  const result = await rpc.call('thread/start', { cwd: '/workspace', projectId: created.id });
  const updated = await service.updateThread(result.thread.id, { name: 'Native fixture title', pinned: true, projectId: null });
  assert.equal(updated.projectId, null); assert.equal(updated.pinned, true); assert.deepEqual(updated.turns, []);
  assert.deepEqual((await service.listThreads({ searchTerm: 'fixture', pinned: true })).data.map(row => row.id), [updated.id]);
  await assert.rejects(service.create({ name: 'Conflicting create', idempotencyKey: 'stable-create' }));
});

test('RPC whitelist exposes only the required proven project and metadata methods', () => {
  for (const method of ['project/list', 'project/read', 'project/create', 'project/update', 'project/delete', 'project/move', 'threadSection/list', 'thread/name/set', 'thread/metadata/update', 'thread/section/move']) assert.ok(METHODS.has(method), method);
  for (const method of ['project/import', 'threadSection/delete', 'config/write', 'account/logout']) assert.equal(METHODS.has(method), false, method);
});
