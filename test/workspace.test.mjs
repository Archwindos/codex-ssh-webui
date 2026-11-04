import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createRelay, validateConfig } from '../src/server.mjs';
import { createWorkspaceBrowser, createProjectRegistry } from '../src/workspace.mjs';
import { safeThread, safeItem, THREAD_SOURCE_KINDS } from '../src/protocol.mjs';

const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
async function directories(t) {
  const base = await fs.mkdtemp(join(tmpdir(), 'relay-workspace-'));
  assert.ok(relative(tmpdir(), base).startsWith('relay-workspace-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'root'), a = join(root, 'alpha'), b = join(root, 'beta'), outside = join(base, 'outside');
  await Promise.all([a, b, outside].map(path => fs.mkdir(path, { recursive: true })));
  const canonicalRoot = await fs.realpath(root), canonicalA = await fs.realpath(a), canonicalB = await fs.realpath(b);
  const config = { transport: 'local', projects: [{ id: 'seed', name: 'Configured seed', cwd: '/fixed-seed' }], workspace: { roots: [root], defaultCwd: a } };
  return { base, root: canonicalRoot, a: canonicalA, b: canonicalB, outside, config };
}

class WorkspaceRpc extends EventEmitter {
  connected = false;
  ended = false;
  calls = [];
  threads = new Map();
  async start() { this.connected = true; }
  close() { this.ended = true; this.connected = false; }
  answer(id, result) { this.calls.push({ method: 'answer', id, result }); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/list') {
      const threads = [...this.threads.values()].filter(thread => !params.cwd || thread.cwd === params.cwd);
      const from = Number(params.cursor || 0);
      return { data: threads.slice(from, from + 20), nextCursor: from + 20 < threads.length ? String(from + 20) : null };
    }
    if (method === 'thread/start') {
      const thread = { id: `new-thread-${this.threads.size}`, cwd: params.cwd, source: 'appServer', status: { type: 'idle' }, turns: [] };
      this.threads.set(thread.id, thread); return { thread };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: this.threads.get(params.threadId) };
    if (method === 'thread/turns/list') return this.history || { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: 'new-turn', status: 'inProgress', items: [] } };
    if (method === 'turn/interrupt') return {};
    throw Error(`Unexpected RPC: ${method}`);
  }
}

async function fixture(t, config, options = {}) {
  const rpc = options.rpc || new WorkspaceRpc();
  const relay = await createRelay({ mock: true, port: 0, config, rpc, projectStoreFile: null, ...options });
  t.after(() => relay.close());
  let cookie = '', csrf = '';
  const request = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(relay.publicOrigin).host, Cookie: cookie, ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        if (data.csrf) csrf = data.csrf;
        resolve({ status: res.statusCode, data });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { relay, rpc, request };
}

test('workspace is an explicit local-only production capability and fixed mode stays restricted', async t => {
  const d = await directories(t);
  const production = { ...d.config, remoteCodex: '/opt/codex/bin/codex', publicOrigin: 'https://relay.test.example', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
  assert.doesNotThrow(() => validateConfig(production, false, env));
  for (const transport of [undefined, 'ssh']) assert.throws(() => validateConfig({ ...production, transport, sshTarget: 'codex-server' }, false, env), error => error.code === 'configuration');
  for (const workspace of [null, {}, { roots: [], defaultCwd: d.a }, { roots: [d.root], defaultCwd: 'relative' }, { roots: [d.root], defaultCwd: d.a, command: 'ignored' }]) assert.throws(() => validateConfig({ ...d.config, workspace }, true), error => error.code === 'configuration');
  if (process.platform !== 'win32') assert.doesNotThrow(() => validateConfig({ ...d.config, workspace: { roots: ['/'], defaultCwd: d.a } }, true));
  const f = await fixture(t, { projects: d.config.projects });
  const session = await f.request('/api/session');
  assert.deepEqual(session.data.capabilities, { terminal: false, workspaceBrowser: false, projectManagement: false, allThreads: false, overview: true });
  assert.equal((await f.request('/api/directories')).status, 403);
  assert.equal((await f.request('/api/projects', { cwd: d.a })).status, 403);
  assert.equal((await f.request(`/api/projects?cwd=${encodeURIComponent(d.a)}`)).status, 403);
  assert.equal((await f.request('/api/threads?project=all')).status, 400);
});

test('directory browsing returns only accessible canonical directory metadata and respects realpath boundaries', async t => {
  const d = await directories(t);
  await fs.writeFile(join(d.root, 'PRIVATE_FILE_NAME.txt'), 'PRIVATE_CONTENT');
  await fs.symlink(d.a, join(d.root, 'inside-link'), 'junction');
  await fs.symlink(d.outside, join(d.root, 'outside-link'), 'junction');
  const workspace = await createWorkspaceBrowser(d.config.workspace);
  const result = await workspace.browse(d.root);
  assert.equal(result.cwd, d.root); assert.equal(result.parent, null); assert.equal(result.limited, false);
  assert.deepEqual(result.roots, [d.root]);
  assert.deepEqual(result.entries.map(entry => entry.name), ['alpha', 'beta', 'inside-link']);
  assert.equal(result.entries.find(entry => entry.name === 'inside-link').cwd, d.a);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.equal((await workspace.browse()).cwd, d.a);
  assert.equal((await workspace.browse(d.a)).parent, d.root);
  await assert.rejects(workspace.browse(join(d.root, 'outside-link')), error => error.status === 403 && error.code === 'workspace_forbidden');
  await assert.rejects(workspace.browse(d.outside), error => error.status === 403);
  await assert.rejects(workspace.browse(join(d.root, '..', 'outside')), error => error.status === 403);
  await assert.rejects(workspace.browse(join(d.root, 'PRIVATE_FILE_NAME.txt')), error => error.status === 400 && error.code === 'not_directory');
  await assert.rejects(workspace.browse(join(d.root, 'missing')), error => error.status === 404);
  for (const value of ['', 'relative', `${d.a}\u0000`, `${d.a}\n`, false, ['path']]) await assert.rejects(workspace.browse(value), error => error.status === 400);
  await assert.rejects(createWorkspaceBrowser({ roots: [join(d.root, 'missing')], defaultCwd: d.a }), error => error.status === 500 && error.code === 'configuration');
});

test('unreadable directories fail safely and inaccessible children do not break their parent listing', async t => {
  const d = await directories(t);
  const filesystem = { ...fs, async access(path, mode) { if (path === d.b) { const error = Error('PRIVATE_PERMISSION_DETAILS'); error.code = 'EACCES'; throw error; } return fs.access(path, mode); } };
  const workspace = await createWorkspaceBrowser(d.config.workspace, { filesystem });
  const result = await workspace.browse(d.root);
  assert.deepEqual(result.entries.map(entry => entry.name), ['alpha']);
  await assert.rejects(workspace.browse(d.b), error => error.status === 403 && error.code === 'directory_unreadable' && !error.message.includes('PRIVATE_'));
  const unreadable = await createWorkspaceBrowser(d.config.workspace, { filesystem: { ...fs, async opendir() { const error = Error('PRIVATE_READ_DETAILS'); error.code = 'EACCES'; throw error; } } });
  await assert.rejects(unreadable.browse(d.root), error => error.status === 403 && !error.message.includes('PRIVATE_'));
});

test('a symlink cannot bypass the control-character path check through its realpath target', async t => {
  const d = await directories(t), link = join(d.root, 'control-link'), target = join(d.root, 'control\u0085target');
  let accessedTarget = false;
  const filesystem = { ...fs,
    realpath: path => path === link ? Promise.resolve(target) : fs.realpath(path),
    stat(path) { if (path === target) { accessedTarget = true; throw Error('must reject before access'); } return fs.stat(path); }
  };
  const workspace = await createWorkspaceBrowser(d.config.workspace, { filesystem });
  await assert.rejects(workspace.browse(link), error => error.status === 400 && error.code === 'invalid_path');
  assert.equal(accessedTarget, false);
});

test('directory listing caps directory entries and marks its limit honestly', async t => {
  const d = await directories(t);
  await Promise.all(Array.from({ length: 201 }, (_, index) => fs.mkdir(join(d.a, `folder-${index}`))));
  const workspace = await createWorkspaceBrowser(d.config.workspace), result = await workspace.browse(d.a);
  assert.equal(result.entries.length, 200); assert.equal(result.limited, true);
});

test('directory and project APIs require login and CSRF, reject extra parameters, and disclose no roots before login', async t => {
  const d = await directories(t);
  const config = { ...d.config, remoteCodex: '/opt/codex/bin/codex', publicOrigin: 'https://relay.test.example', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
  const f = await fixture(t, config, { mock: false, env });
  assert.equal((await f.request('/api/directories')).status, 401);
  const session = await f.request('/api/session');
  assert.equal(session.data.workspace, undefined); assert.deepEqual(session.data.projects, []); assert.equal(session.data.capabilities.workspaceBrowser, false);
  assert.ok(!JSON.stringify(session.data).includes(d.root));
  for (const [path, body] of [['/api/directories', undefined], ['/api/projects', undefined], [`/api/projects?cwd=${encodeURIComponent(d.a)}`, undefined], ['/api/projects', { cwd: d.a }], ['/api/projects/update', { projectId: 'seed', cwd: d.a, revision: 1 }], ['/api/threads?project=all', undefined], ['/api/overview', undefined]]) assert.equal((await f.request(path, body)).status, 401);
  assert.equal(f.rpc.calls.length, 0);
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET })).status, 200);
  const authenticated = await f.request('/api/session'); assert.equal(authenticated.data.workspace.defaultCwd, d.a); assert.equal(authenticated.data.capabilities.workspaceBrowser, true); assert.equal(authenticated.data.capabilities.projectManagement, true);
  assert.equal((await f.request('/api/directories')).data.cwd, d.a);
  assert.equal((await f.request(`/api/directories?path=${encodeURIComponent(d.root)}`)).data.cwd, d.root);
  assert.equal((await f.request('/api/projects', { cwd: d.a }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/projects/update', { projectId: 'seed', cwd: d.a, revision: 1 }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/projects/update', { projectId: 'seed', cwd: d.a, revision: 1 }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request('/api/projects', { cwd: d.a, model: 'forbidden' })).status, 400);
  assert.equal((await f.request('/api/directories?path=a&path=b')).status, 400);
  assert.equal((await f.request('/api/session?path=private')).status, 400);
  assert.equal((await f.request('/api/session?cwd=private')).status, 400);
  assert.equal((await f.request(`/api/projects?cwd=${encodeURIComponent(d.a)}&cwd=${encodeURIComponent(d.b)}`)).status, 400);
  assert.equal((await f.request('/api/projects', { cwd: `${d.a}\u0000` })).status, 400);
  assert.equal((await f.request(`/api/directories?path=${encodeURIComponent(d.outside)}`)).status, 403);
  assert.equal(f.rpc.calls.length, 0, 'filesystem selection cannot start Codex or send a model turn');
});

test('all-thread pages span directories and all source kinds, register accessible projects and bind opaque cursors to filters', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc();
  for (let n = 0; n < 21; n++) rpc.threads.set(`thread-${n}`, { id: `thread-${n}`, cwd: n === 2 ? d.outside : n % 2 ? d.b : d.a, name: `Thread ${n}`, createdAt: 100 + n, updatedAt: 200 + n, source: n === 1 ? { subAgent: { thread_spawn: { parent_thread_id: 'thread-0', depth: 1, agent_nickname: 'Worker', private: 'MUST_NOT_LEAK' } } } : 'exec', status: { type: n === 0 ? 'active' : 'notLoaded', activeFlags: ['waitingOnApproval'], private: 'MUST_NOT_LEAK' }, turns: [] });
  const f = await fixture(t, d.config, { rpc }); await f.request('/api/session');
  const first = await f.request('/api/threads');
  assert.equal(first.status, 200); assert.equal(first.data.data.length, 20); assert.ok(first.data.nextCursor); assert.notEqual(first.data.nextCursor, '20');
  const a = first.data.data.find(thread => thread.cwd === d.a), b = first.data.data.find(thread => thread.cwd === d.b), unavailable = first.data.data.find(thread => thread.id === 'thread-2');
  assert.ok(a.projectId); assert.ok(b.projectId); assert.notEqual(a.projectId, b.projectId);
  assert.equal(unavailable.unavailable, true); assert.equal(unavailable.projectId, null);
  assert.deepEqual(a.status, { type: 'active', activeFlags: ['waitingOnApproval'] }); assert.equal(a.createdAt, 100); assert.equal(a.updatedAt, 200);
  assert.equal(b.source.subAgent.thread_spawn.parent_thread_id, 'thread-0'); assert.equal(b.source.subAgent.thread_spawn.agent_nickname, 'Worker');
  assert.ok(!JSON.stringify(first.data).includes('MUST_NOT_LEAK'));
  assert.equal(f.relay.state.authorizedThreads.size, 0); assert.equal(f.relay.state.loadedThreads.size, 0);
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/list']);
  assert.equal(Object.hasOwn(rpc.calls[0].params, 'cwd'), false); assert.deepEqual(rpc.calls[0].params.sourceKinds, THREAD_SOURCE_KINDS); assert.ok(THREAD_SOURCE_KINDS.includes('subAgentThreadSpawn'));
  const token = first.data.nextCursor;
  assert.equal((await f.request(`/api/threads?project=${a.projectId}&cursor=${token}`)).status, 400);
  const second = await f.request(`/api/threads?project=all&cursor=${token}`);
  assert.equal(second.status, 200); assert.deepEqual(second.data.data.map(thread => thread.id), ['thread-20']); assert.equal(second.data.nextCursor, null);
  assert.equal(rpc.calls.at(-1).params.cursor, '20'); assert.equal(Object.hasOwn(rpc.calls.at(-1).params, 'cwd'), false);
  const filtered = await f.request(`/api/threads?project=${b.projectId}`);
  assert.equal(filtered.status, 200); assert.ok(filtered.data.data.every(thread => thread.cwd === d.b));
  assert.equal(rpc.calls.at(-1).params.cwd, d.b);
  const session = await f.request('/api/session'); assert.equal(session.data.projects.length, 2);
  assert.ok(session.data.projects.every(p => p.managed === false), 'discovery does not make unavailable configuration examples real or persistent');
});

test('registered projects have stable canonical IDs and operations refuse thread/project mismatch and cwd overrides', async t => {
  const d = await directories(t), f = await fixture(t, d.config); await f.request('/api/session');
  await fs.symlink(d.a, join(d.root, 'alias'), 'junction');
  const a = (await f.request('/api/projects', { cwd: d.a })).data.project, alias = (await f.request('/api/projects', { cwd: join(d.root, 'alias') })).data.project;
  const b = (await f.request('/api/projects', { cwd: d.b })).data.project;
  assert.deepEqual(a, alias); assert.match(a.id, /^workspace-[a-f0-9]{32}$/);
  const secondRelay = await fixture(t, d.config); await secondRelay.request('/api/session');
  assert.deepEqual((await secondRelay.request('/api/projects', { cwd: d.a })).data.project, a);
  const created = await f.request('/api/threads', { projectId: a.id }); assert.equal(created.status, 200); assert.equal(created.data.thread.projectId, a.id); assert.equal(created.data.thread.cwd, d.a);
  const id = created.data.thread.id;
  assert.equal((await f.request('/api/resume', { projectId: b.id, threadId: id })).status, 403);
  assert.equal((await f.request('/api/turns', { projectId: b.id, threadId: id, text: 'must not run', submissionId: 'mismatch' })).status, 403);
  assert.equal((await f.request('/api/resume', { projectId: a.id, threadId: id, cwd: d.b })).status, 400);
  assert.equal((await f.request('/api/threads', { projectId: a.id, cwd: d.b })).status, 400);
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
  f.relay.state.loadedThreads.delete(id);
  assert.equal((await f.request('/api/resume', { projectId: a.id, threadId: id })).status, 200);
  assert.equal(Object.hasOwn(f.rpc.calls.find(call => call.method === 'thread/resume').params, 'cwd'), false, 'resume preserves the stored working directory');
  f.rpc.threads.get(id).cwd = d.b;
  assert.equal((await f.request('/api/resume', { projectId: a.id, threadId: id })).status, 403);
  assert.equal(f.relay.state.authorizedThreads.has(id), false);
});

test('named projects persist canonical bindings across restart and stored revisions override configuration seeds', async t => {
  const d = await directories(t), projectStoreFile = join(d.base, 'private', 'projects.json');
  const config = { ...d.config, projects: [{ id: 'named', name: 'Seed', cwd: d.a }] };
  const f = await fixture(t, config, { projectStoreFile }); await f.request('/api/session');
  assert.equal((await f.request('/api/projects')).data.projects[0].name, 'Seed');
  const saved = await f.request('/api/projects/update', { projectId: 'named', cwd: d.b, name: 'Research', revision: 1 });
  assert.equal(saved.status, 200); assert.equal(saved.data.project.cwd, d.b); assert.equal(saved.data.project.revision, 2); assert.equal(saved.data.project.managed, true);
  assert.equal(saved.data.previousProject.cwd, d.a); assert.equal(saved.data.previousProject.managed, false);
  const disk = JSON.parse(await fs.readFile(projectStoreFile, 'utf8'));
  assert.equal(disk.schemaVersion, 1); assert.deepEqual(disk.projects, [saved.data.project]);
  assert.deepEqual((await fs.readdir(dirname(projectStoreFile))).sort(), ['projects.json']);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(projectStoreFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(dirname(projectStoreFile))).mode & 0o777, 0o700);
  }
  const restarted = await fixture(t, config, { projectStoreFile }); await restarted.request('/api/session');
  assert.deepEqual((await restarted.request('/api/projects')).data.projects, [saved.data.project]);
  const created = await restarted.request('/api/threads', { projectId: 'named' });
  assert.equal(created.status, 200); assert.equal(created.data.thread.cwd, d.b);
  assert.equal(restarted.rpc.calls.find(call => call.method === 'thread/start').params.cwd, d.b);
});

test('rebinding changes new conversations only and returns the old directory context for existing conversations', async t => {
  const d = await directories(t), f = await fixture(t, d.config); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a, name: 'Work' })).data.project;
  const oldThread = (await f.request('/api/threads', { projectId: project.id })).data.thread;
  const beforeAuthorized = f.relay.state.authorizedThreads.get(oldThread.id);
  const changed = await f.request('/api/projects/update', { projectId: project.id, cwd: d.b, revision: project.revision });
  assert.equal(changed.status, 200); assert.equal(changed.data.project.id, project.id); assert.equal(changed.data.project.name, 'Work');
  const previous = changed.data.previousProject;
  assert.notEqual(previous.id, project.id); assert.equal(previous.cwd, d.a); assert.equal(previous.managed, false);
  assert.ok(changed.data.projects.some(p => p.id === previous.id));
  assert.equal(f.relay.state.authorizedThreads.get(oldThread.id), beforeAuthorized);
  assert.equal(f.rpc.threads.get(oldThread.id).cwd, d.a);
  const newThread = (await f.request('/api/threads', { projectId: project.id })).data.thread;
  assert.equal(newThread.cwd, d.b);
  const wrong = await f.request('/api/turns', { projectId: project.id, threadId: oldThread.id, text: 'keep the old cwd', submissionId: 'wrong-new-binding' });
  assert.equal(wrong.status, 403); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, 0);
  const sent = await f.request('/api/turns', { projectId: previous.id, threadId: oldThread.id, text: 'keep the old cwd', submissionId: 'old-directory' });
  assert.equal(sent.status, 200);
  assert.equal(f.rpc.calls.find(call => call.method === 'turn/start').params.threadId, oldThread.id);
  assert.equal(Object.hasOwn(f.rpc.calls.find(call => call.method === 'thread/resume').params, 'cwd'), false);
  assert.equal((await f.request(`/api/history?project=${previous.id}&thread=${oldThread.id}`)).status, 200);
  assert.deepEqual((await f.request(`/api/threads?project=${project.id}`)).data.data.map(thread => thread.id), [newThread.id]);
  const all = (await f.request('/api/threads?project=all')).data.data;
  assert.equal(all.find(thread => thread.id === oldThread.id).projectId, previous.id);
  const submissions = f.rpc.calls.filter(call => call.method === 'turn/start').length;
  assert.equal((await f.request('/api/turns', { projectId: previous.id, threadId: oldThread.id, text: 'keep the old cwd', submissionId: 'old-directory' })).data.duplicate, true);
  assert.equal(f.rpc.calls.filter(call => call.method === 'turn/start').length, submissions);
});

test('a restarted relay resolves an old conversation directory without persisting it or changing the named binding', async t => {
  const d = await directories(t), projectStoreFile = join(d.base, 'private', 'projects.json');
  const f = await fixture(t, d.config, { projectStoreFile }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a, name: 'Work' })).data.project;
  const oldThread = (await f.request('/api/threads', { projectId: project.id })).data.thread;
  const moved = (await f.request('/api/projects/update', { projectId: project.id, cwd: d.b, revision: project.revision })).data;
  const before = await fs.readFile(projectStoreFile, 'utf8');
  await f.relay.close();
  const rpc = new WorkspaceRpc(); rpc.threads.set(oldThread.id, { id: oldThread.id, cwd: d.a, status: { type: 'notLoaded' }, turns: [] });
  const restarted = await fixture(t, d.config, { projectStoreFile, rpc });
  const session = (await restarted.request('/api/session')).data;
  assert.deepEqual(session.projects, [moved.project]);
  assert.ok(!session.projects.some(p => p.id === moved.previousProject.id));
  assert.equal((await restarted.request('/api/resume', { projectId: moved.previousProject.id, threadId: oldThread.id })).data.error.code, 'project_forbidden');
  const resolved = await restarted.request(`/api/projects?cwd=${encodeURIComponent(d.a)}`);
  assert.equal(resolved.status, 200); assert.equal(resolved.data.project.cwd, d.a); assert.equal(resolved.data.project.managed, false);
  assert.notEqual(resolved.data.project.id, project.id); assert.equal(resolved.data.project.id, moved.previousProject.id);
  assert.ok(resolved.data.projects.some(p => p.id === resolved.data.project.id));
  assert.deepEqual(resolved.data.projects.find(p => p.id === project.id), moved.project);
  assert.equal(rpc.calls.length, 0, 'directory context resolution does not query Codex or send a model turn');
  assert.equal(await fs.readFile(projectStoreFile, 'utf8'), before);
  assert.deepEqual(await fs.readdir(dirname(projectStoreFile)), ['projects.json']);
  assert.equal((await restarted.request('/api/resume', { projectId: project.id, threadId: oldThread.id })).status, 403);
  const oldProjectId = resolved.data.project.id;
  const resumed = await restarted.request('/api/resume', { projectId: oldProjectId, threadId: oldThread.id });
  assert.equal(resumed.status, 200); assert.equal(resumed.data.thread.cwd, d.a);
  assert.equal(Object.hasOwn(rpc.calls.find(call => call.method === 'thread/resume').params, 'cwd'), false);
  assert.equal((await restarted.request('/api/turns', { projectId: oldProjectId, threadId: oldThread.id, text: 'continue in the original directory', submissionId: 'after-restart' })).status, 200);
  assert.equal(rpc.calls.find(call => call.method === 'turn/start').params.threadId, oldThread.id);
  assert.equal(rpc.threads.get(oldThread.id).cwd, d.a);
  assert.equal((await restarted.request('/api/threads', { projectId: project.id })).data.thread.cwd, d.b);
  await fs.symlink(d.outside, join(d.root, 'resolve-outside'), 'junction');
  for (const [cwd, status] of [['relative', 400], ['', 400], [join(d.root, 'missing'), 404], [d.outside, 403], [join(d.root, 'resolve-outside'), 403]]) {
    assert.equal((await restarted.request(`/api/projects?cwd=${encodeURIComponent(cwd)}`)).status, status);
  }
  assert.equal(await fs.readFile(projectStoreFile, 'utf8'), before);
});

test('project updates reject stale concurrent revisions, invalid names and inaccessible directory bindings', async t => {
  const d = await directories(t), f = await fixture(t, d.config); await f.request('/api/session');
  const p = (await f.request('/api/projects', { cwd: d.a, name: 'Work' })).data.project;
  const attempts = await Promise.all(['First', 'Second'].map(name => f.request('/api/projects/update', { projectId: p.id, cwd: d.b, name, revision: p.revision })));
  assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409]);
  const current = attempts.find(r => r.status === 200).data.project;
  assert.equal(current.revision, p.revision + 1);
  assert.equal(attempts.find(r => r.status === 409).data.error.code, 'project_conflict');
  await fs.symlink(d.outside, join(d.root, 'outside-binding'), 'junction');
  const update = body => f.request('/api/projects/update', { projectId: p.id, cwd: d.b, revision: current.revision, ...body });
  for (const name of ['', '  ', 'x'.repeat(101), 'bad\nname', null]) assert.equal((await update({ name })).status, 400);
  for (const cwd of ['relative', `${d.a}\0`]) assert.equal((await update({ cwd })).status, 400);
  assert.equal((await update({ cwd: join(d.root, 'missing') })).status, 404);
  assert.equal((await update({ cwd: d.outside })).status, 403);
  assert.equal((await update({ cwd: join(d.root, 'outside-binding') })).status, 403);
  assert.equal((await update({ extra: true })).status, 400);
  assert.equal((await update({ revision: undefined })).status, 400);
  assert.equal((await f.request('/api/projects', { cwd: d.b, name: 'silent rename' })).status, 409, 'creation cannot bypass the revision guard to rename a managed project');
  assert.deepEqual((await f.request('/api/projects')).data.projects.find(project => project.id === p.id), current);
  assert.equal(f.rpc.calls.length, 0);
});

test('two project registries sharing a file preserve revisions and refuse a stale cross-instance overwrite', async t => {
  const d = await directories(t), workspace = await createWorkspaceBrowser(d.config.workspace), storeFile = join(d.base, 'projects.json');
  const first = await createProjectRegistry([], { workspace, storeFile });
  const p = await first.create(d.a, 'Work');
  const second = await createProjectRegistry([], { workspace, storeFile });
  await first.update(p.id, d.b, 'Latest', p.revision);
  await assert.rejects(second.update(p.id, d.a, 'Stale', p.revision), error => error.status === 409 && error.code === 'project_conflict');
  assert.equal(second.projects.get(p.id).cwd, d.b);
  assert.equal(JSON.parse(await fs.readFile(storeFile, 'utf8')).projects[0].name, 'Latest');
});

test('atomic project save failures preserve the previous file and binding, and corrupt or linked stores fail closed', async t => {
  const d = await directories(t), workspace = await createWorkspaceBrowser(d.config.workspace), storeFile = join(d.base, 'projects.json');
  const initial = await createProjectRegistry([], { workspace, storeFile });
  const p = await initial.create(d.a, 'Work'), before = await fs.readFile(storeFile, 'utf8');
  const registry = await createProjectRegistry([], { workspace, storeFile, filesystem: { ...fs, async rename() { throw Error('PRIVATE_FILE_ERROR'); } } });
  await assert.rejects(registry.update(p.id, d.b, 'Changed', p.revision), error => error.code === 'project_store_unavailable' && !error.message.includes('PRIVATE_'));
  assert.equal(registry.projects.get(p.id).cwd, d.a); assert.equal(await fs.readFile(storeFile, 'utf8'), before);
  assert.ok(!(await fs.readdir(d.base)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
  const corrupt = join(d.base, 'corrupt.json'); await fs.writeFile(corrupt, '{"schemaVersion":2,"projects":[]}');
  await assert.rejects(createProjectRegistry([], { workspace, storeFile: corrupt }), error => error.code === 'project_store_invalid');
  const link = join(d.base, 'linked.json'); await fs.symlink(d.root, link, 'junction');
  await assert.rejects(createProjectRegistry([], { workspace, storeFile: link }), error => error.code === 'project_store_invalid');
});

test('viewing an externally active thread is read-only and sending cannot take over its active turn', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc();
  rpc.threads.set('external-active', { id: 'external-active', cwd: d.a, source: 'cli', status: { type: 'active', activeFlags: [] }, turns: [] });
  const f = await fixture(t, d.config, { rpc }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  assert.equal((await f.request('/api/resume', { projectId: project.id, threadId: 'external-active' })).status, 200);
  assert.equal((await f.request('/api/turns', { projectId: project.id, threadId: 'external-active', text: 'must not take over', submissionId: 'active-submission' })).status, 409);
  assert.equal(rpc.calls.filter(call => ['thread/resume', 'turn/start'].includes(call.method)).length, 0);
});

test('external rollout holders stay read-only even when the independent app-server reports notLoaded', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc(); rpc.child = { pid: 100 };
  rpc.threads.set('external-not-loaded', { id: 'external-not-loaded', cwd: d.a, source: 'cli', status: { type: 'notLoaded' }, turns: [] });
  rpc.history = { data: [{ id: 'outside-turn', status: 'inProgress', items: [] }], nextCursor: null };
  let observation = { agents: [{ threadId: 'external-not-loaded', pid: 200, status: 'working' }], complete: true }, checks = 0;
  const f = await fixture(t, d.config, { rpc, observeExternalThreads: async () => { checks++; if (observation instanceof Error) throw observation; return observation; } });
  await f.request('/api/session'); const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  const open = () => f.request('/api/resume', { projectId: project.id, threadId: 'external-not-loaded' });
  for (const status of ['working', 'idle', 'unknown']) {
    observation = { agents: [{ threadId: 'external-not-loaded', pid: 200, status }, { threadId: 'external-not-loaded', pid: 100, status: 'idle' }], complete: true };
    const result = await open();
    assert.equal(result.status, 200); assert.equal(result.data.thread.readOnly, true); assert.equal(result.data.thread.readOnlyReason, 'external_thread_open');
    assert.equal(result.data.thread.turns[0].status, 'inProgress');
    assert.equal(f.relay.state.loadedThreads.has('external-not-loaded'), false);
    assert.equal(f.relay.state.activeTurns.has('external-not-loaded'), false, 'external history must not create a relay execution lock');
    const sent = await f.request('/api/turns', { projectId: project.id, threadId: 'external-not-loaded', text: 'must not write', submissionId: `external-${status}` });
    assert.equal(sent.status, 409); assert.equal(sent.data.error.code, 'external_thread_open'); assert.match(sent.data.error.message, /关闭原客户端/);
  }
  observation = Error('observer temporarily unavailable');
  assert.equal((await open()).data.thread.readOnly, true, 'an observer failure cannot clear a previously known external writer');
  observation = { agents: [], complete: false };
  assert.equal((await open()).data.thread.readOnly, true, 'a partial scan cannot clear a previously known external writer');
  assert.equal(rpc.calls.filter(call => ['thread/resume', 'turn/start'].includes(call.method)).length, 0);
  rpc.history = { data: [{ id: 'outside-turn', status: 'completed', items: [] }], nextCursor: null };
  observation = { agents: [{ threadId: 'external-not-loaded', pid: 200, status: 'idle' }], complete: true };
  const idle = await open(); assert.equal(idle.data.thread.turns[0].status, 'completed'); assert.equal(idle.data.thread.readOnly, true); assert.equal(f.relay.state.activeTurns.has('external-not-loaded'), false);
  observation = { agents: [], complete: true };
  const released = await open(); assert.equal(released.data.thread.readOnly, false); assert.equal(released.data.thread.readOnlyReason, undefined);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal((await f.request('/api/turns', { projectId: project.id, threadId: 'external-not-loaded', text: 'original client has closed', submissionId: 'after-close' })).status, 200);
  assert.ok(checks >= 10, 'each open and turn must obtain a fresh observation');
});

test('the relay child holder is exempt and unmapped processes never become invented thread owners', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc(); rpc.child = { pid: 100 };
  rpc.threads.set('self-held', { id: 'self-held', cwd: d.a, status: { type: 'notLoaded' }, turns: [] });
  const observeExternalThreads = async () => ({ agents: [{ threadId: 'self-held', pid: 100, status: 'working' }, { pid: 200, threadId: null, status: 'unknown' }], complete: true, unmappedProcesses: 1 });
  const f = await fixture(t, d.config, { rpc, observeExternalThreads }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  const opened = await f.request('/api/resume', { projectId: project.id, threadId: 'self-held' });
  assert.equal(opened.status, 200); assert.equal(opened.data.thread.readOnly, false);
  assert.equal((await f.request('/api/turns', { projectId: project.id, threadId: 'self-held', text: 'own relay turn', submissionId: 'self-turn' })).status, 200);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('turn submission rechecks external holders after resume instead of trusting an earlier empty observation', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc(); rpc.child = { pid: 100 };
  rpc.threads.set('new-external-holder', { id: 'new-external-holder', cwd: d.a, status: { type: 'notLoaded' }, turns: [] });
  let checks = 0;
  const observeExternalThreads = async () => ({ agents: ++checks === 1 ? [] : [{ threadId: 'new-external-holder', pid: 200, status: 'unknown' }], complete: true });
  const f = await fixture(t, d.config, { rpc, observeExternalThreads }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  const sent = await f.request('/api/turns', { projectId: project.id, threadId: 'new-external-holder', text: 'must not write after another client opened', submissionId: 'new-holder' });
  assert.equal(sent.status, 409); assert.equal(sent.data.error.code, 'external_thread_open'); assert.equal(checks, 2);
  assert.equal(rpc.calls.filter(call => call.method === 'thread/resume').length, 1);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('only the latest history of a relay-loaded thread reconciles execution locks, including terminal transitions', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc();
  rpc.threads.set('own-history', { id: 'own-history', cwd: d.a, status: { type: 'idle' }, turns: [] });
  rpc.history = { data: [{ id: 'own-active-turn', status: 'inProgress', items: [] }], nextCursor: 'older-page' };
  const f = await fixture(t, d.config, { rpc }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  await f.request(`/api/history?project=${project.id}&thread=own-history`);
  assert.equal(f.relay.state.activeTurns.has('own-history'), false, 'metadata/history reads do not load or claim a thread');
  const resumed = await f.request('/api/resume', { projectId: project.id, threadId: 'own-history' });
  assert.equal(f.relay.state.loadedThreads.has('own-history'), true); assert.equal(f.relay.state.activeTurns.get('own-history'), 'own-active-turn');
  rpc.history = { data: [{ id: 'old-completed-turn', status: 'completed', items: [] }], nextCursor: null };
  assert.equal((await f.request(`/api/history?project=${project.id}&thread=own-history&cursor=${resumed.data.nextCursor}`)).status, 200);
  assert.equal(f.relay.state.activeTurns.get('own-history'), 'own-active-turn', 'older history cannot clear current execution state');
  assert.equal((await f.request('/api/turns', { projectId: project.id, threadId: 'own-history', text: 'still busy', submissionId: 'before-terminal-refresh' })).data.error.code, 'turn_busy');
  rpc.history = { data: [{ id: 'own-active-turn', status: 'completed', items: [] }], nextCursor: null };
  assert.equal((await f.request(`/api/history?project=${project.id}&thread=own-history`)).status, 200);
  assert.equal(f.relay.state.activeTurns.has('own-history'), false);
  assert.equal((await f.request('/api/turns', { projectId: project.id, threadId: 'own-history', text: 'completed history clears the old lock', submissionId: 'after-terminal-refresh' })).status, 200);
});

test('interrupt checks a fresh external holder observation before mutating a previously loaded thread', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc(); rpc.child = { pid: 100 };
  rpc.threads.set('interrupt-thread', { id: 'interrupt-thread', cwd: d.a, status: { type: 'idle' }, turns: [] });
  rpc.history = { data: [{ id: 'interrupt-turn', status: 'inProgress', items: [] }], nextCursor: null };
  let observation = { agents: [], complete: true };
  const f = await fixture(t, d.config, { rpc, observeExternalThreads: async () => observation }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  await f.request('/api/resume', { projectId: project.id, threadId: 'interrupt-thread' });
  observation = { agents: [{ threadId: 'interrupt-thread', pid: 200, status: 'idle' }], complete: true };
  const denied = await f.request('/api/interrupt', { threadId: 'interrupt-thread', turnId: 'interrupt-turn' });
  assert.equal(denied.status, 409); assert.equal(denied.data.error.code, 'external_thread_open');
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 0);
  observation = { agents: [{ threadId: 'interrupt-thread', pid: 100, status: 'working' }], complete: true };
  assert.equal((await f.request('/api/interrupt', { threadId: 'interrupt-thread', turnId: 'interrupt-turn' })).status, 200);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('latest history and an early terminal event cannot release a still-pending turn submission reservation', async t => {
  const d = await directories(t), rpc = new WorkspaceRpc();
  rpc.threads.set('pending-thread', { id: 'pending-thread', cwd: d.a, status: { type: 'idle' }, turns: [] });
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), call = rpc.call.bind(rpc);
  let held = false;
  rpc.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'turn/start' && !held) { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  const f = await fixture(t, d.config, { rpc }); await f.request('/api/session');
  const project = (await f.request('/api/projects', { cwd: d.a })).data.project;
  const body = { projectId: project.id, threadId: 'pending-thread', text: 'pending submission', submissionId: 'pending-original' };
  const first = f.request('/api/turns', body); t.after(() => release.resolve());
  await entered.promise;
  assert.equal((await f.request(`/api/history?project=${project.id}&thread=pending-thread`)).status, 200);
  assert.equal((await f.request('/api/turns', { ...body, submissionId: 'after-history' })).data.error.code, 'turn_busy');
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'pending-thread', turn: { id: 'new-turn', status: 'completed', items: [] } } });
  assert.equal((await f.request('/api/turns', { ...body, submissionId: 'after-terminal-event' })).data.error.code, 'turn_busy');
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
  release.resolve(); assert.equal((await first).status, 200);
  assert.equal((await f.request('/api/turns', { ...body, submissionId: 'after-original-response' })).status, 200);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 2);
});

test('reasoning, plan and thread status retain only protocol-supported fields and notifications stay thread-scoped', async t => {
  const d = await directories(t), f = await fixture(t, d.config); await f.request('/api/session');
  const reasoning = safeItem({ id: 'r', type: 'reasoning', summary: ['Real supplied summary'], content: [], private: 'MUST_NOT_LEAK' });
  assert.deepEqual(reasoning.summary, ['Real supplied summary']); assert.deepEqual(reasoning.content, []); assert.ok(!JSON.stringify(reasoning).includes('MUST_NOT_LEAK'));
  assert.equal(safeItem({ id: 'p', type: 'plan', text: 'Real supplied plan' }).text, 'Real supplied plan');
  assert.equal(safeItem({ id: 't', type: 'mcpToolCall', server: 'server', tool: 'tool', status: 'completed', arguments: { private: 'MUST_NOT_LEAK' } }).tool, 'tool');
  const metadata = safeThread({ id: 'thread', status: { type: 'active', activeFlags: ['waitingOnApproval', 'PRIVATE_FLAG'] }, source: { subAgent: 'review', private: 'MUST_NOT_LEAK' }, createdAt: 123, updatedAt: 456, private: 'MUST_NOT_LEAK' });
  assert.deepEqual(metadata.status, { type: 'active', activeFlags: ['waitingOnApproval'] }); assert.deepEqual(metadata.source, { subAgent: 'review' }); assert.equal(metadata.updatedAt, 456);
  f.relay.state.authorizedThreads.set('known', d.a);
  const messages = [
    ['item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Supplied progress' }],
    ['item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 }],
    ['item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'Supplied content' }],
    ['item/plan/delta', { itemId: 'p', delta: 'Plan text' }],
    ['turn/plan/updated', { explanation: 'Plan explanation', plan: [{ step: 'Step', status: 'inProgress' }] }],
    ['thread/status/changed', { status: { type: 'active', activeFlags: ['waitingOnUserInput'], private: 'MUST_NOT_LEAK' } }]
  ];
  for (const [method, params] of messages) {
    f.rpc.emit('notification', { method, params: { ...params, threadId: 'foreign', turnId: 'turn', private: 'MUST_NOT_LEAK' } });
    f.rpc.emit('notification', { method, params: { ...params, threadId: 'known', turnId: 'turn', private: 'MUST_NOT_LEAK' } });
  }
  assert.equal(f.relay.state.events.length, messages.length);
  assert.deepEqual(f.relay.state.events.map(event => event.data.method), messages.map(([method]) => method));
  assert.ok(f.relay.state.events.every(event => event.data.params.threadId === 'known'));
  assert.ok(!JSON.stringify(f.relay.state.events).includes('MUST_NOT_LEAK'));
  assert.equal(f.relay.state.events[0].data.params.summaryIndex, 0);
  assert.deepEqual(f.relay.state.events.at(-1).data.params.status, { type: 'active', activeFlags: ['waitingOnUserInput'] });
});

test('overview uses the injected collector only after authentication', async t => {
  const d = await directories(t); let collected = 0;
  const f = await fixture(t, d.config, { overviewCollector: async () => { collected++; return { metrics: { cpu: null }, agents: [] }; } });
  assert.equal((await f.request('/api/overview')).status, 401); assert.equal(collected, 0);
  await f.request('/api/session');
  assert.deepEqual((await f.request('/api/overview')).data, { metrics: { cpu: null }, agents: [] }); assert.equal(collected, 1);
  assert.equal(f.rpc.calls.length, 0);
});
