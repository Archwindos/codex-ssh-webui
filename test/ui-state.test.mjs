import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { appFixtureSource } from './ui-source-fixture.mjs';
import { webcrypto } from 'node:crypto';

const source = appFixtureSource(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const textOf = node => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(' ');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, fetcher = () => { throw Error('Unexpected request'); }, browser = {}) {
  const nodes = new Map(), timers = new Map(), listeners = new Map(), requests = [], storage = new Map(); let timer = 0;
  const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', className: '', children: [], dataset: {}, attributes: {}, listeners: new Map(), style: { values: {}, setProperty(name, value) { this.values[name] = value; } }, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {}, contains() { return false; } }, setAttribute(name, value) { this.attributes[name] = value; }, toggleAttribute() {}, focus() {}, querySelectorAll() { return []; },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, prepend(...values) { this.children.unshift(...values); } });
  const document = { visibilityState: 'visible', getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, createDocumentFragment: node, addEventListener(name, fn) { listeners.set(name, fn); } };
  const context = vm.createContext({ document, window: { addEventListener() {} }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, AbortController, crypto: { randomUUID: () => 'ui-submission' },
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout(id) { timers.delete(id); }, fetch(url, options) { requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined }); return fetcher(url, options); }, ...browser });
  vm.runInContext(source, context); const run = code => vm.runInContext(code, context);
  run("state.session = { authenticated: true, csrf: 'fixture-csrf', mode: 'mock', projects: [{ id: 'one', name: 'One', cwd: '/one' }, { id: 'two', name: 'Two', cwd: '/two' }], capabilities: {} }; state.projectId = 'one'; state.connected = true; state.upstreamStatus = 'connected'; controls();");
  t.after(() => run('stopSubscription(); stopOverview()'));
  const event = (id, name = 'click') => nodes.get(id).listeners.get(name)({ preventDefault() {} });
  return { run, nodes, timers, requests, document, listeners, event, storage };
}

test('all-history opens a thread with its own project and leaves message text inert', async t => {
  const f = fixture(t, async url => response(url.startsWith('/api/threads?') ? { data: [{ id: 'thread-two', projectId: 'two', name: 'Other project', cwd: '/two', status: { type: 'idle' } }], nextCursor: null } : { thread: { id: 'thread-two', cwd: '/two', turns: [] } }));
  f.run('state.session.capabilities.allThreads = true'); await f.run('history()');
  assert.equal(f.requests[0].url, '/api/threads?project=all');
  f.nodes.get('threads').children[0].listeners.get('click')(); await flush();
  assert.deepEqual(f.requests[1].body, { projectId: 'two', threadId: 'thread-two' });
  assert.equal(f.run('state.projectId'), 'one'); assert.equal(f.run('state.threadProjectId'), 'two'); assert.equal(f.run('state.view'), 'chat');
  f.run("appendItem({ id: 'unsafe', type: 'agentMessage', text: '<img src=x onerror=alert(1)>' })");
  assert.equal(f.run("state.items.get('unsafe').body.textContent"), '<img src=x onerror=alert(1)>');
});

test('selected workspace project creates directly without another folder choice', async t => {
  const f = fixture(t, async url => response(url.startsWith('/api/directories') ? { cwd: '/two', parent: '/', entries: [{ name: 'child', cwd: '/two/child' }], roots: ['/'], limited: false } : url === '/api/projects' ? { project: { id: 'two', name: 'Two', cwd: '/two' } } : url === '/api/threads' ? { thread: { id: 'new-two', cwd: '/two', turns: [] } } : { data: [], nextCursor: null }));
  f.run('state.session.capabilities = { workspaceBrowser: true, allThreads: true, projectManagement: true }; state.projectId = "two"; state.session.workspace = { defaultCwd: "/one" }; renderProjects()');
  await f.run('openNewThread()');
  assert.equal(f.requests.filter(r => r.url.startsWith('/api/directories') || r.url === '/api/projects').length, 0);
  assert.deepEqual(f.requests.find(r => r.url === '/api/threads').body, { projectId: 'two' });
  assert.equal(f.run('state.view'), 'chat'); assert.equal(f.run('state.thread.id'), 'new-two'); assert.equal(f.run('state.posting'), false);
});

test('leaving the folder picker ignores late directory results and fixed mode still creates directly', async t => {
  const pending = deferred(); const f = fixture(t, url => url.startsWith('/api/directories') ? pending.promise : Promise.resolve(response(url === '/api/threads' ? { thread: { id: 'fixed', turns: [] } } : { data: [] })));
  f.run('state.session.capabilities.projectManagement = true'); const opening = f.run('openProjectEditor()');
  f.event('cancel-directory'); pending.resolve(response({ cwd: '/late', entries: [] })); await opening;
  assert.equal(f.run('state.directory'), null); assert.equal(f.run('state.view'), 'home');
  f.run('state.session.capabilities.workspaceBrowser = false'); await f.run('openNewThread()');
  assert.equal(f.run('state.thread.id'), 'fixed'); assert.equal(f.run('state.view'), 'chat');
  assert.equal(f.requests.filter(r => r.url === '/api/projects').length, 0);
});

test('project switching preserves the active turn and future creation selection independently', async t => {
  const f = fixture(t, async () => response({ data: [] }));
  f.run("state.session.capabilities = { workspaceBrowser: true, projectManagement: true, allThreads: true }; renderThread({ id: 'old', cwd: '/one', status: 'active', turns: [] }, null, true, 'one'); state.turnId = 'running'; state.pending = { threadId: 'old', text: 'pending' }; $('project').value = 'two'");
  f.event('project', 'change'); await flush();
  assert.equal(f.run('state.projectId'), 'two'); assert.equal(f.run('state.threadProjectId'), 'one');
  assert.equal(f.run('state.thread.id'), 'old'); assert.equal(f.run('state.busy'), true); assert.equal(f.run('state.turnId'), 'running');
  assert.equal(f.run('state.pending.text'), 'pending'); assert.equal(f.nodes.get('project-field').hidden, false);
  assert.equal(f.nodes.get('chat-project-path').textContent, '/one'); assert.equal(f.nodes.get('project-path').textContent, '/two');
  assert.equal(f.nodes.get('new-thread').disabled, true); assert.equal(f.requests.some(r => r.url === '/api/interrupt' || r.url === '/api/turns'), false);
  const saved = JSON.parse(f.storage.get('relay-selection')); assert.equal(saved.projectId, 'two'); assert.equal(saved.threadProjectId, 'one'); assert.equal(saved.threadCwd, '/one');
});

test('sending and older messages use the viewed thread project after selecting another project', async t => {
  const f = fixture(t, async url => response(url === '/api/turns' ? { turn: { id: 'turn', status: 'completed' } } : { turns: [], nextCursor: null }));
  f.run("renderThread({ id: 'old', cwd: '/one', turns: [] }, 'older', true, 'one'); state.projectId = 'two'; $('prompt').value = 'continue old work'; controls()");
  f.event('composer', 'submit'); await flush(); f.event('older-messages'); await flush();
  assert.equal(f.requests.find(r => r.url === '/api/turns').body.projectId, 'one');
  assert.match(f.requests.find(r => r.url.startsWith('/api/history')).url, /project=one&thread=old/);
});

test('current project history can be filtered and all history remains accessible', async t => {
  const f = fixture(t, async () => response({ data: [] }));
  f.run("state.session.capabilities.allThreads = true; state.projectId = 'two'; $('history-scope').value = 'project'");
  f.event('history-scope', 'change'); await flush();
  assert.equal(f.requests.at(-1).url, '/api/threads?project=two');
  f.nodes.get('history-scope').value = 'all'; f.event('history-scope', 'change'); await flush();
  assert.equal(f.requests.at(-1).url, '/api/threads?project=all'); assert.equal(f.nodes.get('history-filter').hidden, false);
});

test('a new project validates its folder and saves without creating a Codex thread', async t => {
  const f = fixture(t, async url => response(url.startsWith('/api/directories') ? { cwd: '/new', entries: [], roots: [] } : url === '/api/projects' ? { project: { id: 'new', name: '<b>Project</b>', cwd: '/new', revision: 1, managed: true } } : { data: [] }));
  f.run('state.session.capabilities.projectManagement = true'); await f.run('openProjectEditor()');
  f.nodes.get('project-name').value = '<b>Project</b>';
  f.nodes.get('directory-path').value = '/manual'; f.event('directory-path', 'input');
  assert.equal(f.nodes.get('select-directory').disabled, true); await f.run('saveProject()');
  assert.equal(f.requests.some(r => r.url === '/api/projects'), false);
  await f.run("browseDirectory('/new')"); await f.run('saveProject()');
  assert.deepEqual(f.requests.find(r => r.url === '/api/projects').body, { cwd: '/new', name: '<b>Project</b>' });
  assert.equal(f.run('state.projectId'), 'new'); assert.equal(f.nodes.get('project').children.at(-1).textContent, '<b>Project</b>');
  assert.equal(f.requests.some(r => r.url === '/api/threads' || r.url === '/api/turns'), false);
});

test('rebinding preserves the viewed old cwd and remaps its API project while new threads use the selected binding', async t => {
  const projects = [{ id: 'one', name: 'Renamed', cwd: '/new-one', revision: 4, managed: true }, { id: 'old-one', name: 'one', cwd: '/one', revision: 1, managed: false }];
  const f = fixture(t, async url => response(url.startsWith('/api/directories') ? { cwd: '/new-one', entries: [] } : url === '/api/projects/update' ? { project: projects[0], projects, previousProject: projects[1] } : url === '/api/threads' ? { thread: { id: 'new', cwd: '/new-one', turns: [] } } : url === '/api/turns' ? { turn: { id: 'turn', status: 'completed' } } : { data: [] }));
  f.run("state.session.capabilities = { projectManagement: true, allThreads: true }; state.session.projects[0].revision = 3; renderThread({ id: 'old', cwd: '/one', turns: [] }, null, true, 'one')");
  await f.run('openProjectEditor(true)'); f.nodes.get('project-name').value = 'Renamed'; await f.run('saveProject()');
  assert.deepEqual(f.requests.find(r => r.url === '/api/projects/update').body, { projectId: 'one', cwd: '/new-one', name: 'Renamed', revision: 3 });
  assert.equal(f.run('state.projectId'), 'one'); assert.equal(f.run('state.threadProjectId'), 'old-one'); assert.equal(f.run('state.thread.cwd'), '/one');
  f.run("$('prompt').value = 'continue'; controls()"); f.event('composer', 'submit'); await flush();
  assert.equal(f.requests.find(r => r.url === '/api/turns').body.projectId, 'old-one');
  await f.run('openNewThread()'); assert.equal(f.requests.find(r => r.url === '/api/threads').body.projectId, 'one'); assert.equal(f.run('state.thread.cwd'), '/new-one');
});

test('project save failure preserves input and conflict requires an explicit reload before retry', async t => {
  let conflict = false;
  const f = fixture(t, async url => response(url.startsWith('/api/directories') ? { cwd: '/edited', entries: [] } : url === '/api/projects/update' ? { error: { code: conflict ? 'project_conflict' : 'invalid_directory', message: 'Cannot save' } } : { projects: [{ id: 'one', name: 'Remote', cwd: '/remote', revision: 9 }] }, url === '/api/projects/update' ? conflict ? 409 : 400 : 200));
  f.run('state.session.capabilities.projectManagement = true; state.session.projects[0].revision = 1'); await f.run('openProjectEditor(true)');
  f.nodes.get('project-name').value = 'My input'; await f.run('saveProject()');
  assert.equal(f.run('state.view'), 'directory'); assert.equal(f.nodes.get('project-name').value, 'My input'); assert.equal(f.nodes.get('directory-path').value, '/edited'); assert.equal(f.nodes.get('select-directory').disabled, false);
  conflict = true; await f.run('saveProject()'); assert.equal(f.nodes.get('reload-project').hidden, false); assert.equal(f.nodes.get('select-directory').disabled, true);
  assert.equal(f.nodes.get('project-name').value, 'My input'); assert.match(f.nodes.get('project-save-error-text').textContent, /重新载入/);
  const attempts = f.requests.length; await f.run('saveProject()'); assert.equal(f.requests.length, attempts);
  await f.run('reloadProject()'); assert.equal(f.nodes.get('project-name').value, 'Remote'); assert.equal(f.run('state.projectEdit.revision'), 9); assert.equal(f.run('state.projectConflict'), false);
});

test('session recovery resumes the viewed cwd while retaining the different project selected for new chats', async t => {
  const session = { authenticated: true, mode: 'mock', csrf: 'csrf', upstreamStatus: 'connected', projects: [{ id: 'one', name: 'One', cwd: '/new-one', revision: 2 }, { id: 'old', name: 'Old folder', cwd: '/one', revision: 1 }], capabilities: { allThreads: true, projectManagement: true, workspaceBrowser: true }, pendingApprovals: [] };
  const f = fixture(t, async url => response(url === '/api/session' ? session : url === '/api/resume' ? { thread: { id: 'viewed', cwd: '/one', turns: [] }, eventCursor: 4 } : { data: [] }));
  f.run("state.projectId = 'one'; state.threadProjectId = 'one'; state.thread = { id: 'viewed', cwd: '/one' }");
  await f.run('hydrateSession(true)');
  assert.deepEqual(f.requests.find(r => r.url === '/api/resume').body, { projectId: 'old', threadId: 'viewed' });
  assert.equal(f.run('state.projectId'), 'one'); assert.equal(f.run('state.threadProjectId'), 'old');
  assert.equal(f.nodes.get('project-path').textContent, '/new-one'); assert.equal(f.nodes.get('chat-project-path').textContent, '/one');
});

for (const saved of [false, true]) test(`server restart resolves the old cwd before ${saved ? 'saved' : 'in-memory'} thread recovery without changing future creation`, async t => {
  const project = { id: 'one', name: 'Rebound', cwd: '/new-one', revision: 2, managed: true }, old = { id: 'resolved-old', name: 'Old folder', cwd: '/old folder', revision: 1, managed: false };
  let resolved = false;
  const f = fixture(t, async url => {
    if (url === '/api/session') return response({ authenticated: true, mode: 'mock', csrf: 'csrf', upstreamStatus: 'connected', projects: resolved ? [project, old] : [project], capabilities: { allThreads: true, projectManagement: true, workspaceBrowser: true }, pendingApprovals: [] });
    if (url === '/api/projects?cwd=%2Fold%20folder') { resolved = true; return response({ projects: [project, old], project: old }); }
    if (url === '/api/resume') return response({ thread: { id: 'viewed', cwd: old.cwd, turns: [] }, eventCursor: 4 });
    if (url === '/api/threads') return response({ thread: { id: 'new', cwd: project.cwd, turns: [] } });
    return response({ data: [] });
  });
  f.run(saved ? "state.projectId = null; savedSelection = { projectId: 'one', threadId: 'viewed', threadProjectId: 'stale-temporary-id', threadCwd: '/old folder', view: 'chat' }" : "state.projectId = 'one'; state.threadProjectId = 'stale-temporary-id'; state.thread = { id: 'viewed', cwd: '/old folder' }");
  await f.run('hydrateSession(true)');
  const lookupIndex = f.requests.findIndex(r => r.url.startsWith('/api/projects?')), resumeIndex = f.requests.findIndex(r => r.url === '/api/resume');
  assert.ok(lookupIndex >= 0 && resumeIndex > lookupIndex);
  assert.deepEqual(f.requests[resumeIndex].body, { projectId: 'resolved-old', threadId: 'viewed' });
  assert.equal(f.run('state.projectId'), 'one'); assert.equal(f.run('state.threadProjectId'), 'resolved-old'); assert.equal(f.run('state.thread.cwd'), '/old folder');
  assert.equal(f.requests.filter(r => r.url.startsWith('/api/projects') && r.options.method === 'POST').length, 0);
  await f.run('openNewThread()');
  assert.equal(f.requests.find(r => r.url === '/api/threads').body.projectId, 'one'); assert.equal(f.run('state.thread.cwd'), '/new-one');
});

test('unavailable old cwd recovery reports the lookup error without trying a stale temporary project id', async t => {
  const f = fixture(t, async url => response(url === '/api/session' ? { authenticated: true, upstreamStatus: 'connected', projects: [{ id: 'one', name: 'Rebound', cwd: '/new-one' }], capabilities: { allThreads: true, workspaceBrowser: true }, pendingApprovals: [] } : url.startsWith('/api/projects?') ? { error: { code: 'invalid_directory', message: 'Old folder is unavailable' } } : { data: [] }, url.startsWith('/api/projects?') ? 400 : 200));
  f.run("savedSelection = { projectId: 'one', threadId: 'viewed', threadProjectId: 'stale', threadCwd: '/missing' }");
  await f.run('hydrateSession(true)');
  assert.equal(f.requests.some(r => r.url === '/api/resume'), false); assert.match(f.nodes.get('error-text').textContent, /Old folder is unavailable/);
  assert.equal(f.run('state.projectId'), 'one'); assert.equal(f.requests.some(r => r.options.method === 'POST'), false);
});

test('overview has one in-flight request, refreshes every five seconds, and stops in the background', async t => {
  const pending = deferred(); const f = fixture(t, () => pending.promise);
  f.run('state.session.capabilities.overview = true'); const first = f.run('refreshOverview()'); await f.run('refreshOverview()');
  assert.equal(f.requests.length, 1);
  pending.resolve(response({ agents: [], metrics: {}, sampledAt: '2026-10-29T00:00:00Z' })); await first;
  assert.equal([...f.timers.values()].filter(timer => timer.ms === 5000).length, 1);
  f.document.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); await f.run('refreshOverview()');
  assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible'; f.run("state.view = 'chat'"); await f.run('refreshOverview()'); assert.equal(f.requests.length, 1);
  f.run("state.view = 'home'; setAuthenticated(false)"); await f.run('refreshOverview()'); assert.equal(f.requests.length, 1);
});

test('unknown metrics stay unknown and unconfirmed conversations stay out of the working list', t => {
  const f = fixture(t);
  f.run("renderOverview({ agents: [{ name: 'External child', threadId: 'child', source: 'external', status: 'unknown', canOpen: false }], metrics: { cpu: { percent: null, cores: 32 }, memory: { percent: null }, gpus: [{ name: 'GPU', utilizationPercent: null }], storage: [] }, coverage: { external: '部分状态未知' } })");
  const resources = f.nodes.get('resource-list').children.flatMap(group => group.children);
  assert.equal(resources[0].children[1].children[0].children[0].textContent, '暂不可用');
  assert.equal(f.nodes.get('agent-summary').textContent, '部分会话状态暂不可确认');
  assert.doesNotMatch(textOf(f.nodes.get('agents')), /External child/);
  f.run("renderOverview({ agents: [], metrics: {}, coverage: { externalComplete: false } })");
  assert.equal(f.nodes.get('agent-summary').textContent, '部分会话状态暂不可确认');
  assert.match(textOf(f.nodes.get('agents')), /暂未发现/);
  f.run("renderThread({ id: 'external-active', status: { type: 'active' }, turns: [] }); $('prompt').value = 'cannot take over'; controls()");
  assert.equal(f.nodes.get('send').disabled, true, 'opening an externally active snapshot must not allow a second turn');
});

test('the working section includes only working conversations with nonempty thread identities', t => {
  const f = fixture(t);
  f.run(`renderOverview({ agents: [
    { threadId: 'working-one', projectId: 'one', name: 'First running conversation', status: 'working', tmuxState: 'none' },
    { threadId: 'working-two', cwd: '/path/second-project', name: 'Second running conversation', status: 'working', tmuxState: 'unknown' },
    { threadId: 'idle', name: 'Hidden idle', status: 'idle' },
    { threadId: 'unknown', name: 'Hidden unknown', status: 'unknown' },
    { threadId: 'approval', name: 'Hidden approval', status: 'waitingApproval' },
    { processId: 321, name: 'Hidden pure process', status: 'working' },
    { threadId: ' ', name: 'Hidden blank identity', status: 'working' }
  ], metrics: {}, coverage: { externalComplete: true } })`);
  assert.deepEqual(f.nodes.get('agents').children.map(node => node.dataset.threadId), ['working-one', 'working-two']);
  const visible = textOf(f.nodes.get('agents'));
  assert.match(visible, /First running conversation/); assert.match(visible, /One/); assert.match(visible, /second-project/);
  assert.doesNotMatch(visible, /Hidden/); assert.match(f.nodes.get('agent-summary').textContent, /2 个对话正在运行/);
  f.run("renderOverview({ agents: [{ threadId: 'idle', status: 'idle' }, { threadId: 'paused', status: 'waitingApproval' }], metrics: {}, coverage: { externalComplete: true } })");
  assert.equal(f.nodes.get('agents').children[0].textContent, '暂无正在工作的对话。'); assert.equal(f.nodes.get('agent-summary').hidden, true);
});

test('working cards display verified tmux targets and explicit none or unknown states without PID substitutes', t => {
  const f = fixture(t);
  f.run(`renderOverview({ agents: [
    { threadId: 'attached', status: 'working', name: '<img src=x onerror=alert(1)>', tmuxState: 'attached', tmux: { sessionId: '$3', sessionName: 'codex', windowIndex: 0, paneIndex: 0, paneId: '%2', target: '$3:0.0' } },
    { threadId: 'none', status: 'working', tmuxState: 'none', processId: 12345 },
    { threadId: 'unknown', status: 'working', tmuxState: 'unknown', processId: 23456 },
    { threadId: 'malformed', status: 'working', tmuxState: 'attached', tmux: { target: '<svg onload=alert(2)>' }, processId: 34567 },
    { threadId: 'missing', status: 'working', tmuxState: 'attached', processId: 45678 }
  ], metrics: {} })`);
  const cards = f.nodes.get('agents').children;
  assert.match(textOf(cards[0]), /tmux \$3:0\.0/);
  assert.equal(cards[0].children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.match(textOf(cards[1]), /未使用 tmux/);
  for (const card of cards.slice(2)) assert.match(textOf(card), /无法确认 tmux/);
  assert.doesNotMatch(textOf(f.nodes.get('agents')), /12345|23456|34567|45678|<svg/);
});

test('compact resources retain sampled utilization, memory capacities and actual disk available bytes', t => {
  const f = fixture(t), gb = 1024 ** 3;
  f.run(`renderOverview({ agents: [], metrics: { cpu: { percent: 12.6, cores: 32 }, memory: { usedBytes: ${108 * gb}, totalBytes: ${252 * gb}, percent: 42.857 }, gpus: [{ index: 0, name: 'Long GPU model not needed here', utilizationPercent: 0, memoryUsedBytes: ${8.5 * gb}, memoryTotalBytes: ${24 * gb}, temperatureC: 72 }, { index: 1, utilizationPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: ${24 * gb} }], storage: [{ path: '/storage/data', totalBytes: ${100 * gb}, usedBytes: ${30 * gb}, availableBytes: ${68 * gb}, percent: 30 }, { path: '/storage/unknown', availableBytes: null }] } })`);
  const resources = textOf(f.nodes.get('resource-list'));
  assert.match(resources, /CPU 13%/); assert.match(resources, /内存 108 GB \/ 252 GB/);
  assert.match(resources, /GPU 0 计算 0% 显存 8\.5 GB \/ 24 GB/);
  assert.match(resources, /GPU 1 计算 0% 显存 0 B \/ 24 GB/);
  assert.match(resources, /\/storage\/data 30 GB \/ 100 GB 68 GB 可用/);
  assert.match(resources, /\/storage\/unknown 暂不可用/);
  assert.doesNotMatch(resources, /70 GB|Long GPU|72|32 核|42\.857|\.0 GB|0\.0 KB/);
  const groups = f.nodes.get('resource-list').children;
  assert.deepEqual(groups.map(group => group.dataset.resourceFamily), ['system', 'gpu', 'storage']);
  assert.deepEqual(groups.map(group => group.children.length), [2, 2, 2]);
  assert.deepEqual(groups[0].children.map(row => row.children[0].textContent), ['CPU', '内存']);
  const rows = groups.flatMap(group => group.children);
  assert.equal(rows[0].children[1].children[1].children[0].style.values['--usage'], '12.6%');
  assert.equal(rows[2].children[1].children[1].children[0].style.values['--usage'], '0%');
  assert.equal(rows[2].children[1].children[3].children[0].dataset.percent, String(8.5 / 24 * 100));
  assert.equal(rows[4].children[1].children[1].children[0].dataset.percent, '30');
  assert.equal(rows[5].children[1].children[1].dataset.known, 'false'); assert.equal(rows[5].children[1].children[1].children.length, 0);
});

test('GPU compute and VRAM stay distinct, and high VRAM warns even at zero or unknown compute', t => {
  const f = fixture(t), gb = 1024 ** 3;
  f.run(`renderOverview({ agents: [], metrics: { gpus: [
    { index: 2, utilizationPercent: 0, memoryUsedBytes: ${77.3 * gb}, memoryTotalBytes: ${80 * gb} },
    { index: 3, utilizationPercent: null, memoryUsedBytes: ${76 * gb}, memoryTotalBytes: ${80 * gb} },
    { index: 4, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null },
    { index: 5, utilizationPercent: 100, memoryUsedBytes: 0, memoryTotalBytes: ${80 * gb} }
  ] } })`);
  const groups = f.nodes.get('resource-list').children, gpus = groups[1].children;
  assert.match(textOf(gpus[0]), /GPU 2 计算 0% 显存 77\.3 GB \/ 80 GB 显存占用高 · 96\.6%/);
  assert.equal(gpus[0].dataset.memoryPressure, 'high');
  assert.equal(gpus[0].children[1].children[1].children[0].style.values['--usage'], '0%');
  assert.equal(gpus[0].children[1].children[3].children[0].dataset.percent, String(77.3 / 80 * 100));
  assert.match(textOf(gpus[1]), /计算 暂不可用 显存 76 GB \/ 80 GB 显存占用高 · 95%/);
  assert.equal(gpus[1].dataset.memoryPressure, 'high');
  assert.match(textOf(gpus[2]), /计算 暂不可用 显存未知/);
  assert.equal(gpus[2].dataset.memoryPressure, 'unknown');
  for (const index of [1, 3]) { assert.equal(gpus[2].children[1].children[index].dataset.known, 'false'); assert.equal(gpus[2].children[1].children[index].children.length, 0); }
  assert.doesNotMatch(textOf(gpus[2]), /0%|0 B|显存占用高/);
  assert.equal(gpus[3].dataset.memoryPressure, 'normal');
  assert.doesNotMatch(textOf(gpus[3]), /显存占用高/);
  assert.doesNotMatch(textOf(gpus[0]), /空闲|繁忙|可用|忙碌/);
  assert.doesNotMatch(textOf(groups[1]), /空闲|繁忙|可分配|忙碌/);
  assert.deepEqual(groups.map(group => group.dataset.resourceFamily), ['system', 'gpu', 'storage']);
  assert.deepEqual(groups.map(group => group.children.length), [2, 4, 1]);
});

test('sending, reasoning deltas, tools, approval and completion have distinct activity states', async t => {
  const pending = deferred(); const f = fixture(t, url => url === '/api/turns' ? pending.promise : Promise.resolve(response({ data: [] })));
  f.run("state.thread = { id: 'one-thread' }; state.view = 'chat'; $('prompt').value = 'hello'; controls()");
  f.event('composer', 'submit'); assert.equal(f.run('state.activityPhase'), 'sending'); assert.equal(f.nodes.get('run-state').dataset.active, 'true');
  pending.resolve(response({ turn: { id: 'turn', status: 'inProgress', items: [{ id: 'accepted-user', type: 'userMessage', content: [{ text: 'hello' }] }] } })); await flush();
  assert.equal(f.run("state.items.get('accepted-user').text"), 'hello', 'POST snapshot user messages must be shown even without a separate notification');
  f.run("rpc({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'one-thread', itemId: 'reason', summaryIndex: 0, delta: 'first' } }); rpc({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'one-thread', itemId: 'reason', summaryIndex: 0, delta: ' second' } })");
  assert.equal(f.run('state.activityPhase'), 'thinking'); assert.equal(f.run("state.items.get('reason').text"), 'first second');
  f.run("rpc({ method: 'item/started', params: { threadId: 'one-thread', item: { id: 'cmd', type: 'commandExecution', command: 'echo x' } } })");
  assert.equal(f.run('state.activityPhase'), 'tool');
  f.run("handleEvent('approval', { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'one-thread', turnId: 'turn' } })");
  assert.equal(f.run('state.activityPhase'), 'approval'); assert.equal(f.nodes.get('run-state').dataset.active, 'false');
  f.run("rpc({ method: 'turn/completed', params: { threadId: 'one-thread', turn: { id: 'turn', status: 'interrupted' } } })"); await flush();
  assert.equal(f.run('state.activityPhase'), 'interrupted'); assert.equal(f.nodes.get('run-state').dataset.active, 'false'); assert.equal(f.run('state.activityTimer'), null);
});

test('overview failure is retryable and does not block a chat or replace the last sample', async t => {
  let fail = false; const f = fixture(t, async () => response(fail ? { error: { message: 'unavailable' } } : { agents: [], metrics: { cpu: { percent: 42 } } }, fail ? 503 : 200));
  f.run('state.session.capabilities.overview = true'); await f.run('refreshOverview()'); fail = true; await f.run('refreshOverview()');
  assert.equal(f.nodes.get('overview-error').hidden, false); assert.equal(f.run('state.overview.metrics.cpu.percent'), 42); assert.equal(f.run('state.connected'), true);
  f.run("state.thread = { id: 'chat' }; showView('chat'); $('prompt').value = 'still usable'; controls()");
  assert.equal(f.nodes.get('send').disabled, false);
});

test('a live external client leaves history readable but requires closing that client before sending', async t => {
  const f = fixture(t, async () => response({ error: { code: 'external_thread_open', message: '请先关闭原客户端，再重新打开会话。' } }, 409));
  f.run("renderThread({ id: 'external', readOnly: true, readOnlyReason: 'external_thread_open', turns: [{ id: 'prior', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Existing history' }] }] }); $('prompt').value = 'do not send'; controls()");
  assert.equal(f.run("state.items.get('answer').text"), 'Existing history');
  assert.equal(f.nodes.get('send').disabled, true); assert.equal(f.nodes.get('prompt').disabled, true); assert.equal(f.nodes.get('interrupt').hidden, true);
  assert.match(f.nodes.get('run-state-text').textContent, /先关闭原客户端/); assert.equal(f.nodes.get('run-state').dataset.active, 'false');
  f.run("renderThread({ id: 'external', readOnly: false, turns: [] }); controls()");
  assert.equal(f.nodes.get('send').disabled, false); assert.equal(f.nodes.get('prompt').disabled, false);
  await assert.rejects(f.run("api('/api/turns', { projectId: 'one', threadId: 'external', text: 'client reopened in the meantime' })"), /先关闭原客户端/);
  assert.equal(f.run('state.thread.readOnly'), true); assert.equal(f.nodes.get('send').disabled, true);
});

test('a delayed in-progress POST snapshot cannot revive a turn already completed by streamed events', async t => {
  const pending = deferred(); const f = fixture(t, url => url === '/api/turns' ? pending.promise : Promise.resolve(response({ data: [] })));
  f.run("state.thread = { id: 'fast-thread' }; state.view = 'chat'; $('prompt').value = 'fast task'; controls()");
  f.event('composer', 'submit');
  f.run("rpc({ method: 'turn/started', params: { threadId: 'fast-thread', turn: { id: 'fast-turn' } } }); rpc({ method: 'turn/completed', params: { threadId: 'fast-thread', turn: { id: 'fast-turn', status: 'completed' } } }); rpc({ method: 'thread/status/changed', params: { threadId: 'fast-thread', status: { type: 'idle' } } })");
  assert.equal(f.run('state.busy'), false); assert.equal(f.run('state.turnId'), null);
  pending.resolve(response({ turn: { id: 'fast-turn', status: 'inProgress', items: [{ id: 'fast-user', type: 'userMessage', content: [{ text: 'fast task' }] }] } })); await flush();
  assert.equal(f.run("state.items.get('fast-user').text"), 'fast task', 'late snapshots must still supplement missing message items');
  assert.equal(f.run('state.busy'), false, 'the streamed terminal state must win over the older POST snapshot');
  assert.equal(f.run('state.turnId'), null); assert.equal(f.nodes.get('run-state').dataset.active, 'false');
  f.run("$('prompt').value = 'next task'; controls()"); assert.equal(f.nodes.get('send').disabled, false);
  const submissions = f.requests.filter(request => request.url === '/api/turns');
  assert.equal(submissions.length, 1); assert.equal(submissions[0].body.submissionId, 'ui-submission');
});

test('a delayed POST snapshot cannot replace the identity of a newer streamed turn', async t => {
  const pending = deferred(); const f = fixture(t, url => url === '/api/turns' ? pending.promise : Promise.resolve(response({ data: [] })));
  f.run("state.thread = { id: 'fast-thread' }; state.view = 'chat'; $('prompt').value = 'fast task'; controls()"); f.event('composer', 'submit');
  f.run("rpc({ method: 'turn/started', params: { threadId: 'fast-thread', turn: { id: 'old-turn' } } }); rpc({ method: 'turn/completed', params: { threadId: 'fast-thread', turn: { id: 'old-turn', status: 'completed' } } }); rpc({ method: 'thread/status/changed', params: { threadId: 'fast-thread', status: { type: 'idle' } } }); rpc({ method: 'turn/started', params: { threadId: 'fast-thread', turn: { id: 'new-turn' } } })");
  pending.resolve(response({ turn: { id: 'old-turn', status: 'inProgress', items: [] } })); await flush();
  assert.equal(f.run('state.turnId'), 'new-turn'); assert.equal(f.run('state.busy'), true); assert.equal(f.nodes.get('interrupt').disabled, false);
  assert.equal(f.requests.filter(request => request.url === '/api/turns').length, 1);
});

test('runtime mode lists all tmux Codex states in work-first order with separate open and close actions', t => {
  const f = fixture(t);
  f.run(`state.session.capabilities.runtimeManagement = true; renderOverview({ agents: [
    { runtimeId: 'idle', threadId: 'old', name: 'Idle', status: 'idle', tmuxState: 'attached', tmux: { target: '$2:0.0' }, managed: true, canOpen: true },
    { runtimeId: 'unknown', name: 'Unconfirmed Codex', status: 'unknown', tmuxState: 'attached', tmux: { target: '$3:0.0' }, managed: false },
    { runtimeId: 'work', threadId: 'run', name: 'Working', cwd: '/one', status: 'working', tmuxState: 'attached', tmux: { target: '$1:0.0' }, managed: true, canOpen: true },
    { runtimeId: 'approval', threadId: 'approval', name: 'Needs approval', status: 'waitingApproval', tmuxState: 'attached', tmux: { target: '$4:0.0' }, managed: false },
    { runtimeId: 'outside', name: 'Outside tmux', status: 'working', tmuxState: 'none' }
  ], metrics: {} })`);
  assert.deepEqual(f.nodes.get('agents').children.map(row => row.dataset.runtimeId), ['work', 'approval', 'idle', 'unknown']);
  const rendered = textOf(f.nodes.get('agents'));
  assert.match(rendered, /正在工作/); assert.match(rendered, /空闲/); assert.match(rendered, /状态未知/); assert.match(rendered, /终端运行 \/ 只读/);
  assert.match(rendered, /tmux \$1:0\.0/); assert.match(rendered, /关闭运行环境/); assert.doesNotMatch(rendered, /Outside tmux/);
  assert.equal(f.requests.length, 0);
});

test('library history remains readable without its cwd and does not start or join a runtime', async t => {
  const f = fixture(t, async url => response(url === '/api/resume' ? { thread: { id: 'historic', cwd: '/gone', unavailable: true, historyReadable: true, archived: false, runtimes: [], turns: [{ id: 'turn', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'Persistent answer' }] }] }, nextCursor: 'more' } : { turns: [], nextCursor: null }));
  f.run('state.session.capabilities = { library: true, runtimeManagement: true }; state.projectId = "two"');
  await f.run("openThread({ id: 'historic', cwd: '/gone', unavailable: true })");
  assert.deepEqual(f.requests[0].body, { threadId: 'historic' }); assert.equal(f.requests.length, 1);
  assert.equal(f.run("state.items.get('old-answer').text"), 'Persistent answer');
  assert.equal(f.nodes.get('prompt').disabled, true); assert.equal(f.nodes.get('join-thread').disabled, true); assert.equal(f.run('state.projectId'), 'two');
  f.event('older-messages'); await flush(); assert.equal(f.requests.at(-1).url, '/api/history?thread=historic&cursor=more');
  assert.equal(f.requests.some(request => request.url.startsWith('/api/runtimes') || request.url.startsWith('/api/projects')), false);
});

test('library filters archive state and paginates across persistent threads without tmux membership', async t => {
  const f = fixture(t, async url => response(url.includes('cursor=') ? { data: [{ id: 'second', name: 'Second', cwd: '/two', runtimes: [], archived: true }], nextCursor: null } : { data: [{ id: 'first', name: 'First', cwd: '/one', runtimes: [], archived: true }], nextCursor: 'next' }));
  f.run('state.session.capabilities = { library: true, allThreads: true, runtimeManagement: true, archiveManagement: true }; state.archived = true');
  await f.run('history()'); await f.run('history(true)');
  assert.equal(f.requests[0].url, '/api/threads?project=all&archived=true'); assert.equal(f.requests[1].url, '/api/threads?project=all&archived=true&cursor=next');
  assert.equal(f.nodes.get('library-list').children.length, 2); assert.match(textOf(f.nodes.get('library-list')), /First/); assert.match(textOf(f.nodes.get('library-list')), /Second/);
  assert.doesNotMatch(textOf(f.nodes.get('library-list')), /加入运行区|归档$/);
});

test('joining a historical thread preserves its id and attaches the returned managed runtime before enabling send', async t => {
  const f = fixture(t, async () => response({ thread: { id: 'historic', cwd: '/one', turns: [], runtimes: [] }, runtime: { runtimeId: 'runtime-1', threadId: 'historic', managed: true, status: 'idle' } }));
  f.run("state.session.capabilities = { runtimeManagement: true, library: true }; renderThread({ id: 'historic', cwd: '/one', turns: [], runtimes: [] }); $('prompt').value = 'continue'; controls()");
  assert.equal(f.nodes.get('send').disabled, true); await f.run('joinThread()');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/runtimes/join'); assert.deepEqual(f.requests[0].body, { threadId: 'historic', projectId: 'one' });
  assert.equal(f.run('state.thread.id'), 'historic'); assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'runtime-1'); assert.equal(f.nodes.get('send').disabled, false);
});

test('new conversation is a draft until first submit, then accepts an independent runtime without closing the old run', async t => {
  const f = fixture(t, async url => response(url === '/api/threads' ? { thread: { id: 'new', cwd: '/two', turns: [], runtimes: [] }, runtime: { runtimeId: 'separate-session', threadId: 'new', managed: true, status: 'idle' } } : { data: [] }));
  f.run("state.session.capabilities = { runtimeManagement: true, library: true, allThreads: true, workspaceBrowser: true }; state.projectId = 'two'; renderThread({ id: 'old', cwd: '/one', turns: [], runtimes: [{ runtimeId: 'still-running', managed: true, status: 'working' }] }); controls()");
  assert.equal(f.nodes.get('new-thread').disabled, false); await f.run('openNewThread()');
  assert.equal(f.run('state.thread'), null); assert.equal(f.requests.length, 0);
  assert.equal(f.nodes.get('prompt').disabled, false); assert.equal(f.nodes.get('welcome-new-thread').hidden, true);
  assert.equal(f.run('state.projectId'), 'two'); assert.match(f.nodes.get('run-state-text').textContent, /第一条任务/);
  await f.run('createThread()');
  assert.equal(f.run('state.thread.id'), 'new'); assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'separate-session');
  assert.equal(f.requests.some(request => request.url === '/api/interrupt' || request.url.startsWith('/api/runtimes/close')), false);
  assert.deepEqual(f.requests.find(request => request.url === '/api/threads').body, { projectId: 'two' });
});

test('closing previews all panes and threads, then only closes after explicit confirmation without archiving', async t => {
  const f = fixture(t, async url => response(url.endsWith('/preview') ? { planId: 'close-plan', session: { name: 'shared', id: '$1' }, affectedThreads: [{ id: 'root', name: 'Root' }, { id: 'child', name: 'Child' }], otherPanes: [{ paneId: '%2', label: 'Other shell' }], working: true, requiresConfirmation: true } : { status: 'closed' }));
  f.run("state.session.capabilities = { runtimeManagement: true, library: true }; renderThread({ id: 'root', cwd: '/one', turns: [], runtimes: [{ runtimeId: 'run', managed: true, status: 'working', tmux: { sessionId: '$1' } }] })");
  await f.run("previewOperation('close', { runtimeId: 'run' })");
  assert.equal(f.requests.length, 1); assert.match(textOf(f.nodes.get('operation-details')), /Root/); assert.match(textOf(f.nodes.get('operation-details')), /Child/); assert.match(textOf(f.nodes.get('operation-details')), /Other shell/);
  assert.match(f.nodes.get('operation-description').textContent, /停止其中的执行.*不会归档/);
  await f.run('confirmOperation()');
  assert.deepEqual(f.requests[1].body, { planId: 'close-plan' }); assert.equal(f.requests[1].url, '/api/runtimes/close');
  assert.equal(f.run('state.thread.archived'), undefined); assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.nodes.get('send').disabled, true);
  assert.match(f.nodes.get('operation-description').textContent, /对话保留/); assert.equal(f.requests.some(request => request.url.includes('/archive')), false);
});

test('blocked archive previews enumerate all children and never execute', async t => {
  const f = fixture(t, async () => response({ planId: null, threadId: 'root', affected: [{ id: 'root', name: 'Root', cwd: '/one' }, { id: 'child', name: '<script>Child</script>', cwd: '/one', parentThreadId: 'root' }], canArchive: false, blockedReasons: [{ code: 'external_writer', message: 'Close the external writer first' }] }));
  f.run('state.session.capabilities.archiveManagement = true'); await f.run("previewOperation('archive', { id: 'root' })");
  assert.match(textOf(f.nodes.get('operation-details')), /Root/); assert.match(textOf(f.nodes.get('operation-details')), /<script>Child<\/script>/); assert.match(textOf(f.nodes.get('operation-details')), /Close the external writer first/);
  assert.equal(f.nodes.get('operation-confirm').hidden, true); await f.run('confirmOperation()'); assert.equal(f.requests.length, 1);
});

test('archive partial receipts stay explicit per child and recheck never repeats the archive mutation', async t => {
  const f = fixture(t, async url => response(url.endsWith('/preview') ? { planId: 'plan', canArchive: true, affected: [{ id: 'root', name: 'Root' }, { id: 'child', name: 'Child' }], requiresConfirmation: true } : url.endsWith('/recheck') ? { operationId: 'op', threadId: 'root', status: 'complete', affected: [{ id: 'root', name: 'Root', status: 'alreadyArchived' }, { id: 'child', name: 'Child', status: 'archived' }] } : { operationId: 'op', threadId: 'root', status: 'partial', freezeRetained: true, affected: [{ id: 'root', name: 'Root', status: 'archived' }, { id: 'child', name: 'Child', status: 'unknown' }], reports: [{ phase: 'verify', status: 'partial' }] }));
  f.run("state.session.capabilities = { archiveManagement: true, library: true }; state.libraryThreads = [{ id: 'root' }, { id: 'child' }]");
  await f.run("previewOperation('archive', { id: 'root' })"); assert.equal(f.requests.length, 1); await f.run('confirmOperation()');
  assert.match(f.nodes.get('operation-description').textContent, /仅部分完成/); assert.match(textOf(f.nodes.get('operation-details')), /结果未知/); assert.match(f.nodes.get('operation-note').textContent, /暂不能加入/); assert.equal(f.nodes.get('operation-recheck').hidden, false);
  assert.equal(f.run('state.libraryThreads[0].archived'), true); assert.equal(f.run('state.libraryThreads[1].archived'), undefined);
  assert.equal(f.run("archiveFrozen({ id: 'child' })"), true);
  await f.run('recheckOperation()');
  assert.equal(f.requests.filter(request => request.url === '/api/library/archive').length, 1); assert.deepEqual(f.requests.at(-1).body, { operationId: 'op' });
  assert.equal(f.run('state.libraryThreads[1].archived'), true); assert.equal(f.run('state.session.pendingArchiveOperations.length'), 0);
  assert.equal(f.run("archiveFrozen({ id: 'child' })"), false);
});

test('changed archive scope requires a fresh preview and another explicit confirmation', async t => {
  let previews = 0;
  const f = fixture(t, async url => url.endsWith('/preview') ? response({ planId: `plan-${++previews}`, canArchive: true, affected: [{ id: 'root', name: 'Root' }] }) : response({ error: { code: 'archive_plan_changed', message: 'changed' } }, 409));
  await f.run("previewOperation('archive', { id: 'root' })"); await f.run('confirmOperation()');
  assert.equal(f.nodes.get('operation-confirm').hidden, true); assert.equal(f.nodes.get('operation-repreview').hidden, false); assert.match(f.nodes.get('operation-error').textContent, /影响范围已变化/);
  await f.run('confirmOperation()'); assert.equal(f.requests.length, 2);
  f.event('operation-repreview'); await flush(); assert.equal(previews, 2); assert.equal(f.requests.filter(request => request.url === '/api/library/archive').length, 1);
  assert.equal(f.nodes.get('operation-confirm').hidden, false);
});

test('session pending archive operations expose a read-only result check in the library', async t => {
  const f = fixture(t, async () => response({ operationId: 'previous-op', threadId: 'root', status: 'unknown', freezeRetained: true, affected: [{ id: 'root', name: 'Root', status: 'unknown' }] }));
  f.run("state.session.pendingArchiveOperations = [{ operationId: 'previous-op', threadId: 'root', status: 'unknown', freezeRetained: true }]; renderLibrary()");
  assert.match(textOf(f.nodes.get('library-pending')), /上次归档待核验/);
  f.nodes.get('library-pending').children[0].children[1].listeners.get('click')(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/library/archive/recheck'); assert.deepEqual(f.requests[0].body, { operationId: 'previous-op' });
  assert.equal(f.nodes.get('operation-confirm').hidden, true); assert.match(textOf(f.nodes.get('operation-details')), /结果未知/);
});

const deviceLocation = () => ({ origin: 'http://127.0.0.1:8443', port: '8443', pathname: '/', search: '', hash: '' });
const deviceSnapshot = (authenticated, token = 'a') => ({ authenticated, mode: 'mock', csrf: 'device-csrf', authTransport: 'bearer', sessionToken: token.repeat(43), upstreamStatus: 'connected', eventTransport: 'poll', eventCursor: 0, capabilities: { deviceAuthentication: true }, projects: [{ id: 'one', name: 'One', cwd: '/one' }], pendingApprovals: [], ...(authenticated ? { trustedDevice: { id: 'trusted-1', status: 'active', expiresAt: Date.now() + 90000000 } } : {}) });
const stubDeviceKeys = `deviceSupport = () => true; loadTrustedDevice = async () => ({ deviceId: 'trusted-1', publicKey: 'public-spki', privateKey: { extractable: false } }); signDeviceChallenge = async () => 'signed-challenge'`;

test('pairing fragment is removed immediately, kept for ten minutes and never enrolls without a user action', async t => {
  const location = deviceLocation(), replaced = []; location.hash = `#pair=${'p'.repeat(43)}`;
  const f = fixture(t, async () => response(deviceSnapshot(false)), { location, window: { addEventListener() {}, history: { replaceState(state, title, path) { replaced.push(path); location.hash = ''; } } } });
  assert.deepEqual(replaced, ['/']); assert.equal(location.hash, '');
  const saved = JSON.parse(f.storage.get('relay-device-pairing')); assert.equal(saved.token, 'p'.repeat(43)); assert.ok(saved.expiresAt > Date.now() && saved.expiresAt <= Date.now() + 600000);
  f.run('deviceSupport = () => true; loadTrustedDevice = async () => null'); await f.run('hydrateSession()');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/session'); assert.equal(f.nodes.get('trust-browser').hidden, false); assert.equal(f.nodes.get('recovery-login').hidden, true);
  f.run('state.pairing.expiresAt = Date.now() - 1; renderDeviceAuth()'); assert.equal(f.nodes.get('trust-browser').hidden, true); assert.equal(f.storage.has('relay-device-pairing'), false);
});

test('enrollment persists a nonexportable key before registration and the preallocated device id before verify', async t => {
  const log = [], location = deviceLocation(); location.hash = `#pair=${'p'.repeat(43)}`;
  const f = fixture(t, async url => { log.push(url); if (url === '/api/session') return response(deviceSnapshot(false)); if (url === '/api/device/challenge') { assert.equal(f.run('savedDevice.privateKey.extractable'), false); assert.equal(f.run('savedDevice.deviceId'), null); } else { assert.equal(f.run('savedDevice.deviceId'), 'trusted-1'); assert.equal(f.run('savedDevice.pending'), true); } return response(url === '/api/device/challenge' ? { challengeId: 'challenge-1', message: JSON.stringify({ deviceId: 'trusted-1' }) } : deviceSnapshot(true, 'b')); }, { location, window: { addEventListener() {}, history: { replaceState() { location.hash = ''; } } } });
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(false))}; deviceSupport = () => true; var savedDevice = null; var deviceWrites = []; generateDeviceKey = async () => ({ deviceId: null, publicKey: 'public-spki', privateKey: { extractable: false } }); saveTrustedDevice = async record => { savedDevice = { ...record }; deviceWrites.push({ id: record.deviceId, pending: record.pending }); }; loadTrustedDevice = async () => savedDevice; signDeviceChallenge = async () => 'signed-challenge'; hydrate = async () => setAuthenticated(state.session.authenticated)`);
  await f.run('enrollTrustedDevice()');
  assert.deepEqual(f.requests[1].body, { publicKey: 'public-spki', label: '我的手机浏览器', pairingToken: 'p'.repeat(43) });
  assert.deepEqual(f.requests[2].body, { challengeId: 'challenge-1', signature: 'signed-challenge' });
  assert.equal(f.run('deviceWrites[0].id'), null); assert.equal(f.run('deviceWrites[1].id'), 'trusted-1'); assert.equal(f.run('deviceWrites[1].pending'), true); assert.equal(f.run('savedDevice.pending'), false);
  assert.equal(f.run('savedDevice.privateKey.extractable'), false); assert.equal(f.run('state.session.authenticated'), true); assert.equal(f.storage.get('relay-session-token'), 'b'.repeat(43)); assert.equal(f.storage.has('relay-device-pairing'), false);
  assert.equal(f.nodes.get('revoke-device').hidden, false); assert.equal(f.nodes.get('trust-browser-sidebar').hidden, true);
  assert.deepEqual(log, ['/api/session', '/api/device/challenge', '/api/device/verify']);
});

test('failed browser-key persistence prevents registration after checking the local session', async t => {
  const f = fixture(t, () => response(deviceSnapshot(true)), { location: deviceLocation() }); f.run("state.session.capabilities.deviceAuthentication = true; deviceSupport = () => true; generateDeviceKey = async () => ({ publicKey: 'key', privateKey: { extractable: false } }); saveTrustedDevice = async () => { throw Error('storage unavailable'); }");
  await f.run('enrollTrustedDevice()'); assert.deepEqual(f.requests.map(request => request.url), ['/api/session']); assert.match(f.nodes.get('trusted-device-info').textContent, /storage unavailable/);
});

test('recovery submit bootstraps a fresh bearer and CSRF before login without replaying tasks', async t => {
  const fresh = { ...deviceSnapshot(false, 'b'), csrf: 'fresh-csrf' };
  const f = fixture(t, (url, options) => {
    if (url === '/api/session') return response(fresh);
    assert.equal(url, '/api/login'); assert.equal(options.headers.Authorization, `Bearer ${'b'.repeat(43)}`); assert.equal(options.headers['X-CSRF-Token'], 'fresh-csrf');
    assert.equal(JSON.parse(options.body).secret, 'local-test-password'); return response(deviceSnapshot(true, 'c'));
  }, { location: deviceLocation() });
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(false))}; rememberToken('a'.repeat(43)); state.deviceStatus = 'old error'; state.deviceError = true; $('secret').value = 'local-test-password'`);
  // Keep the final refresh local so this test observes only the explicit login sequence.
  f.run('hydrate = async () => { state.session.authenticated = true; }');
  f.event('login-form', 'submit'); await flush();
  assert.deepEqual(f.requests.map(request => request.url), ['/api/session', '/api/login']);
  assert.equal(f.storage.get('relay-session-token'), 'c'.repeat(43)); assert.equal(f.nodes.get('secret').value, '');
  assert.equal(f.run('state.deviceError'), false); assert.equal(f.nodes.get('error').hidden, true);
});

test('a used pairing clears its invitation and still allows password recovery without a reload', async t => {
  const location = deviceLocation(); location.hash = `#pair=${'p'.repeat(43)}`;
  const f = fixture(t, url => response(url === '/api/session' ? deviceSnapshot(false) : url === '/api/device/challenge' ? { error: { code: 'device_pairing_invalid', message: 'used invitation' } } : deviceSnapshot(true, 'b'), url === '/api/device/challenge' ? 401 : 200), { location, window: { addEventListener() {}, history: { replaceState() { location.hash = ''; } } } });
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(false))}; deviceSupport = () => true; var savedDevice; generateDeviceKey = async () => ({ publicKey: 'public-spki', privateKey: { extractable: false } }); saveTrustedDevice = async record => { savedDevice = record; }; loadTrustedDevice = async () => savedDevice; hydrate = async () => { state.session.authenticated = true; }`);
  await f.run('enrollTrustedDevice()');
  assert.equal(f.storage.get('relay-session-token'), 'a'.repeat(43)); assert.equal(f.run('pairingToken()'), null);
  assert.equal(f.nodes.get('trust-browser').hidden, true); assert.match(f.nodes.get('device-login-status').textContent, /已过期或已使用/);
  assert.doesNotMatch(f.nodes.get('device-login-status').textContent, /本地保存/);
  f.run("$('secret').value = 'local-test-password'"); f.event('login-form', 'submit'); await flush();
  assert.equal(f.storage.get('relay-session-token'), 'b'.repeat(43)); assert.equal(f.run('state.session.authenticated'), true);
  assert.equal(f.requests.some(request => request.url === '/api/turns' || request.url === '/api/threads'), false);
});

test('a stale authenticated page cannot replace its saved key after the server session expires', async t => {
  const f = fixture(t, () => response(deviceSnapshot(false)), { location: deviceLocation() });
  f.run("state.session.capabilities.deviceAuthentication = true; var generatedKeys = 0; generateDeviceKey = async () => { generatedKeys++; }; deviceSupport = () => true; setAuthenticated(true)");
  assert.equal(f.nodes.get('login').hidden, true);
  await f.run('enrollTrustedDevice()');
  assert.equal(f.run('generatedKeys'), 0); assert.deepEqual(f.requests.map(request => request.url), ['/api/session']);
  assert.match(f.nodes.get('device-login-status').textContent, /登录已过期/);
  assert.equal(f.nodes.get('login').hidden, false); assert.equal(f.nodes.get('home-view').hidden, true);
});

test('a delayed 401 from an older bearer cannot clear a newer authenticated bearer', async t => {
  const pending = deferred(); const f = fixture(t, () => pending.promise, { location: deviceLocation() });
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(true))}; rememberToken('a'.repeat(43))`);
  const request = f.run("api('/api/poll?wait=0')");
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(true, 'b'))}; rememberToken('b'.repeat(43))`);
  pending.resolve(response({ error: { code: 'session_required', message: 'old session expired' } }, 401));
  await assert.rejects(request);
  assert.equal(f.storage.get('relay-session-token'), 'b'.repeat(43)); assert.equal(f.run('state.session.authenticated'), true);
  assert.equal(f.run('state.deviceRecoveryTimer'), null);
});

test('trusted-browser hydration rotates only the ephemeral bearer and reads history without resubmitting a task', async t => {
  let authenticated = false;
  const f = fixture(t, async url => { if (url === '/api/session') return response(deviceSnapshot(authenticated, authenticated ? 'b' : 'a')); if (url === '/api/device/challenge') return response({ challengeId: 'login-1', message: 'challenge' }); if (url === '/api/device/verify') { authenticated = true; return response(deviceSnapshot(true, 'b')); } return response({ data: [], nextCursor: null }); }, { location: deviceLocation() });
  f.run(`${stubDeviceKeys}; $('prompt').value = 'keep this unsent task'`); await f.run('hydrateSession(true)');
  assert.equal(f.run('state.session.authenticated'), true); assert.equal(f.requests.filter(request => request.url === '/api/device/challenge').length, 1); assert.deepEqual(f.requests.find(request => request.url === '/api/device/challenge').body, { deviceId: 'trusted-1' });
  assert.equal(f.storage.get('relay-session-token'), 'b'.repeat(43)); assert.equal(f.nodes.get('prompt').value, 'keep this unsent task');
  assert.equal(f.requests.some(request => request.url === '/api/turns' || request.url === '/api/threads'), false);
});

test('failed automatic authentication is attempted once until an explicit retry', async t => {
  const f = fixture(t, async url => response(url === '/api/session' ? deviceSnapshot(false) : { error: { message: 'device revoked' } }, url === '/api/device/challenge' ? 401 : 200), { location: deviceLocation() });
  f.run(stubDeviceKeys); await f.run('hydrateSession()'); await f.run('hydrateSession()');
  assert.equal(f.requests.filter(request => request.url === '/api/device/challenge').length, 1); assert.equal(f.run('state.deviceRecoveryTimer'), null); assert.match(f.nodes.get('device-login-status').textContent, /device revoked/);
  assert.equal(f.nodes.get('recovery-login').hidden, true); f.event('show-recovery'); assert.equal(f.nodes.get('recovery-login').hidden, false);
});

test('poll 401 schedules one authentication hydrate and never replays a turn', async t => {
  const f = fixture(t, async () => response({ error: { message: 'expired' } }, 401), { location: deviceLocation() });
  f.run("state.session.capabilities.deviceAuthentication = true; state.session.authTransport = 'bearer'; state.transportEpoch = 5; rememberToken('a'.repeat(43)); var recoveryCount = 0; hydrate = async () => { recoveryCount++; }");
  await f.run('pollEvents(5)'); const timer = f.run('state.deviceRecoveryTimer'); assert.ok(timer !== null); assert.equal(f.storage.has('relay-session-token'), false);
  f.run('scheduleDeviceRecovery()'); assert.equal(f.run('state.deviceRecoveryTimer'), timer); f.timers.get(timer).fn(); await flush();
  assert.equal(f.run('recoveryCount'), 1); assert.equal(f.requests.length, 1); assert.match(f.requests[0].url, /^\/api\/poll\?/);
});

test('revocation clears the browser credential and bearer before unauthenticated hydration without automatic re-enrollment', async t => {
  const order = [];
  const f = fixture(t, async (url, options) => { if (url === '/api/session') { assert.deepEqual(order, ['revoke', 'clear']); assert.equal(options.headers.Authorization, undefined); return response(deviceSnapshot(false)); } order.push('revoke'); return response({}); }, { location: deviceLocation(), markCredentialCleared: () => order.push('clear') });
  f.run(`state.session = ${JSON.stringify(deviceSnapshot(true, 'b'))}; state.deviceRecord = { deviceId: 'trusted-1' }; rememberToken('b'.repeat(43)); clearTrustedDevice = async () => { markCredentialCleared(); }`);
  await f.run('revokeTrustedDevice()');
  assert.deepEqual(f.requests[0].body, { deviceId: 'trusted-1' }); assert.equal(f.requests[0].url, '/api/devices/revoke'); assert.equal(f.run('state.deviceSuppressed'), true); assert.equal(f.run('state.session.authenticated'), false);
  assert.equal(f.requests.some(request => request.url === '/api/device/challenge' || request.url === '/api/device/verify'), false); assert.match(f.nodes.get('device-login-status').textContent, /取消信任并退出/);
});

test('unsupported crypto or storage keeps ordinary password entry folded until recovery is explicitly selected', async t => {
  const f = fixture(t); f.run('state.session.capabilities.deviceAuthentication = true; setAuthenticated(false)');
  assert.equal(f.nodes.get('recovery-login').hidden, true); assert.match(f.nodes.get('device-login-status').textContent, /不支持 WebCrypto/); assert.equal(f.nodes.get('trust-browser-sidebar').disabled, true);
  await f.run('authenticateTrustedDevice()'); assert.equal(f.requests.length, 0); f.event('show-recovery'); assert.equal(f.nodes.get('recovery-login').hidden, false);
});

test('P-256 signing uses a nonexportable key and rejects challenges for another origin, key, purpose or device', async t => {
  const f = fixture(t, undefined, { location: deviceLocation(), crypto: webcrypto, indexedDB: {}, TextEncoder, btoa, atob });
  const record = await f.run('var testDeviceRecord; generateDeviceKey().then(record => { record.deviceId = "trusted-1"; testDeviceRecord = record; return record; })');
  assert.equal(record.privateKey.extractable, false); await assert.rejects(webcrypto.subtle.exportKey('pkcs8', record.privateKey));
  const spki = Buffer.from(record.publicKey, 'base64url'), keyHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', spki)).toString('hex');
  const message = { version: 1, purpose: 'device-login', challengeId: 'challenge-1', origin: deviceLocation().origin, keyHash, deviceId: 'trusted-1', expiresAt: Date.now() + 60000 };
  const challenge = { challengeId: 'challenge-1', message: JSON.stringify(message) };
  const signature = await f.run(`signDeviceChallenge(testDeviceRecord, ${JSON.stringify(challenge)}, 'device-login')`); assert.equal(Buffer.from(signature, 'base64url').length, 64);
  const publicKey = await webcrypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(signature, 'base64url'), new TextEncoder().encode(challenge.message)), true);
  for (const mutation of [{ origin: 'http://127.0.0.1:8444' }, { keyHash: '0'.repeat(64) }, { purpose: 'device-enroll' }, { deviceId: 'another-device' }, { challengeId: 'another-challenge' }]) await assert.rejects(f.run(`signDeviceChallenge(testDeviceRecord, ${JSON.stringify({ ...challenge, message: JSON.stringify({ ...message, ...mutation }) })}, 'device-login')`));
});


function enableCatalog(f) {
  f.run("state.session.capabilities = { chatCatalog: true, library: true, runtimeManagement: true, allThreads: true, projectManagement: true, workspaceBrowser: true, archiveManagement: true }; state.session.projects = [{ id: 'one', name: 'Research', defaultCwd: '/research', revision: 'r1' }, { id: 'two', name: 'Ideas', defaultCwd: null, revision: 'r2' }]; state.session.workspace = { defaultCwd: '/workspace' }; state.projectId = null; renderProjects()");
}

test('catalog new chat needs no project and creates only on first message with its separate cwd', async t => {
  const f = fixture(t, async url => response(url === '/api/threads' ? { thread: { id: 'new-chat', cwd: '/workspace', projectId: null, turns: [], runtimes: [{ runtimeId: 'run-new', managed: true, status: 'idle' }] } } : url === '/api/turns' ? { turn: { id: 'turn', status: 'completed' } } : { data: [], nextCursor: null }));
  enableCatalog(f); await f.run('openNewThread()');
  assert.equal(f.requests.length, 0); assert.equal(f.run('state.thread'), null); assert.equal(f.run('state.projectId'), null); assert.equal(f.nodes.get('draft-cwd').value, '/workspace'); assert.equal(f.nodes.get('prompt').disabled, false);
  f.run("$('prompt').value = 'start here'; controls()"); f.event('composer', 'submit'); await flush();
  assert.deepEqual(f.requests.find(request => request.url === '/api/threads').body, { cwd: '/workspace', projectId: null });
  assert.deepEqual(f.requests.find(request => request.url === '/api/turns').body, { threadId: 'new-chat', text: 'start here', submissionId: 'ui-submission' });
  assert.equal(f.run('state.thread.id'), 'new-chat'); assert.equal(f.requests.some(request => request.url === '/api/projects' || request.url.startsWith('/api/directories')), false);
});

test('catalog selected project supplies an optional draft default without changing that project when cwd is edited', async t => {
  const f = fixture(t); enableCatalog(f); await f.run("openNewThread('one')");
  assert.equal(f.nodes.get('draft-cwd').value, '/research');
  f.nodes.get('draft-cwd').value = '/scratch'; f.event('draft-cwd', 'input');
  assert.equal(f.run('state.draftCwd'), '/scratch'); assert.equal(f.run('state.session.projects[0].defaultCwd'), '/research');
  f.nodes.get('project').value = 'two'; f.event('project', 'change'); await flush();
  assert.equal(f.run('state.projectId'), 'two'); assert.equal(f.nodes.get('draft-cwd').value, '/workspace'); assert.equal(f.requests.length, 0);
});

test('catalog project creates with a name and optional folder, retains idempotency on uncertain retry, and never creates a chat', async t => {
  let attempts = 0;
  const f = fixture(t, async url => url === '/api/projects' && ++attempts === 1 ? response({ error: { message: 'temporary failure' } }, 503) : response(url === '/api/projects' ? { project: { id: 'new-project', name: 'New group', defaultCwd: null, revision: 'native-r1' } } : { data: [], nextCursor: null }));
  enableCatalog(f); await f.run('openProjectEditor()'); assert.equal(f.requests.length, 0);
  f.nodes.get('project-name').value = 'New group'; await f.run('saveProject()');
  assert.equal(f.run('state.view'), 'directory'); assert.equal(f.nodes.get('project-name').value, 'New group');
  await f.run('saveProject()');
  const writes = f.requests.filter(request => request.url === '/api/projects');
  assert.deepEqual(writes[0].body, { name: 'New group', defaultCwd: null, idempotencyKey: 'ui-submission' }); assert.deepEqual(writes[1].body, writes[0].body);
  assert.equal(f.requests.some(request => request.url === '/api/threads' || request.url === '/api/turns' || request.url.startsWith('/api/directories')), false);
});

test('catalog renaming and moving a chat preserves its id, cwd, history and active runtime', async t => {
  const moved = { id: 'original', name: 'Renamed', projectId: 'two', cwd: '/original-cwd', pinned: false, turns: [{ id: 'history', items: [] }], runtimes: [{ runtimeId: 'same-run', managed: true, status: 'idle' }] };
  const f = fixture(t, async () => response({ thread: moved })); enableCatalog(f);
  f.run("renderThread({ id: 'original', name: 'Old', cwd: '/original-cwd', projectId: 'one', turns: [{ id: 'history', items: [] }], runtimes: [{ runtimeId: 'same-run', managed: true, status: 'idle' }] }); openThreadSettings(state.thread)");
  f.nodes.get('thread-name').value = 'Renamed'; f.nodes.get('thread-project').value = 'two'; await f.run('saveThreadSettings()');
  assert.deepEqual(f.requests[0].body, { threadId: 'original', name: 'Renamed', projectId: 'two' }); assert.equal(f.requests.length, 1);
  assert.equal(f.run('state.thread.id'), 'original'); assert.equal(f.run('state.thread.cwd'), '/original-cwd'); assert.equal(f.run('state.thread.turns[0].id'), 'history'); assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'same-run'); assert.equal(f.run('state.threadProjectId'), 'two');
});

test('catalog updates a project default without moving the viewed chat or changing its cwd', async t => {
  const f = fixture(t, async url => response(url === '/api/projects/update' ? { project: { id: 'one', name: 'Research renamed', defaultCwd: '/future', revision: 'r2' } } : { data: [], nextCursor: null })); enableCatalog(f);
  f.run("renderThread({ id: 'original', cwd: '/old-cwd', projectId: 'one', turns: [] }); state.projectId = 'one'"); await f.run('openProjectEditor(true)');
  f.nodes.get('project-name').value = 'Research renamed'; f.nodes.get('directory-path').value = '/future'; f.event('directory-path', 'input'); await f.run('saveProject()');
  assert.deepEqual(f.requests.find(request => request.url === '/api/projects/update').body, { projectId: 'one', name: 'Research renamed', defaultCwd: '/future', revision: 'r1' }); assert.equal(f.run('state.thread.cwd'), '/old-cwd'); assert.equal(f.run('state.thread.projectId'), 'one');
  await f.run("openNewThread('one')"); assert.equal(f.nodes.get('draft-cwd').value, '/future');
});

test('catalog stopped chat is readable and sending resumes the original id without a manual join', async t => {
  const f = fixture(t, async () => response({ thread: { id: 'stopped', cwd: '/original', projectId: null, runtimes: [{ runtimeId: 'resumed-run', managed: true, status: 'working' }] }, turn: { id: 'new-turn', status: 'inProgress' } })); enableCatalog(f);
  f.run("renderThread({ id: 'stopped', cwd: '/original', projectId: null, runtimes: [], turns: [{ id: 'old', items: [{ id: 'old-message', type: 'agentMessage', text: 'saved history' }] }] }); $('prompt').value = 'continue'; controls()");
  assert.equal(f.nodes.get('prompt').disabled, false); assert.equal(f.nodes.get('send').disabled, false); assert.match(f.nodes.get('run-state-text').textContent, /发送消息会恢复原对话/);
  f.event('composer', 'submit'); await flush();
  assert.deepEqual(f.requests[0].body, { threadId: 'stopped', text: 'continue', submissionId: 'ui-submission' }); assert.equal(f.requests.length, 1); assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'resumed-run'); assert.equal(f.run("state.items.get('old-message').body.textContent"), 'saved history');
});

test('catalog external run stays read-only and safe stop still requires an explicit preview and confirmation', async t => {
  const f = fixture(t, async url => response(url.endsWith('/preview') ? { planId: 'stop-external', scope: 'process', affectedThreads: [{ id: 'external', name: 'External' }] } : { status: 'closed', affected: [{ runtimeId: 'external-run', status: 'closed' }] })); enableCatalog(f);
  f.run("renderThread({ id: 'external', cwd: '/original', readOnly: true, runtimes: [{ runtimeId: 'external-run', managed: false, status: 'working' }], turns: [] }); $('prompt').value = 'do not send'; controls()");
  assert.equal(f.nodes.get('send').disabled, true); assert.equal(f.nodes.get('join-thread').textContent, '安全停止外部运行');
  await f.run('joinThread()'); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/api/runtimes/close/preview'); assert.match(f.nodes.get('operation-description').textContent, /外部 Codex 进程/);
  assert.equal(f.requests.some(request => request.url === '/api/turns'), false); await f.run('confirmOperation()');
  assert.equal(f.requests[1].url, '/api/runtimes/close'); assert.equal(f.run('state.thread.readOnly'), false); assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.nodes.get('send').disabled, false);
});

test('catalog title search queries the native library and does not replace recent sidebar chats', async t => {
  const f = fixture(t, async () => response({ data: [{ id: 'older-hit', name: 'Unique title', cwd: '/old', projectId: null, runtimes: [] }], nextCursor: 'opaque-next' })); enableCatalog(f);
  f.run("state.recentThreads = [{ id: 'recent', name: 'Recent', cwd: '/recent', projectId: null, runtimes: [] }]; renderSidebar(); $('sidebar-search').value = 'Unique title'");
  f.event('sidebar-search-form', 'submit'); await flush();
  assert.equal(f.requests[0].url, '/api/threads?project=all&archived=false&search=Unique%20title'); assert.equal(f.run('state.libraryThreads[0].id'), 'older-hit'); assert.equal(f.run('state.recentThreads[0].id'), 'recent'); assert.equal(f.run('state.cursor'), 'opaque-next'); assert.equal(f.nodes.get('library-older').hidden, false);
  assert.match(textOf(f.nodes.get('threads')), /Recent/); assert.doesNotMatch(textOf(f.nodes.get('threads')), /older-hit/);
});

test('catalog reads pinned chats beyond the recent page and project selection only changes the library view', async t => {
  const f = fixture(t, async url => response(url.includes('pinned=true') ? { data: [{ id: 'older-pin', name: 'Older pinned', pinned: true, projectId: 'one', runtimes: [] }], nextCursor: null } : { data: [{ id: 'recent', name: 'Recent', projectId: null, runtimes: [] }], nextCursor: 'recent-next' })); enableCatalog(f);
  await f.run('history()'); assert.equal(f.requests.some(request => request.url === '/api/threads?project=all&archived=false&pinned=true'), true); assert.match(textOf(f.nodes.get('pinned-threads')), /Older pinned/);
  f.run("renderThread({ id: 'viewed', cwd: '/fixed', projectId: null, runtimes: [], turns: [] }); openProjectLibrary('one')"); await flush();
  assert.equal(f.run('state.thread.id'), 'viewed'); assert.equal(f.run('state.thread.cwd'), '/fixed'); assert.equal(f.run('state.projectId'), null); assert.equal(f.run('state.libraryProjectId'), 'one'); assert.match(f.requests.find(request => request.url.includes('project=one')).url, /project=one&archived=false/);
});

test('catalog keep-running policy is per-chat and a failed save restores the confirmed checkbox', async t => {
  let fail = false;
  const f = fixture(t, async () => fail ? response({ error: { message: 'not saved' } }, 503) : response({ threadId: 'policy-chat', keepRunning: true })); enableCatalog(f);
  f.run("renderThread({ id: 'policy-chat', cwd: '/policy', keepRunning: false, projectId: null, runtimes: [{ runtimeId: 'run', managed: true, status: 'idle' }], turns: [] })");
  assert.match(f.nodes.get('idle-policy').textContent, /2 小时/); await f.run('setKeepRunning(state.thread, true)');
  assert.deepEqual(f.requests[0].body, { threadId: 'policy-chat', keepRunning: true }); assert.equal(f.nodes.get('keep-running').checked, true); assert.match(f.nodes.get('idle-policy').textContent, /已暂停/);
  fail = true; f.nodes.get('keep-running').checked = false; f.event('keep-running', 'change'); await flush();
  assert.equal(f.run('state.thread.keepRunning'), true); assert.equal(f.nodes.get('keep-running').checked, true); assert.equal(f.nodes.get('keep-running').disabled, false);
});

test('catalog runtime overview includes Codex without tmux and retains honest unknown states and verified tmux ids', t => {
  const f = fixture(t); enableCatalog(f);
  f.run("renderOverview({ agents: [{ runtimeId: 'unknown', threadId: 'u', name: 'Unknown', managed: true, status: 'unknown', tmuxState: 'unknown' }, { runtimeId: 'external', threadId: 'e', name: 'External', managed: false, status: 'working', tmuxState: 'none' }, { runtimeId: 'managed', threadId: 'm', name: 'Managed', managed: true, status: 'idle', tmuxState: 'attached', tmux: { sessionName: 'dedicated', target: '$8:0.0' } }], metrics: {} })");
  const cards = f.nodes.get('agents').children;
  assert.deepEqual(cards.map(card => card.dataset.runtimeId), ['external', 'managed', 'unknown']); assert.match(textOf(cards[0]), /外部运行/); assert.match(textOf(cards[1]), /tmux \$8:0\.0/); assert.match(textOf(cards[2]), /状态未知/); assert.match(textOf(cards[2]), /无法确认 tmux/);
});


test('catalog archived chats offer history reading while metadata and keep-running editing stay unavailable', async t => {
  const f = fixture(t); enableCatalog(f);
  f.run("state.libraryThreads = [{ id: 'archived', name: 'Saved title', archived: true, projectId: 'one', cwd: '/saved', runtimes: [], turns: [] }]; state.archived = true; renderLibrary(); renderThread(state.libraryThreads[0])");
  const actions = f.nodes.get('library-list').children[0].children[1]; assert.equal(textOf(actions), '查看');
  assert.equal(f.nodes.get('chat-menu').hidden, true); assert.equal(f.nodes.get('chat-actions').hidden, true); assert.equal(f.nodes.get('chat-lifecycle').hidden, true);
  assert.equal(f.run('threadActions(state.thread).children.length'), 0);
  await f.run("updateThreadMetadata(state.thread, { name: 'Blocked', pinned: true, projectId: 'two' }); openThreadSettings(state.thread); setKeepRunning(state.thread, true)");
  assert.equal(f.requests.length, 0); assert.equal(f.run('state.threadEdit'), null); assert.equal(f.run('state.thread.name'), 'Saved title'); assert.equal(f.run('state.thread.projectId'), 'one');
});


function presenceRequests(f) { return f.requests.filter(request => request.url === '/api/runtime-presence'); }
function enablePresence(f) { enableCatalog(f); f.run("state.session.capabilities.runtimePresence = true; $('error').hidden = true"); }

test('visible chat presence renews every twenty seconds and cached threads on Home or Library do not stay connected', async t => {
  const f = fixture(t, async url => response(url === '/api/runtime-presence' ? { connected: true, leaseMs: 90000 } : { data: [], nextCursor: null })); enablePresence(f);
  f.run("renderThread({ id: 'viewed-chat', cwd: '/chat', projectId: null, runtimes: [], turns: [] })"); await f.run('runtimePresence.queue');
  assert.equal(presenceRequests(f).length, 1); const first = presenceRequests(f)[0].body; assert.equal(first.threadId, 'viewed-chat'); assert.match(first.clientId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal([...f.timers.values()].filter(timer => timer.ms === 20000).length, 1);
  const timer = f.run('runtimePresence.timer'); f.timers.get(timer).fn(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).length, 2); assert.deepEqual(presenceRequests(f)[1].body, first);
  f.run("showView('home')"); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).at(-1).body.threadId, null); assert.equal(f.run('state.thread.id'), 'viewed-chat'); assert.equal(f.run('runtimePresence.timer'), null);
  const count = presenceRequests(f).length; f.run("showView('library'); controls(); renderView()"); await flush(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).length, count);
  assert.equal(f.requests.some(request => request.url === '/api/threads' || request.url === '/api/turns'), false);
});

test('presence release and replacement registration stay ordered when switching chats during an in-flight release', async t => {
  const release = deferred(); let requests = 0;
  const f = fixture(t, async url => url === '/api/runtime-presence' && ++requests === 2 ? release.promise : response({ data: [], nextCursor: null })); enablePresence(f);
  f.run("renderThread({ id: 'chat-a', cwd: '/a', turns: [] })"); await f.run('runtimePresence.queue');
  f.run("showView('home')"); await flush(); assert.equal(presenceRequests(f).length, 2);
  f.run("renderThread({ id: 'chat-b', cwd: '/b', turns: [] })"); await flush(); assert.equal(presenceRequests(f).length, 2, 'replacement cannot overtake an older release');
  release.resolve(response({ threadId: null, connected: false, leaseMs: 90000 })); await f.run('runtimePresence.queue');
  assert.deepEqual(presenceRequests(f).map(request => request.body.threadId), ['chat-a', null, 'chat-b']); assert.equal(new Set(presenceRequests(f).map(request => request.body.clientId)).size, 1);
  f.run("renderThread({ id: 'chat-c', cwd: '/c', turns: [] }); showView('home'); renderThread({ id: 'chat-d', cwd: '/d', turns: [] })"); await f.run('runtimePresence.queue');
  assert.equal(presenceRequests(f).at(-1).body.threadId, 'chat-d'); assert.equal(presenceRequests(f).some(request => request.body.threadId === 'chat-c'), false);
});

test('hidden, pagehide and logout release presence with authenticated keepalive fetch and foreground restores only the viewed chat', async t => {
  const windowListeners = new Map();
  const f = fixture(t, async url => response(url === '/api/runtime-presence' ? { connected: true, leaseMs: 90000 } : {}), { location: deviceLocation(), window: { addEventListener(name, fn) { windowListeners.set(name, fn); } } }); enablePresence(f);
  f.run("state.session.authTransport = 'bearer'; rememberToken('a'.repeat(43)); hydrate = async () => controls(); renderThread({ id: 'phone-chat', cwd: '/phone', turns: [] })"); await f.run('runtimePresence.queue');
  f.document.visibilityState = 'hidden'; f.listeners.get('visibilitychange')(); await f.run('runtimePresence.queue');
  const hidden = presenceRequests(f).at(-1); assert.equal(hidden.body.threadId, null); assert.equal(hidden.options.keepalive, true); assert.equal(hidden.options.credentials, 'omit'); assert.equal(hidden.options.headers.Authorization, `Bearer ${'a'.repeat(43)}`); assert.equal(hidden.options.headers['X-CSRF-Token'], 'fixture-csrf'); assert.equal(hidden.options.headers['X-Relay-Origin'], deviceLocation().origin);
  f.document.visibilityState = 'visible'; f.listeners.get('visibilitychange')(); await flush(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).at(-1).body.threadId, 'phone-chat');
  windowListeners.get('pagehide')(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).at(-1).body.threadId, null); assert.equal(f.run('runtimePresence.timer'), null);
  windowListeners.get('pageshow')(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).at(-1).body.threadId, 'phone-chat');
  f.run('hydrate = async () => setAuthenticated(false)'); f.event('logout'); await flush(); await f.run('runtimePresence.queue'); await flush();
  const relevant = f.requests.filter(request => ['/api/runtime-presence', '/api/logout'].includes(request.url)); assert.equal(relevant.at(-2).body.threadId, null); assert.equal(relevant.at(-1).url, '/api/logout'); assert.equal(f.run('state.session.authenticated'), false); assert.equal(f.run('runtimePresence.timer'), null);
});

test('presence transient errors retry only on the twenty-second cadence while auth errors stop until recovery', async t => {
  let status = 503;
  const f = fixture(t, async () => response({}, status)); enablePresence(f);
  f.run("renderThread({ id: 'retry-chat', cwd: '/retry', turns: [] })"); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).length, 1); assert.equal(f.nodes.get('error').hidden, true);
  f.run('controls(); renderView(); controls()'); await flush(); assert.equal(presenceRequests(f).length, 1);
  assert.equal(f.timers.get(f.run('runtimePresence.timer')).ms, 20000); status = 200; f.timers.get(f.run('runtimePresence.timer')).fn(); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).length, 2); assert.equal(f.run('runtimePresence.failed'), false);
  status = 401; f.timers.get(f.run('runtimePresence.timer')).fn(); await f.run('runtimePresence.queue'); assert.equal(f.run('runtimePresence.timer'), null); const count = presenceRequests(f).length; f.run('controls(); renderView()'); await flush(); assert.equal(presenceRequests(f).length, count);
  status = 200; f.run("connection(false, 'offline')"); await f.run('runtimePresence.queue'); assert.equal(f.run('runtimePresence.timer'), null);
  f.run("connection(true, 'online')"); await f.run('runtimePresence.queue'); assert.equal(presenceRequests(f).at(-1).body.threadId, 'retry-chat'); assert.ok(f.run('runtimePresence.timer') !== null); assert.equal(f.nodes.get('error').hidden, true);
});

test('presence uses one random id per page lifecycle without session storage and starts only after a real chat exists', async t => {
  const fetcher = async url => response(url === '/api/threads' ? { thread: { id: 'created-chat', cwd: '/workspace', projectId: null, turns: [], runtimes: [] } } : { data: [], nextCursor: null });
  const first = fixture(t, fetcher, { crypto: { randomUUID: () => 'page-one' } }), second = fixture(t, fetcher, { crypto: { randomUUID: () => 'page-two' } }); enablePresence(first); enablePresence(second);
  await first.run('openNewThread()'); await first.run('runtimePresence.queue'); assert.equal(presenceRequests(first).length, 0);
  await first.run('createThread()'); await first.run('runtimePresence.queue'); assert.equal(presenceRequests(first)[0].body.threadId, 'created-chat'); assert.equal(presenceRequests(first)[0].body.clientId, 'page-one');
  second.run("renderThread({ id: 'created-chat', cwd: '/chat', turns: [] })"); await second.run('runtimePresence.queue'); assert.equal(presenceRequests(second)[0].body.clientId, 'page-two');
  assert.equal([...first.storage.values(), ...second.storage.values()].some(value => String(value).includes('page-one') || String(value).includes('page-two')), false);
});


function seedClosingChat(f, { runtimeId = 'run-old', turnId = 'turn-old', pinned = true } = {}) {
  f.run(`var closingThread = { id: 'closing-chat', name: 'Closing chat', cwd: '/closing', projectId: null, pinned: ${pinned}, status: 'active', runtimes: [{ runtimeId: '${runtimeId}', managed: true, status: 'working' }], turns: [{ id: '${turnId}', status: 'inProgress', items: [{ id: 'saved-answer', type: 'agentMessage', text: 'History remains' }] }] }; state.libraryThreads = [JSON.parse(JSON.stringify(closingThread))]; state.recentThreads = [JSON.parse(JSON.stringify(closingThread))]; state.pinnedThreads = ${pinned} ? [JSON.parse(JSON.stringify(closingThread))] : []; renderThread(closingThread); $('prompt').value = 'continue later'; controls()`);
}

test('runtime identity closure clears expired approvals and all matching caches while preserving readable history', t => {
  const f = fixture(t); enableCatalog(f); seedClosingChat(f);
  f.run("state.approvals.set('run-old:approval', { id: 'run-old:approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'closing-chat', turnId: 'turn-old', itemId: 'command' } }); state.session.pendingApprovals = [...state.approvals.values()]; renderApprovals(); state.chatActionsOpen = true; renderChatActions(); handleEvent('relay', { status: 'runtime-closed', runtimeId: 'run-old', threadId: 'closing-chat' }, 100)");
  for (const list of ['libraryThreads', 'recentThreads', 'pinnedThreads']) { assert.equal(f.run(`state.${list}[0].runtimes.length`), 0); assert.equal(f.run(`threadStatus(state.${list}[0])`), '已停止'); }
  assert.equal(f.run('state.busy'), false); assert.equal(f.run('state.turnId'), null); assert.equal(f.run('state.approvals.size'), 0); assert.equal(f.run('state.session.pendingApprovals.length'), 0); assert.equal(f.nodes.get('approvals').hidden, true); assert.equal(f.run('state.activityPhase'), 'closed'); assert.equal(f.run('state.activitySince'), null); assert.equal(f.run('state.activityTimer'), null); assert.equal(f.nodes.get('run-state').dataset.active, 'false');
  assert.equal(f.nodes.get('send').disabled, false); assert.equal(f.run("state.items.get('saved-answer').body.textContent"), 'History remains'); assert.equal(f.run('state.thread.turns[0].status'), 'inProgress', 'stored historical status is not rewritten'); assert.doesNotMatch(textOf(f.nodes.get('chat-actions')), /停止运行/); assert.match(textOf(f.nodes.get('pinned-threads')), /已停止/); assert.equal(f.requests.length, 0);
});

test('late closure of an old runtime cannot clear the replacement turn, runtime or approvals', t => {
  const f = fixture(t); enableCatalog(f); seedClosingChat(f, { runtimeId: 'run-new', turnId: 'turn-new' });
  f.run("state.recentThreads[0].runtimes = [{ runtimeId: 'run-old', managed: true, status: 'working' }]; state.approvals.set('run-old:approval', { id: 'run-old:approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'closing-chat', turnId: 'turn-old', itemId: 'old' } }); state.approvals.set('run-new:approval', { id: 'run-new:approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'closing-chat', turnId: 'turn-new', itemId: 'new' } }); renderApprovals(); handleEvent('relay', { status: 'runtime-closed', runtimeId: 'run-old', threadId: 'closing-chat', superseded: true }, 101)");
  assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'run-new'); assert.equal(f.run('state.busy'), true); assert.equal(f.run('state.turnId'), 'turn-new'); assert.equal(f.nodes.get('send').disabled, true); assert.equal(f.run("state.approvals.has('run-new:approval')"), true); assert.equal(f.run("state.approvals.has('run-old:approval')"), false); assert.equal(f.run('state.activityPhase'), 'approval');
  assert.equal(f.run('state.recentThreads[0].runtimes[0].runtimeId'), 'run-new'); assert.equal(f.requests.length, 0);
});

test('superseded closure with no replacement snapshot reads state instead of unlocking a possibly new active turn', async t => {
  const f = fixture(t); enableCatalog(f); seedClosingChat(f);
  // Keep the authoritative refresh pending while checking the synchronous closure state.
  f.run('var replacementReads = 0; var releaseReplacement; var replacementReady = new Promise(resolve => { releaseReplacement = resolve; }); hydrate = async () => { replacementReads++; await replacementReady; }');
  f.run("handleEvent('relay', { status: 'runtime-closed', runtimeId: 'run-old', threadId: 'closing-chat', superseded: true }, 102)"); await flush();
  assert.equal(f.run('replacementReads'), 1); assert.equal(f.run('state.busy'), true); assert.equal(f.run('state.turnId'), 'turn-old'); assert.equal(f.nodes.get('send').disabled, true); assert.notEqual(f.run('state.activityPhase'), 'closed'); assert.equal(f.requests.length, 0);
  f.run('releaseReplacement()'); await f.run('replacementReady');
});

test('runtime-cleaned applies per-runtime closure immediately on Home and repeated receipts are idempotent', t => {
  const f = fixture(t); enableCatalog(f); seedClosingChat(f);
  f.run("var overviewRefreshes = 0; refreshOverview = async () => { overviewRefreshes++; }; state.view = 'home'; renderOverview({ agents: [{ runtimeId: 'run-old', threadId: 'closing-chat', name: 'Closed', managed: true, status: 'working' }, { runtimeId: 'other-run', threadId: 'other-chat', name: 'Other still running', managed: true, status: 'working' }], metrics: {} }); handleEvent('relay', { status: 'runtime-cleaned', closedRuntimes: [{ runtimeId: 'run-old', threadId: 'closing-chat' }], message: 'Reaped' }, 103)");
  assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.run('state.busy'), false); assert.equal(f.run('overviewRefreshes'), 1); assert.equal(f.run('state.overview.agents.length'), 1); assert.equal(f.run('state.overview.agents[0].runtimeId'), 'other-run'); assert.doesNotMatch(textOf(f.nodes.get('agents')), /Closed/); assert.match(textOf(f.nodes.get('agents')), /Other still running/);
  f.run("handleEvent('relay', { status: 'runtime-cleaned', closedRuntimes: [{ runtimeId: 'run-old', threadId: 'closing-chat' }] }, 104)"); assert.equal(f.run('overviewRefreshes'), 1); assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.run('state.overview.agents[0].runtimeId'), 'other-run'); assert.equal(f.requests.length, 0);
});

test('legacy closure without a runtime id reads authoritative snapshots without clearing a replacement blindly or starting a runtime', async t => {
  const pending = deferred();
  const snapshot = { authenticated: true, mode: 'mock', csrf: 'fixture-csrf', upstreamStatus: 'connected', eventCursor: 105, projects: [], pendingApprovals: [], capabilities: { chatCatalog: true, runtimeManagement: true, library: true, allThreads: true } };
  const f = fixture(t, async url => url === '/api/session' ? response(snapshot) : url === '/api/resume' ? pending.promise : response({ data: [], nextCursor: null })); enableCatalog(f); seedClosingChat(f); f.run('subscribe = () => {}');
  f.run("handleEvent('relay', { status: 'runtime-closed', threadId: 'closing-chat' }, 105)"); await flush();
  assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'run-old'); assert.equal(f.run('state.busy'), true);
  pending.resolve(response({ thread: { id: 'closing-chat', name: 'Replacement', cwd: '/closing', projectId: null, status: 'active', runtimes: [{ runtimeId: 'run-new', managed: true, status: 'working' }], turns: [{ id: 'turn-new', status: 'inProgress', items: [] }] }, eventCursor: 106 })); await f.run('state.hydrating');
  assert.equal(f.run('state.thread.runtimes[0].runtimeId'), 'run-new'); assert.equal(f.run('state.busy'), true); assert.equal(f.run('state.turnId'), 'turn-new'); assert.equal(f.requests.filter(request => request.body !== undefined).every(request => request.url === '/api/resume'), true); assert.equal(f.requests.some(request => request.url === '/api/turns' || request.url === '/api/threads' || request.url === '/api/runtimes/join'), false);
});

test('a closure invalidates an older in-flight Home overview so it cannot restore a dead runtime card', async t => {
  const pending = deferred(); let reads = 0;
  const f = fixture(t, async url => { assert.equal(url, '/api/overview'); return ++reads === 1 ? pending.promise : response({ agents: [], metrics: {} }); }); enableCatalog(f); f.run("state.session.capabilities.overview = true; state.view = 'home'");
  const old = f.run('refreshOverview()'); f.run("handleEvent('relay', { status: 'runtime-closed', runtimeId: 'run-dead', threadId: 'dead-chat' }, 107)"); await flush(); assert.equal(reads, 2);
  pending.resolve(response({ agents: [{ runtimeId: 'run-dead', threadId: 'dead-chat', name: 'Dead runtime', managed: true, status: 'working' }], metrics: {} })); await old;
  assert.equal(f.run('state.overview.agents.length'), 0); assert.doesNotMatch(textOf(f.nodes.get('agents')), /Dead runtime/); assert.ok(f.requests.every(request => request.body === undefined));
});


test('a delayed turn POST cannot restart a known turn or restore its runtime after a matching close event', async t => {
  const pending = deferred(); const f = fixture(t, url => { assert.equal(url, '/api/turns'); return pending.promise; }); enableCatalog(f);
  f.run("renderThread({ id: 'post-close-chat', cwd: '/closing', projectId: null, status: 'idle', runtimes: [{ runtimeId: 'closed-post-run', managed: true, status: 'idle' }], turns: [] }); $('prompt').value = 'one real task'; controls()"); f.event('composer', 'submit');
  f.run("rpc({ method: 'turn/started', params: { threadId: 'post-close-chat', turn: { id: 'closed-post-turn' } } }); handleEvent('relay', { status: 'runtime-closed', runtimeId: 'closed-post-run', threadId: 'post-close-chat' }, 108)");
  assert.equal(f.run('state.busy'), false); assert.equal(f.run('state.turnId'), null); assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.run('state.activityPhase'), 'closed');
  pending.resolve(response({ thread: { id: 'post-close-chat', cwd: '/closing', projectId: null, status: 'active', runtimes: [{ runtimeId: 'closed-post-run', managed: true, status: 'working' }] }, runtime: { runtimeId: 'closed-post-run', managed: true, status: 'working' }, turn: { id: 'closed-post-turn', status: 'inProgress', items: [{ id: 'closed-post-user', type: 'userMessage', content: [{ text: 'one real task' }] }] } })); await flush();
  assert.equal(f.run('state.busy'), false); assert.equal(f.run('state.turnId'), null); assert.equal(f.run('state.thread.runtimes.length'), 0); assert.equal(f.run('state.activityPhase'), 'closed'); assert.equal(f.run('state.activityTimer'), null); assert.equal(f.nodes.get('run-state').dataset.active, 'false');
  assert.equal(f.run("state.items.get('closed-post-user').text"), 'one real task'); assert.equal(f.run('state.posting'), false); f.run("$('prompt').value = 'next task'; controls()"); assert.equal(f.nodes.get('send').disabled, false); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.submissionId, 'ui-submission');
});
