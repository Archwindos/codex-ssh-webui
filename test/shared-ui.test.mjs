import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { appFixtureSource } from './ui-source-fixture.mjs';

const source = appFixtureSource(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));
const textOf = node => [node.textContent, ...node.children.map(textOf)].filter(Boolean).join(' ');

function fixture(t, handler = () => response({ data: [] })) {
  const nodes = new Map(), requests = [], storage = new Map(), timers = new Map(); let timer = 0;
  const node = () => ({ hidden: false, disabled: false, value: '', checked: false, textContent: '', className: '', children: [], dataset: {}, attributes: {}, listeners: new Map(), style: { setProperty() {} }, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    classList: { toggle() {}, contains() { return false; } }, setAttribute(name, value) { this.attributes[name] = value; }, focus() {}, querySelectorAll() { return []; },
    addEventListener(name, fn) { this.listeners.set(name, fn); }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; }, prepend(...values) { this.children.unshift(...values); } });
  const document = { visibilityState: 'visible', documentElement: node(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, createElementNS: node, createDocumentFragment: node, addEventListener() {} };
  const context = vm.createContext({ document, window: { addEventListener() {} }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, AbortController, crypto: { randomUUID: () => 'shared-submission' },
    EventSource: class { addEventListener() {} close() {} }, setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { const request = { url, options, body: options.body ? typeof options.body === 'string' ? JSON.parse(options.body) : options.body : undefined }; requests.push(request); return handler(request); } });
  vm.runInContext(source, context); const run = code => vm.runInContext(code, context);
  run("state.session = { authenticated: true, csrf: 'test', mode: 'real', projects: [], workspace: { defaultCwd: '/workspace' }, capabilities: { sharedDaemon: true, nativeProjects: true, runtimeManagement: false, allThreads: true, projectManagement: true } }; state.connected = true; state.upstreamStatus = 'connected'; state.view = 'chat'; renderProjects(); renderView(); controls()");
  t.after(() => run('stopSubscription(); stopOverview()'));
  return { run, nodes, requests, storage, event(id, type = 'click') { return nodes.get(id).listeners.get(type)({ preventDefault() {} }); } };
}

test('all literal DOM bindings exist in the shipped page', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), `Missing #${id}`);
  assert.equal(ids.size, [...html.matchAll(/\bid="([^"]+)"/g)].length, 'DOM IDs are unique');
});

test('shared mode starts a useful draft without project selection or runtime controls', async t => {
  const f = fixture(t);
  await f.run('openNewThread()');
  assert.equal(f.run('catalogMode()'), true);
  assert.equal(f.run('state.projectId'), null);
  assert.equal(f.run('state.draftCwd'), '/workspace');
  assert.equal(f.nodes.get('prompt').disabled, false);
  assert.equal(f.nodes.get('chat-lifecycle').hidden, true);
  assert.equal(f.nodes.get('thread-admission').hidden, true);
  assert.equal(f.nodes.get('runtime-help').hidden, true);
  assert.equal(f.nodes.get('open-server').hidden, false);
  assert.equal(f.requests.length, 0);
  assert.doesNotMatch(f.nodes.get('welcome-project').textContent, /独立运行|先新增|选择.*文件夹/);
});

test('new shared chat sends once with a nullable project and its own execution directory', async t => {
  const f = fixture(t, ({ url }) => response(url === '/api/threads' ? { thread: { id: 'new', cwd: '/workspace', turns: [] } } : url === '/api/turns' ? { turn: { id: 'turn', status: 'inProgress' } } : { data: [] }));
  f.run("$('prompt').value = '开始'; controls()"); await f.run('sendMessage()');
  assert.deepEqual(f.requests.find(request => request.url === '/api/threads').body, { cwd: '/workspace', projectId: null });
  assert.deepEqual(f.requests.find(request => request.url === '/api/turns').body, { text: '开始', threadId: 'new', submissionId: 'shared-submission' });
  assert.equal(f.requests.filter(request => request.url === '/api/turns').length, 1);
});

test('resume subscribes to the same shared thread and active input uses expected-turn steering', async t => {
  const f = fixture(t, ({ url }) => response(url === '/api/resume' ? { thread: { id: 'same', status: { type: 'active' }, activeTurnId: 'running', turns: [] } } : { turnId: 'running' }));
  await f.run("openThread({ id: 'same', runtimes: [{ runtimeId: 'same-daemon', managed: false, status: 'working' }] })");
  assert.deepEqual(f.requests[0].body, { threadId: 'same' });
  assert.equal(f.run('externalThread()'), false);
  f.run("$('prompt').value = '先处理测试'; controls()");
  assert.equal(f.nodes.get('send').disabled, false);
  assert.equal(f.nodes.get('send-label').textContent, '补充');
  await f.run('sendMessage()');
  assert.deepEqual(f.requests.find(request => request.url === '/api/steer').body, { text: '先处理测试', threadId: 'same', submissionId: 'shared-submission', turnId: 'running' });
  assert.equal(f.requests.some(request => request.url === '/api/turns'), false);
  assert.equal(f.run('state.turnId'), 'running');
  assert.doesNotMatch(textOf(f.nodes.get('chat-actions')), /停止运行|保持运行/);
});

test('active chat with an unknown turn identity does not issue an unsafe steer', t => {
  const f = fixture(t); f.run("renderThread({ id: 'busy', status: 'active', turns: [] }); $('prompt').value = '补充'; controls()");
  assert.equal(f.nodes.get('prompt').disabled, false);
  assert.equal(f.nodes.get('send').disabled, true);
  assert.equal(f.nodes.get('interrupt').disabled, true);
});

test('projects expand as folders and grouped chats do not duplicate in the ungrouped list', t => {
  const f = fixture(t);
  f.run("state.session.projects = [{ id: 'project', name: '研究', defaultCwd: null }]; state.recentThreads = [{ id: 'grouped', projectId: 'project', name: '项目对话', status: 'idle' }, { id: 'loose', projectId: null, name: '普通对话', status: 'active' }]; state.expandedProjects = new Set(['project']); renderProjects()");
  const folder = f.nodes.get('sidebar-projects').children[0];
  assert.equal(folder.open, true); assert.equal(folder.children[0].children[0].attributes['aria-hidden'], 'true');
  assert.match(textOf(folder), /项目对话/);
  assert.doesNotMatch(textOf(f.nodes.get('threads')), /项目对话/);
  assert.match(textOf(f.nodes.get('threads')), /普通对话/);
  f.run("$('thread-state-filter').value = 'approval'"); f.event('thread-state-filter', 'change');
  assert.match(textOf(f.nodes.get('threads')), /没有符合状态/);
});

test('a failed submission keeps the input and reconnect reads state without replaying it', async t => {
  let connected = false;
  const snapshot = { authenticated: true, mode: 'real', upstreamStatus: 'connected', eventCursor: 8, csrf: 'test', projects: [], pendingApprovals: [], capabilities: { sharedDaemon: true, nativeProjects: true, allThreads: true }, workspace: { defaultCwd: '/workspace' } };
  const f = fixture(t, ({ url }) => {
    if (url === '/api/turns') throw new Error('connection lost');
    if (url === '/api/connect') { connected = true; return response(snapshot); }
    if (url === '/api/session') return response(snapshot);
    if (url === '/api/resume') return response({ thread: { id: 'same', status: 'idle', turns: [{ id: 'done', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: '服务器已收到上一条消息' }] }] }, eventCursor: 8 });
    return response({ data: [] });
  });
  f.run("renderThread({ id: 'same', turns: [] }); $('prompt').value = '不要重复发送'; controls()");
  await assert.rejects(f.run('sendMessage()'), /connection lost/);
  assert.equal(f.nodes.get('prompt').value, '不要重复发送');
  f.run("upstream('closed')"); f.event('reconnect'); await flush(); await flush();
  assert.equal(connected, true);
  assert.equal(f.requests.filter(request => request.url === '/api/turns').length, 1);
  assert.equal(f.requests.filter(request => request.url === '/api/threads').length, 0);
  assert.equal(f.nodes.get('prompt').value, '不要重复发送');
  assert.match(textOf(f.nodes.get('messages')), /服务器已收到/);
});

test('blocking native questions preserve in-progress form input and send one structured answer', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, () => pending);
  f.run("renderThread({ id: 'same', status: 'active', activeTurnId: 'turn', turns: [] }); handleEvent('relay', { status: 'user-input', request: { id: 'question', params: { threadId: 'same', turnId: 'turn', isBlocking: true, questions: [{ id: 'choice', header: '范围', question: '先处理哪一部分？', isOther: true, isSecret: false, options: [{ label: '前端', description: '先完成界面' }] }, { id: 'secret', header: '凭据', question: '输入私密值', isOther: false, isSecret: true, options: null }] } } }, 1)");
  const entry = f.run("state.userInputForms.get('question')");
  entry.fields.get('choice').options[0].input.checked = true; entry.fields.get('secret').text.value = 'private-value';
  assert.equal(entry.fields.get('secret').text.type, 'password');
  f.run('renderApprovals()'); assert.equal(f.run("state.userInputForms.get('question').node"), entry.node);
  assert.match(f.nodes.get('run-state-text').textContent, /等待你回答/);
  entry.node.listeners.get('submit')({ preventDefault() {} }); entry.node.listeners.get('submit')({ preventDefault() {} });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, { requestId: 'question', answers: { choice: { answers: ['前端'] }, secret: { answers: ['private-value'] } } });
  assert.equal([...f.storage.values()].some(value => value.includes('private-value')), false);
  finish(response({ ok: true })); await flush();
  assert.equal(entry.fields.get('secret').text.value, '');
  assert.equal(f.run('state.userInputs.size'), 0);
});

test('nonblocking questions retain composer access and resolved requests clear secret fields', t => {
  const f = fixture(t);
  f.run("renderThread({ id: 'same', status: 'active', activeTurnId: 'turn', turns: [] }); handleEvent('relay', { status: 'user-input', request: { id: 'question', params: { threadId: 'same', isBlocking: false, questions: [{ id: 'q', question: '补充背景', isSecret: true, options: null }] } } }, 1); $('prompt').value = '继续任务'; controls()");
  const field = f.run("state.userInputForms.get('question').fields.get('q').text"); field.value = 'secret';
  assert.equal(f.nodes.get('prompt').disabled, false); assert.equal(f.nodes.get('send').disabled, false);
  f.run("handleEvent('relay', { status: 'user-input-resolved', requestId: 'question' }, 2)");
  assert.equal(field.value, ''); assert.equal(f.run('state.userInputForms.size'), 0);
});

test('unknown native question schema is explicit and has no pretend submit control', t => {
  const f = fixture(t);
  f.run("renderThread({ id: 'same', turns: [] }); handleEvent('relay', { status: 'user-input', request: { id: 'unknown', params: { threadId: 'same', questions: [{ unsupported: true }] } } }, 1)");
  assert.match(textOf(f.nodes.get('approvals')), /官方 Codex 客户端/);
  assert.doesNotMatch(textOf(f.nodes.get('approvals')), /发送回答/);
  assert.equal(f.requests.length, 0);
});

test('shared server panel counts active work rather than all loaded conversations', t => {
  const f = fixture(t);
  f.run("renderOverview({ agents: [{ threadId: 'working', name: '进行中', status: 'working', canOpen: true }, { threadId: 'idle', name: '空闲', status: 'idle', canOpen: true }], metrics: {}, coverage: { externalComplete: true } })");
  assert.equal(f.nodes.get('agents').children.length, 1);
  assert.equal(f.nodes.get('agent-summary').textContent, '1 个对话正在工作');
  assert.doesNotMatch(textOf(f.nodes.get('agents')), /空闲/);
});

test('shared archive confirmation shows the native-client coordination boundary before confirmation', t => {
  const f = fixture(t);
  f.run("state.operation = { kind: 'archive', busy: false, preview: { planId: 'preview', canArchive: true, affected: [{ id: 'same', name: '对话' }], atomicityMessage: '归档期间仅暂停网页发送；其他原生客户端仍可操作，请先确认它们没有继续此对话。' } }; renderOperation()");
  assert.match(textOf(f.nodes.get('operation-details')), /其他原生客户端仍可操作/);
  assert.doesNotMatch(f.nodes.get('operation-description').textContent, /停止.*运行环境/);
  assert.equal(f.nodes.get('operation-confirm').hidden, false);
  assert.equal(f.requests.length, 0);
});

test('item paging starts at the latest 200 and prepends one older page in order without loading the remainder', async t => {
  const f = fixture(t, () => response({ turns: [{ id: 'long-turn', status: 'unknown', items: Array.from({ length: 200 }, (_, i) => ({ id: `item-${805 + i}`, type: 'agentMessage', text: `message ${805 + i}` })) }], nextCursor: 'older-805', pagingMode: 'items' }));
  f.run("state.historyPagingMode = 'items'; renderThread({ id: 'long', turns: [{ id: 'long-turn', status: 'completed', items: Array.from({ length: 200 }, (_, i) => ({ id: 'item-' + (1005 + i), type: 'agentMessage', text: 'message ' + (1005 + i) })) }] }, 'older-1005')");
  assert.equal(f.run('state.items.size'), 200);
  await f.run('loadOlderMessages()');
  assert.equal(f.run('state.items.size'), 400);
  assert.deepEqual(Array.from(f.run('[...state.items.keys()].slice(0, 2)')), ['item-805', 'item-806']);
  assert.equal(f.run('[...state.items.keys()].at(-1)'), 'item-1204');
  assert.equal(f.requests.length, 1); assert.equal(f.run('state.historyCursor'), 'older-805');
});

test('upward user scrolling loads one page, preserves offset and never recursively consumes history', async t => {
  let resolvePage; const pending = new Promise(resolve => { resolvePage = resolve; });
  const f = fixture(t, () => pending);
  f.run("state.historyPagingMode = 'items'; renderThread({ id: 'same', turns: [{ id: 't', items: [{ id: 'new', type: 'agentMessage', text: 'new' }] }] }, 'older'); state.lastScrollTop = 200");
  const container = f.nodes.get('conversation'); container.scrollHeight = 600; container.scrollTop = 100;
  f.event('conversation', 'scroll'); assert.equal(f.requests.length, 0, 'programmatic scrolling does not fetch');
  f.run('state.lastScrollTop = 200'); container.listeners.get('wheel')({ deltaY: -50 }); f.event('conversation', 'scroll'); f.event('conversation', 'scroll');
  assert.equal(f.requests.length, 1);
  const replace = f.nodes.get('messages').replaceChildren; f.nodes.get('messages').replaceChildren = function (...values) { replace.apply(this, values); container.scrollHeight = 1000; };
  resolvePage(response({ turns: [{ id: 'old-turn', items: [{ id: 'old', type: 'agentMessage', text: 'old' }] }], nextCursor: 'another' })); await flush();
  assert.equal(container.scrollTop, 500); assert.equal(f.requests.length, 1);
  f.event('conversation', 'scroll'); assert.equal(f.requests.length, 1);
});

test('late older-history responses cannot add messages or cursors to a different conversation', async t => {
  let resolvePage; const f = fixture(t, () => new Promise(resolve => { resolvePage = resolve; }));
  f.run("renderThread({ id: 'a', turns: [] }, 'a-page')"); const loading = f.run('loadOlderMessages()');
  f.run("renderThread({ id: 'b', turns: [{ id: 'b-turn', items: [{ id: 'b-message', type: 'agentMessage', text: 'B' }] }] })");
  resolvePage(response({ turns: [{ id: 'a-turn', items: [{ id: 'a-message', type: 'agentMessage', text: 'A' }] }], nextCursor: 'a-next' })); await loading;
  assert.equal(f.run('state.thread.id'), 'b'); assert.equal(f.run("state.items.has('a-message')"), false); assert.equal(f.run('state.historyCursor'), null);
});

test('activity groups preserve message boundaries and keep expanded state when an older page joins a group', async t => {
  const f = fixture(t, () => response({ turns: [{ id: 'turn', items: [{ id: 'older-read', type: 'commandExecution', command: 'cat notes.md', commandActions: [{ type: 'read', name: 'notes.md' }] }] }], nextCursor: null }));
  f.run(`renderThread({ id: 'same', turns: [{ id: 'turn', items: [
    { id: 'first', type: 'commandExecution', command: 'run checks' },
    { id: 'summary', type: 'reasoning', summary: ['Reviewing checks'] },
    { id: 'agent-event', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/independent_review' },
    { id: 'second', type: 'commandExecution', command: 'verify results' },
    { id: 'answer', type: 'agentMessage', text: 'Result' },
  ] }] }, 'older'); state.items.get('first').group.node.open = true;`);
  assert.deepEqual(f.nodes.get('messages').children.map(node => node.className), ['activity-group', 'subagent-events', 'activity-group', 'message agent']);
  await f.run('loadOlderMessages()');
  assert.equal(f.run("state.items.get('older-read').group === state.items.get('first').group"), true);
  assert.equal(f.run("state.items.get('first').group.node.open"), true);
  assert.match(textOf(f.nodes.get('messages')), /读文件.*执行命令.*思考摘要/);
  assert.match(textOf(f.nodes.get('messages')), /Independent review.*开始工作/);
});

test('snapshot recovery retains older messages before new replies and does not shorten live content', async t => {
  const f = fixture(t);
  f.run("renderThread({ id: 'same', turns: [{ id: 'old', items: [{ id: 'old-answer', type: 'agentMessage', text: 'old answer' }, { id: 'old-tool', type: 'commandExecution', command: 'old command' }] }] }, 'earliest'); state.eventCursor = 10");
  await f.run("installSharedSnapshot({ thread: { id: 'same', turns: [{ id: 'new', items: [{ id: 'new-answer', type: 'agentMessage', text: 'new answer' }] }] }, nextCursor: 'newer-cursor', eventCursor: 10, eventCursorEnd: 10, pagingMode: 'items' }, { preserve: true })");
  assert.deepEqual(Array.from(f.run('[...state.items.keys()]')), ['old-answer', 'old-tool', 'new-answer']);
  assert.equal(f.run('state.historyCursor'), 'earliest');
  f.run("appendItem({ id: 'new-answer', type: 'agentMessage', text: 'x'.repeat(21000) }); rpc({ method: 'item/completed', params: { threadId: 'same', item: { id: 'new-answer', type: 'agentMessage', text: 'x'.repeat(20000), truncated: true } } })");
  assert.equal(f.run("state.items.get('new-answer').text.length"), 21000);
});

test('history catchup merges covered deltas once and retains events beyond the response watermark', async t => {
  const f = fixture(t, ({ url }) => response(url.startsWith('/api/poll?') ? { events: [
    { id: 11, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'same', turnId: 'turn', itemId: 'answer', delta: ' world' } } },
    { id: 12, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'same', turnId: 'turn', itemId: 'answer', delta: '!' } } },
    { id: 13, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'same', turnId: 'turn', itemId: 'answer', delta: '!' } } },
  ], cursor: 13, resync: false, upstreamStatus: 'connected' } : { data: [] }));
  f.run("renderThread({ id: 'same', status: 'active', activeTurnId: 'turn', turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'Hello' }] }] }); state.eventCursor = 10");
  await f.run("installSharedSnapshot({ thread: { id: 'same', status: 'active', activeTurnId: 'turn', turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'answer', type: 'agentMessage', text: 'Hello world' }] }] }, eventCursor: 10, eventCursorEnd: 12, pagingMode: 'items' }, { preserve: true })");
  assert.equal(f.run("state.items.get('answer').text"), 'Hello world!!'); assert.equal(f.run('state.eventCursor'), 13);
});

test('a fresh snapshot uses suffix overlap for replay and does not discard a delayed live final item', async t => {
  const f = fixture(t, () => response({ events: [{ id: 21, event: 'rpc', data: { method: 'item/agentMessage/delta', params: { threadId: 'new', turnId: 'turn', itemId: 'answer', delta: ' world' } } }, { id: 22, event: 'rpc', data: { method: 'item/completed', params: { threadId: 'new', turnId: 'turn', item: { id: 'final', type: 'agentMessage', text: 'Final reply' } } } }], cursor: 22, resync: false, upstreamStatus: 'connected' }));
  await f.run("installSharedSnapshot({ thread: { id: 'new', turns: [{ id: 'turn', items: [{ id: 'answer', type: 'agentMessage', text: 'Hello world' }] }] }, eventCursor: 20, eventCursorEnd: 21, pagingMode: 'items' })");
  assert.equal(f.run("state.items.get('answer').text"), 'Hello world'); assert.equal(f.run("state.items.get('final').text"), 'Final reply');
});

test('summary-only completion reads the newest item page once to recover a missing final reply', async t => {
  const f = fixture(t, ({ url }) => response(url.startsWith('/api/history?') ? { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'final', type: 'agentMessage', text: 'Recovered final' }] }], nextCursor: null, pagingMode: 'items', status: 'idle', eventCursor: 5, eventCursorEnd: 5 } : { data: [] }));
  f.run("renderThread({ id: 'same', status: 'active', activeTurnId: 'turn', turns: [] }); state.eventCursor = 5; rpc({ method: 'turn/completed', params: { threadId: 'same', turn: { id: 'turn', status: 'completed', items: [], itemsView: 'notLoaded' } } })");
  await flush(); await flush();
  assert.equal(f.run("state.items.get('final').text"), 'Recovered final');
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/history?')).length, 1);
});

test('empty reasoning items keep ordering identity without displaying hundreds of blank progress rows', t => {
  const f = fixture(t); f.run("renderThread({ id: 'same', turns: [{ id: 'turn', items: [...Array.from({ length: 1001 }, (_, i) => ({ id: 'reason-' + i, type: 'reasoning', summary: [], content: [] })), { id: 'final', type: 'agentMessage', text: 'Visible final' }] }] })");
  assert.equal(f.run('state.items.size'), 1002); assert.equal(f.run("[...state.items.values()].filter(entry => !entry.node.hidden).length"), 1);
  f.run("rpc({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'same', itemId: 'reason-1000', delta: 'Meaningful progress' } })");
  assert.equal(f.run("state.items.get('reason-1000').node.hidden"), false);
});

test('catalog ID merges remove repeated IDs while same-title threads remain and internal visibility resets paging', async t => {
  const f = fixture(t, ({ url }) => response(url.includes('pinned=true') ? { data: [{ id: 'pin', name: 'Sample project', pinned: true, projectId: 'project' }] } : { data: [{ id: 'one', name: 'Sample project' }, { id: 'one', name: 'Sample project' }, { id: 'two', name: 'Sample project' }], nextCursor: 'more' }));
  f.run("state.session.capabilities.internalThreads = true; state.session.projects = [{ id: 'project', name: 'Project' }]; renderView()");
  await f.run('history()'); await f.run('history(true)');
  assert.deepEqual(Array.from(f.run('state.libraryThreads.map(thread => thread.id)')), ['one', 'two']);
  f.run("state.recentThreads.push({ id: 'pin', name: 'Sample project', projectId: 'project', pinned: true }); renderSidebar()");
  assert.doesNotMatch(textOf(f.nodes.get('sidebar-projects')), /Sample project/);
  f.nodes.get('include-internal').checked = true; f.event('include-internal', 'change'); await flush();
  const internal = f.requests.filter(request => request.url.includes('includeInternal=true'));
  assert.ok(internal.length >= 2); assert.ok(internal.every(request => !request.url.includes('cursor=')));
});

test('an older resume cannot overwrite a later conversation selection', async t => {
  let resolveOld; const pending = new Promise(resolve => { resolveOld = resolve; });
  const f = fixture(t, ({ body }) => body.threadId === 'old' ? pending : response({ thread: { id: 'new', turns: [{ id: 'turn', items: [{ id: 'new-answer', type: 'agentMessage', text: 'new answer' }] }] }, eventCursor: 10 }));
  const old = f.run("openThread({ id: 'old' })"); await f.run("openThread({ id: 'new' })");
  resolveOld(response({ thread: { id: 'old', turns: [] }, eventCursor: 2 })); await old;
  assert.equal(f.run('state.thread.id'), 'new'); assert.equal(f.run("state.items.has('new-answer')"), true);
});

test('composer displays the effective native model and context rather than a catalog default or cumulative usage', async t => {
  const f = fixture(t, ({ url }) => response(url.startsWith('/api/models') ? { models: [{ id: 'astra-id', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }, { reasoningEffort: 'xhigh', description: 'Extra high' }] }, { id: 'sol-id', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }], defaults: { model: 'gpt-6.1-sol', reasoningEffort: 'high' } } : { data: [] }));
  f.run("state.session.capabilities.composerModels = true; renderThread({ id: 'native', model: 'gpt-6-astra', reasoningEffort: 'xhigh', tokenUsage: { total: { totalTokens: 136000000 }, last: { totalTokens: 208958 }, modelContextWindow: 258400 }, turns: [] })");
  await f.run('loadComposerCatalog()');
  assert.equal(f.nodes.get('composer-model').textContent, 'GPT-6 Astra 极高'); assert.equal(f.nodes.get('composer-effort').max, '1');
  assert.equal(f.nodes.get('context-percent').textContent, '81% 已用'); assert.match(f.nodes.get('context-tokens').textContent, /208,958/); assert.doesNotMatch(f.nodes.get('context-tokens').textContent, /136,000,000/);
  assert.deepEqual(Array.from(f.run('Object.keys(composerOverrides())')), []);
  f.run("state.thread.tokenUsage = null; state.thread.context = null; renderComposer()"); assert.equal(f.nodes.get('context-percent').textContent, '未提供');
});

test('model changes never silently reduce an unsupported current reasoning level', async t => {
  const f = fixture(t, () => response({ turn: { id: 'turn', status: 'inProgress' } }));
  f.run("renderThread({ id: 'native', model: 'astra', reasoningEffort: 'xhigh', turns: [] }); state.models = [{ model: 'astra', displayName: 'Astra', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] }, { model: 'small', displayName: 'Small', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }]; $('prompt').value = 'task'; $('composer-model-select').value = 'small'");
  f.event('composer-model-select', 'change');
  assert.equal(f.run('state.modelChoiceRequired'), true); assert.equal(f.nodes.get('send').disabled, true); assert.match(f.nodes.get('composer-model-status').textContent, /不支持原推理等级/);
  f.nodes.get('composer-effort').value = '1'; f.event('composer-effort', 'input'); await f.run('sendMessage()');
  assert.equal(f.requests[0].body.model, 'small'); assert.equal(f.requests[0].body.reasoningEffort, 'medium');
});

test('opening native context refreshes an external model change instead of retaining an old local override', async t => {
  const f = fixture(t, () => response({ threadId: 'same', model: 'gpt-6-astra', reasoningEffort: 'xhigh', context: { used: 100, max: 1000 }, tokenUsage: null }));
  f.run("renderThread({ id: 'same', model: 'gpt-6.1-sol', reasoningEffort: 'high', turns: [] }); state.modelSelection = 'gpt-6.1-sol'; state.effortSelection = 'high'; state.session.capabilities.threadContext = true");
  await f.run("refreshComposerContext('same', { force: true })");
  assert.equal(f.run('state.thread.model'), 'gpt-6-astra'); assert.equal(f.run('state.modelSelection'), null); assert.match(f.nodes.get('composer-model').textContent, /gpt-6-astra 极高/);
});

test('running-task steering omits model, effort and permission changes selected for the next turn', async t => {
  const f = fixture(t, () => response({ turnId: 'running' }));
  f.run("renderThread({ id: 'native', status: 'active', activeTurnId: 'running', turns: [] }); state.modelSelection = 'gpt-6-astra'; state.effortSelection = 'xhigh'; state.permissionSelection = ':workspace'; $('prompt').value = 'adjust'; controls()");
  await f.run('sendMessage()'); const body = f.requests[0].body;
  assert.equal(f.requests[0].url, '/api/steer'); assert.equal(body.model, undefined); assert.equal(body.reasoningEffort, undefined); assert.equal(body.permissions, undefined);
});

test('permission menu contains only inherited and currently allowed native profiles', async t => {
  const f = fixture(t, () => response({ selection: 'inherit', profiles: [{ id: ':read-only', allowed: true, description: 'Read only' }, { id: ':workspace', allowed: true, description: 'Workspace' }, { id: ':danger-full-access', allowed: false, description: 'Unavailable' }] }));
  f.run('state.session.capabilities.permissionProfiles = true'); await f.run('loadPermissionProfiles()');
  const text = textOf(f.nodes.get('permission-options')); assert.match(text, /服务器默认/); assert.match(text, /只读/); assert.match(text, /工作区/); assert.doesNotMatch(text, /完全访问|guardian|帮我批准/);
});

test('raw uploads produce removable attachment IDs and attachment-only submission uses those IDs once', async t => {
  const f = fixture(t, ({ url }) => response(url === '/api/attachments' ? { attachment: { id: 'uploaded', name: '结果.csv', size: 8, mimeType: 'text/csv', kind: 'file' } } : url === '/api/turns' ? { turn: { id: 'turn', status: 'completed' } } : {}));
  f.run("renderThread({ id: 'native', turns: [] }); state.session.capabilities.attachments = true; state.session.attachmentLimits = { maxFiles: 5, maxFileBytes: 100 }; $('prompt').value = ''");
  await f.run("addAttachments([{ name: '结果.csv', size: 8, type: 'text/csv' }])");
  const upload = f.requests[0]; assert.equal(upload.options.headers['Content-Type'], 'application/octet-stream'); assert.equal(upload.options.headers['X-Attachment-Name'], encodeURIComponent('结果.csv')); assert.equal(upload.body.name, '结果.csv');
  assert.equal(f.nodes.get('send').disabled, false); await f.run('sendMessage()');
  const turn = f.requests.find(request => request.url === '/api/turns'); assert.equal(turn.body.text, ''); assert.deepEqual(turn.body.attachmentIds, ['uploaded']); assert.equal(f.run('state.attachments.length'), 0);
});

test('upload failure stays explicit and cannot silently send a stale attachment ID', async t => {
  const f = fixture(t, () => response({ error: { message: 'unsupported attachment' } }, 400));
  f.run("state.session.capabilities.attachments = true; $('prompt').value = 'task'"); await f.run("addAttachments([{ name: 'bad.exe', size: 5, type: '' }])");
  assert.equal(f.run('state.attachments[0].status'), 'failed'); assert.match(textOf(f.nodes.get('attachment-list')), /unsupported attachment/); assert.equal(f.nodes.get('send').disabled, true);
  await f.run('removeAttachment(state.attachments[0].key)'); assert.equal(f.nodes.get('send').disabled, false); assert.equal(f.requests.some(request => request.url === '/api/turns'), false);
});

test('switching conversation during upload cancels the draft epoch and ignores the old success reply', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, ({ url }) => url === '/api/attachments' ? pending : response({ cancelled: true }));
  f.run("renderThread({ id: 'old', turns: [] }); state.session.capabilities.attachments = true");
  const uploading = f.run("addAttachments([{ name: 'old.txt', size: 8, type: 'text/plain' }])");
  f.run("renderThread({ id: 'new', turns: [] })");
  assert.equal(f.requests[0].options.signal.aborted, true);
  finish(response({ attachment: { id: 'old-id', name: 'old.txt', size: 8, kind: 'file' } })); await uploading;
  assert.equal(f.run('state.attachments.length'), 0); assert.equal(f.nodes.get('attachment-list').hidden, true);
  assert.ok(f.requests.some(request => request.url === '/api/attachments/cancel' && request.body.attachmentId === 'old-id'));
  assert.equal(f.requests.some(request => request.url === '/api/turns'), false);
});

test('logout clears in-flight uploads without reintroducing their IDs after a late response', async t => {
  let finish; const f = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.run('state.session.capabilities.attachments = true'); const uploading = f.run("addAttachments([{ name: 'secret.txt', size: 8, type: 'text/plain' }])");
  f.run('setAuthenticated(false)'); finish(response({ attachment: { id: 'late-id', name: 'secret.txt', size: 8 } })); await uploading;
  assert.equal(f.run('state.attachments.length'), 0); assert.equal(f.run('state.session.authenticated'), false); assert.equal(f.requests.length, 1);
});

test('starting a new draft during upload keeps a late upload reply out of the new message', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, ({ url }) => url === '/api/attachments' ? pending : response({ cancelled: true }));
  f.run('state.session.capabilities.attachments = true'); const uploading = f.run("addAttachments([{ name: 'old.txt', size: 8, type: 'text/plain' }])");
  await f.run('openNewThread()'); finish(response({ attachment: { id: 'old-draft-id', name: 'old.txt', size: 8 } })); await uploading;
  assert.equal(f.run('state.thread'), null); assert.equal(f.run('state.attachments.length'), 0); assert.equal(f.nodes.get('send').disabled, true);
  assert.ok(f.requests.some(request => request.url === '/api/attachments/cancel' && request.body.attachmentId === 'old-draft-id'));
});

test('first attachment-only turn transfers ready uploads and explicit options into its newly created conversation', async t => {
  const f = fixture(t, ({ url }) => response(url === '/api/attachments' ? { attachment: { id: 'ready-file', name: 'data.csv', size: 8 } } : url === '/api/threads' ? { thread: { id: 'created', cwd: '/workspace', turns: [] } } : url === '/api/turns' ? { thread: { id: 'created', model: 'gpt-6-astra', reasoningEffort: 'xhigh' }, turn: { id: 'turn', status: 'inProgress' } } : { data: [] }));
  f.run("state.session.capabilities.attachments = true; state.modelSelection = 'gpt-6-astra'; state.effortSelection = 'xhigh'");
  await f.run("addAttachments([{ name: 'data.csv', size: 8, type: 'text/csv' }])"); await f.run('sendMessage()');
  const turn = f.requests.find(request => request.url === '/api/turns');
  assert.equal(turn.body.threadId, 'created'); assert.equal(turn.body.text, ''); assert.deepEqual(turn.body.attachmentIds, ['ready-file']); assert.equal(turn.body.model, 'gpt-6-astra'); assert.equal(turn.body.reasoningEffort, 'xhigh');
  assert.equal(f.requests.some(request => request.url === '/api/attachments/cancel'), false); assert.equal(f.run('state.modelSelection'), null);
});

test('sent attachment names remain visible in restored user messages without server file paths', t => {
  const f = fixture(t);
  f.run("renderThread({ id: 'restored', turns: [{ id: 'prior', items: [{ id: 'uploaded-user-message', type: 'userMessage', content: [{ type: 'text', text: '检查附件' }], attachments: [{ name: '实验结果.csv', mimeType: 'text/csv', size: 8 }] }] }] })");
  assert.match(textOf(f.nodes.get('messages')), /检查附件/); assert.match(textOf(f.nodes.get('messages')), /实验结果.csv/); assert.doesNotMatch(textOf(f.nodes.get('messages')), /\/runtime\/|\/mock\/|attachmentIds/);
});

test('compact project rows provide inline actions and the whole projects heading can collapse', t => {
  const f = fixture(t); f.run("state.session.projects = [{ id: 'one', name: 'One', roots: [] }, { id: 'two', name: 'Two', roots: [] }]; renderProjects()");
  const row = f.nodes.get('sidebar-projects').children[0], summary = row.children[0];
  assert.equal(summary.children[2].className, 'project-row-actions'); assert.equal(summary.children[2].children.length, 2);
  assert.doesNotMatch(textOf(row), /编辑项目|查看项目对话|新建对话/);
  f.nodes.get('sidebar-projects').querySelectorAll = () => f.nodes.get('sidebar-projects').children;
  summary.listeners.get('click')(); f.nodes.get('sidebar-projects').children[1].children[0].listeners.get('click')();
  assert.equal(row.dataset.active, 'false'); assert.equal(f.nodes.get('sidebar-projects').children[1].dataset.active, 'true');
  f.event('toggle-projects'); assert.equal(f.nodes.get('sidebar-projects').hidden, true); assert.equal(f.nodes.get('toggle-projects').attributes['aria-expanded'], 'false');
});

test('web project pinning reads back shared preferences without claiming native sections', async t => {
  let pinned = [];
  const f = fixture(t, ({ url, body }) => { if (url === '/api/project-view/pin') { pinned = body.pinned ? [body.projectId] : []; return response({ projectView: { viewScope: 'webui', pinnedProjectIds: pinned, sections: [], memberships: {} } }); } return response({ projects: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], projectView: { viewScope: 'webui', pinnedProjectIds: pinned, sections: [], memberships: {} } }); });
  f.run("state.session.capabilities.projectViewPreferences = true; state.session.capabilities.projectViewSections = false; state.session.projects = [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]; renderSidebar(); openProjectMenu(state.session.projects[1], $('add-project'))");
  assert.match(textOf(f.nodes.get('project-menu')), /置顶仅用于网页侧栏/); assert.doesNotMatch(textOf(f.nodes.get('project-menu')), /分区|移到顶部/);
  await f.run("updateProjectView('/api/project-view/pin', { projectId: 'two', pinned: true })");
  assert.equal(f.nodes.get('sidebar-projects').children[0].dataset.projectId, 'two'); assert.equal(f.run('state.session.projects[0].id'), 'one');
  assert.equal(f.requests.filter(request => request.url === '/api/project-view/pin').length, 1); assert.ok(f.requests.some(request => request.url === '/api/projects' && request.options.method === 'GET'));
});

test('late project snapshots cannot overwrite newer cross-device metadata', async t => {
  let oldResolve, newResolve, count = 0;
  const f = fixture(t, () => new Promise(resolve => { if (++count === 1) oldResolve = resolve; else newResolve = resolve; }));
  const old = f.run('refreshProjects({ force: true })'), fresh = f.run('refreshProjects({ force: true })');
  newResolve(response({ projects: [{ id: 'new', name: 'Remote project' }] })); await fresh;
  oldResolve(response({ projects: [{ id: 'old', name: 'Old project' }] })); await old;
  assert.equal(f.run('state.session.projects[0].id'), 'new');
});

test('a chat with an uncached native project stays visible until the project snapshot arrives', async t => {
  const f = fixture(t, () => response({ projects: [{ id: 'remote', name: '另一设备的项目', roots: [] }] }));
  f.run("state.recentThreads = [{ id: 'remote-chat', name: '远程项目中的聊天', projectId: 'remote', status: 'idle' }]; renderSidebar()");
  assert.match(textOf(f.nodes.get('threads')), /远程项目中的聊天/);
  await f.run('refreshProjects()'); assert.match(textOf(f.nodes.get('sidebar-projects')), /远程项目中的聊天/); assert.doesNotMatch(textOf(f.nodes.get('threads')), /远程项目中的聊天/);
});

test('editing a multi-root project sends only the name and preserves all native roots', async t => {
  const project = { id: 'multi', name: 'Updated', defaultCwd: '/one', roots: [{ path: '/one' }, { path: '/two' }] };
  const f = fixture(t, ({ url }) => response(url === '/api/projects/update' ? { project } : url === '/api/projects' ? { projects: [project] } : { data: [] }));
  f.run("state.session.projects = [{ id: 'multi', name: 'Original', defaultCwd: '/one', roots: [{ path: '/one' }, { path: '/two' }] }]; state.projectId = 'multi'");
  await f.run('openProjectEditor(true)'); assert.equal(f.nodes.get('directory-path').disabled, true);
  f.nodes.get('project-name').value = 'Updated'; await f.run('saveProject()');
  const update = f.requests.find(request => request.url === '/api/projects/update'); assert.equal(update.body.name, 'Updated'); assert.equal(update.body.defaultCwd, undefined); assert.equal(update.body.roots, undefined); assert.equal(f.run('state.session.projects[0].roots.length'), 2);
});

test('server directory browsing uses read-only requests and a separate copy action', async t => {
  const f = fixture(t, () => response({ cwd: '/project', parent: '/', roots: ['/'], entries: [{ name: 'src', cwd: '/project/src' }] }));
  await f.run("openProjectDirectory({ id: 'one', name: 'One', defaultCwd: '/project' })");
  assert.equal(f.nodes.get('select-directory').hidden, true); assert.equal(f.nodes.get('copy-directory').hidden, false); assert.equal(f.nodes.get('project-name-field').hidden, true);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.method, 'GET'); assert.match(f.requests[0].url, /^\/api\/directories\?/);
});

test('project archive exposes associated Guardian descendants and requires explicit scope consent', async t => {
  const members = [{ id: 'root', name: 'Root chat', projectId: 'one', isProjectMember: true }, { id: 'guardian', name: 'Guardian associated', projectId: 'other', isProjectMember: false }];
  const f = fixture(t, ({ url }) => response(url.endsWith('/preview') ? { planId: 'plan', operationId: 'operation', projectId: 'one', affected: members, outsideProjectIds: ['guardian'], requiresAssociatedConfirmation: true, canArchive: true, atomicityMessage: '其他客户端仍可改变对话。' } : url === '/api/projects/archive' ? { operationId: 'operation', kind: 'archive', projectId: 'one', status: 'partial', affected: members.map(item => ({ ...item, status: item.id === 'root' ? 'archived' : 'unknown' })), outsideProjectIds: ['guardian'], roots: [{ threadId: 'root', operationId: 'child-operation', status: 'partial' }] } : url.endsWith('/recheck') ? { operationId: 'operation', kind: 'archive', projectId: 'one', status: 'complete', affected: members.map(item => ({ ...item, status: 'archived' })), outsideProjectIds: ['guardian'] } : url === '/api/projects' ? { projects: [{ id: 'one', name: 'One' }] } : { data: [] }));
  await f.run("previewProjectOperation('project-archive', { id: 'one', name: 'One' })");
  assert.match(textOf(f.nodes.get('operation-details')), /Guardian associated/); assert.match(textOf(f.nodes.get('operation-details')), /其他项目或未分配/); assert.equal(f.nodes.get('operation-confirm').disabled, true);
  await f.run('confirmProjectOperation()'); assert.equal(f.requests.some(request => request.url === '/api/projects/archive'), false);
  f.nodes.get('include-associated-project-chats').checked = true; f.event('include-associated-project-chats', 'change'); await f.run('confirmProjectOperation()');
  assert.equal(f.requests.find(request => request.url === '/api/projects/archive').body.includeAssociated, true); assert.match(f.nodes.get('operation-description').textContent, /仅部分完成/); assert.match(textOf(f.nodes.get('operation-details')), /结果未知/);
  await f.run('recheckProjectOperation()'); assert.equal(f.requests.filter(request => request.url === '/api/projects/archive').length, 1); assert.equal(f.requests.filter(request => request.url === '/api/projects/archive/recheck').length, 1); assert.equal(f.run('state.operation.result.status'), 'complete');
});

test('project removal preserves the viewed chat and message content while cancelling native project membership', async t => {
  const f = fixture(t, ({ url }) => response(url.endsWith('/preview') ? { planId: 'remove-plan', operationId: 'remove-operation', canRemove: true, affected: [{ id: 'chat', name: 'Chat', projectId: 'one', isProjectMember: true }] } : url === '/api/projects/remove' ? { operationId: 'remove-operation', kind: 'remove', projectId: 'one', projectRemoved: true, status: 'complete', affected: [{ id: 'chat', name: 'Chat', projectId: 'one', isProjectMember: true, status: 'unassigned' }] } : url === '/api/projects' ? { projects: [] } : { data: [{ id: 'chat', name: 'Chat', projectId: null }] }));
  f.run("state.session.projects = [{ id: 'one', name: 'One' }]; renderThread({ id: 'chat', projectId: 'one', cwd: '/keep-files', turns: [{ id: 'turn', items: [{ id: 'message', type: 'agentMessage', text: 'Keep this history' }] }] })");
  await f.run("previewProjectOperation('project-remove', { id: 'one', name: 'One' })"); assert.match(f.nodes.get('operation-description').textContent, /聊天历史和服务器文件保留/); await f.run('confirmProjectOperation()');
  assert.equal(f.run('state.thread.id'), 'chat'); assert.equal(f.run('state.thread.projectId'), null); assert.equal(f.run('state.thread.cwd'), '/keep-files'); assert.equal(f.run("state.items.get('message').text"), 'Keep this history');
});

test('an uncertain project execute keeps its stable operation ID and only rechecks without replay', async t => {
  const f = fixture(t, ({ url }) => { if (url === '/api/projects/remove') throw new Error('lost response'); return response(url.endsWith('/preview') ? { planId: 'plan', operationId: 'stable', canRemove: true, affected: [{ id: 'chat', name: 'Chat' }] } : url.endsWith('/recheck') ? { operationId: 'stable', kind: 'remove', status: 'unknown', affected: [{ id: 'chat', name: 'Chat', status: 'unknown' }] } : url === '/api/projects' ? { projects: [] } : { data: [] }); });
  await f.run("previewProjectOperation('project-remove', { id: 'one', name: 'One' })"); await f.run('confirmProjectOperation()');
  assert.equal(f.run('state.operation.result.operationId'), 'stable'); assert.equal(f.run('state.operation.result.status'), 'unknown'); assert.equal(f.nodes.get('operation-confirm').hidden, true);
  await f.run('recheckProjectOperation()'); assert.equal(f.requests.filter(request => request.url === '/api/projects/remove').length, 1); assert.equal(f.requests.filter(request => request.url === '/api/projects/remove/recheck').length, 1);
});
