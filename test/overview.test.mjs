import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory, parseGpu, rolloutActivity, createOverviewCollector, parseTmuxPanes, createTmuxResolver } from '../src/overview.mjs';

test('tmux metadata parses real IDs and never substitutes an operating-system PID', () => {
  const [pane] = parseTmuxPanes('$3|work|1|2|%7|400\n');
  assert.deepEqual(pane, { sessionId: '$3', sessionName: 'work', windowIndex: 1, paneIndex: 2, paneId: '%7', panePid: 400, target: '$3:1.2' });
  assert.equal(parseTmuxPanes('$3|work|with|separator|1|2|%7|400')[0].sessionName, 'work|with|separator');
  for (const line of ['3|work|1|2|%7|400', '$3|work|bad|2|%7|400', '$3|work|1|2|7|400', '$3|work|1|2|%7|0', '$3|work|1|2|%7|400|extra', '$0_codex-ssh-webui-private_0_0_%0_2565736']) assert.deepEqual(parseTmuxPanes(line), []);
});

const pane = parseTmuxPanes('$3|work|1|2|%7|400')[0];
const processRows = new Map([[500, { pid: 500, ppid: 400, startTicks: '10', comm: 'codex' }], [400, { pid: 400, ppid: 1, startTicks: '9', comm: 'shell' }]]);
const tmuxOptions = { initialSockets: ['fixture'], getProcess: async pid => processRows.get(pid) || null, getEnvironment: async () => ({ complete: true }), listSocket: async () => ({ panes: [pane], complete: true }) };

test('tmux follows the actual pane ancestor when the child environment was stripped', async () => {
  const resolve = createTmuxResolver({ ...tmuxOptions, getEnvironment: async () => { throw Error('must not need private environment'); } });
  const result = await resolve(500);
  assert.equal(result.tmuxState, 'attached'); assert.equal(result.tmux.target, '$3:1.2');
  assert.equal(result.tmux.paneId, '%7'); assert.equal(Object.hasOwn(result.tmux, 'panePid'), false);
});

test('tmux refuses attribution after PID reuse or reparenting', async () => {
  for (const changed of [{ startTicks: '99' }, { ppid: 99 }]) {
    let reads = 0;
    const resolve = createTmuxResolver({ ...tmuxOptions, getProcess: async pid => pid === 500 && ++reads > 1 ? { ...processRows.get(pid), ...changed } : processRows.get(pid) });
    assert.equal((await resolve(500)).tmuxState, 'unknown');
  }
});

test('custom tmux sockets require a matching pane ancestor, not inherited hints alone', async () => {
  const queries = [];
  const resolve = createTmuxResolver({ ...tmuxOptions, initialSockets: [], getEnvironment: async () => ({ complete: true, socket: '/custom/socket' }), listSocket: async socket => { queries.push(socket); return { panes: [pane], complete: true }; } });
  assert.equal((await resolve(500)).tmux.target, '$3:1.2'); assert.deepEqual(queries, ['/custom/socket']);
  const stale = createTmuxResolver({ ...tmuxOptions, initialSockets: [], getEnvironment: async () => ({ complete: true, socket: '/stale/socket' }), listSocket: async () => ({ panes: [{ ...pane, panePid: 999 }], complete: true }) });
  assert.equal((await stale(500)).tmuxState, 'unknown');
});

test('missing tmux and unreadable attribution remain distinct states', async () => {
  const none = createTmuxResolver({ ...tmuxOptions, initialSockets: [] });
  assert.deepEqual(await none(500), { tmux: null, tmuxState: 'none' });
  const denied = createTmuxResolver({ ...tmuxOptions, initialSockets: [], getEnvironment: async () => { throw Error('permission'); } });
  assert.deepEqual(await denied(500), { tmux: null, tmuxState: 'unknown' });
});

test('relay conversations inherit their real process tmux and cached conversation title', async () => {
  const collect = createOverviewCollector({ config: { projects: [], workspace: { roots: ['/'] } }, rpc: { child: { pid: 500 } }, threadNames: new Map([['actual-thread', 'Project experiment']]), authorizedThreads: new Map([['actual-thread', '/work']]), loadedThreads: new Set(['actual-thread']), activeTurns: new Map([['actual-thread', 'turn']]), busy: new Set(['actual-thread']), approvals: new Map(), sampleMetrics: async () => ({}), observeProcesses: async () => ({ agents: [{ threadId: '', pid: 500, status: 'unknown', tmuxState: 'attached', tmux: { target: '$3:1.2' } }], complete: true }) });
  const active = (await collect()).agents.find(agent => agent.threadId === 'actual-thread');
  assert.equal(active.name, 'Project experiment'); assert.equal(active.status, 'working'); assert.equal(active.tmux.target, '$3:1.2');
});

test('memory uses available bytes, and GPU unknown measurements remain null', () => {
  const memory = parseMemory('MemTotal:       1000 kB\nMemAvailable:     750 kB\n');
  assert.equal(memory.percent, 25); assert.equal(memory.availableBytes, 768000);
  assert.throws(() => parseMemory('MemTotal: 1000 kB\n'));
  const gpu = parseGpu('0, NVIDIA Test, 63, 24000, 12000, 58\n1, NVIDIA Other, [N/A], 16000, 0, N/A');
  assert.equal(gpu[0].memoryUsedBytes, 12000 * 1048576); assert.equal(gpu[1].utilizationPercent, null); assert.equal(gpu[1].temperatureC, null);
});

test('only explicit task events determine activity for an observed live rollout', () => {
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: '/work/project', private: 'NOT_EXPOSED' } });
  const event = type => JSON.stringify({ type: 'event_msg', payload: { type, message: 'NOT_EXPOSED' } });
  assert.deepEqual(rolloutActivity(head, event('task_started')), { threadId: 'thread-1', cwd: '/work/project', status: 'working' });
  assert.equal(rolloutActivity(head, `${event('task_started')}\n${event('task_complete')}`).status, 'idle');
  assert.equal(rolloutActivity(head, event('agent_message')).status, 'unknown');
  assert.equal(rolloutActivity('{}', event('task_started')), null);
});

test('overview merges live processes with relay state, caches and coalesces collection', async () => {
  let calls = 0, now = 10000;
  const options = { config: { projects: [], workspace: { roots: ['/'] } }, authorizedThreads: new Map([['thread-1', '/work/a']]), loadedThreads: new Set(['thread-1']), activeTurns: new Map([['thread-1', 'turn-1']]), busy: new Set(['thread-1']), approvals: new Map([['approve', { params: { threadId: 'thread-1' } }]]), clock: () => now,
    registerProject: async cwd => ({ id: cwd === '/work/a' ? 'a' : 'b' }),
    sampleMetrics: async () => { calls++; return { cpu: null, errors: [] }; },
    observeProcesses: async () => ({ agents: [{ threadId: 'thread-1', cwd: '/work/a', status: 'working' }, { threadId: 'external-1', cwd: '/work/b', status: 'unknown' }], complete: true }) };
  const collect = createOverviewCollector(options);
  const [first, second] = await Promise.all([collect(), collect()]);
  assert.equal(first, second); assert.equal(calls, 1); assert.equal(first.agents.length, 2);
  assert.equal(first.agents.find(a => a.threadId === 'thread-1').status, 'waitingApproval');
  assert.equal(first.agents.find(a => a.threadId === 'external-1').status, 'unknown');
  await collect(); assert.equal(calls, 1); now += 4000; await collect(); assert.equal(calls, 2);
});

test('external observation failure does not block resources or imply zero active agents', async () => {
  const collect = createOverviewCollector({ config: { projects: [] }, authorizedThreads: new Map(), activeTurns: new Map(), busy: new Set(), approvals: new Map(), sampleMetrics: async () => ({ memory: null, errors: [{ metric: 'memory' }] }), observeProcesses: async () => { throw Error('unavailable'); } });
  const result = await collect(); assert.equal(result.metrics.memory, null); assert.match(result.coverage.external, /不完整/);
});

test('fixed-project mode never exposes external agents from another project', async () => {
  const collect = createOverviewCollector({ config: { projects: [{ id: 'a', cwd: '/work/a' }] }, authorizedThreads: new Map(), activeTurns: new Map(), busy: new Set(), approvals: new Map(), sampleMetrics: async () => ({}), observeProcesses: async () => ({ agents: [{ threadId: 'foreign', cwd: '/private/other', status: 'working' }], complete: true }) });
  assert.deepEqual((await collect()).agents, []);
});

test('read-only external threads keep fresh observed status instead of old history locks', async () => {
  let now = 0, externalStatus = 'working';
  const collect = createOverviewCollector({ config: { projects: [], workspace: { roots: ['/'] } }, authorizedThreads: new Map([['external', '/work/a']]), loadedThreads: new Set(), activeTurns: new Map([['external', 'stale-turn']]), busy: new Set(['external']), approvals: new Map(), clock: () => now,
    sampleMetrics: async () => ({}), observeProcesses: async () => ({ agents: [{ threadId: 'external', pid: 10, cwd: '/work/a', status: externalStatus, source: 'external' }], complete: true }) });
  let data = await collect(); assert.equal(data.agents[0].status, 'working'); assert.equal(data.agents[0].source, 'external');
  externalStatus = 'idle'; now = 4000; data = await collect(); assert.equal(data.agents[0].status, 'idle');
});

test('unmapped live processes are unknown and reduce coverage without inventing a thread', async () => {
  const collect = createOverviewCollector({ config: { projects: [], workspace: { roots: ['/'] } }, authorizedThreads: new Map(), activeTurns: new Map(), busy: new Set(), approvals: new Map(), sampleMetrics: async () => ({}), observeProcesses: async () => ({ agents: [{ threadId: '', pid: 12, cwd: '/work/a', status: 'unknown' }, { threadId: '', pid: 13, cwd: '/work/a', status: 'unknown' }], complete: true, unmappedProcesses: 2 }), registerProject: async () => ({ id: 'a' }) });
  const result = await collect(); assert.equal(result.agents.length, 2); assert.equal(result.coverage.externalComplete, false); assert.equal(result.agents[0].canOpen, false);
});

test('a former relay thread reopened by an external process keeps current external activity', async () => {
  const collect = createOverviewCollector({ config: { projects: [], workspace: { roots: ['/'] } }, rpc: { child: { pid: 100 } }, authorizedThreads: new Map([['reopened', '/work/a']]), loadedThreads: new Set(['reopened']), activeTurns: new Map(), busy: new Set(), approvals: new Map(), sampleMetrics: async () => ({}),
    observeProcesses: async () => ({ agents: [{ threadId: 'reopened', pid: 200, cwd: '/work/a', status: 'working', source: 'external' }, { threadId: 'reopened', pid: 100, cwd: '/work/a', status: 'idle', source: 'external' }], complete: true }) });
  const data = await collect(); assert.equal(data.agents.length, 1); assert.equal(data.agents[0].status, 'working'); assert.equal(data.agents[0].source, 'external'); assert.equal(data.agents[0].pid, 200);
});
