import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/run\(\(\) => hydrate\(\)\);\s*$/, '');
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
  const resources = f.nodes.get('resource-list').children;
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
  f.run(`renderOverview({ agents: [], metrics: { cpu: { percent: 12.6, cores: 32 }, memory: { usedBytes: ${108 * gb}, totalBytes: ${252 * gb}, percent: 42.857 }, gpus: [{ index: 0, name: 'Long GPU model not needed here', utilizationPercent: 0, memoryUsedBytes: ${8.5 * gb}, memoryTotalBytes: ${24 * gb}, temperatureC: 72 }, { index: 1, utilizationPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: ${24 * gb} }], storage: [{ path: '/srv/storage', totalBytes: ${100 * gb}, usedBytes: ${30 * gb}, availableBytes: ${68 * gb}, percent: 30 }, { path: '/srv/unknown', availableBytes: null }] } })`);
  const resources = textOf(f.nodes.get('resource-list'));
  assert.match(resources, /CPU 13%/); assert.match(resources, /内存 108 GB \/ 252 GB/);
  assert.match(resources, /GPU 0 0% 显存 8\.5 GB \/ 24 GB/);
  assert.match(resources, /GPU 1 0% 显存 0 B \/ 24 GB/);
  assert.match(resources, /\/srv\/storage 30 GB \/ 100 GB 68 GB 可用/);
  assert.match(resources, /\/srv\/unknown 暂不可用/);
  assert.doesNotMatch(resources, /70 GB|Long GPU|72|32 核|42\.857|\.0 GB|0\.0 KB/);
  const rows = f.nodes.get('resource-list').children;
  assert.equal(rows[0].children[1].children[1].children[0].style.values['--usage'], '12.6%');
  assert.equal(rows[2].children[1].children[1].children[0].style.values['--usage'], '0%');
  assert.equal(rows[2].children[1].children[2].children[0].dataset.percent, String(8.5 / 24 * 100));
  assert.equal(rows[4].children[1].children[1].children[0].dataset.percent, '30');
  assert.equal(rows[5].children[1].children[1].dataset.known, 'false'); assert.equal(rows[5].children[1].children[1].children.length, 0);
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
