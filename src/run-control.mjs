import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { observeCodexProcesses, parseTmuxPanes } from './overview.mjs';
import { createRuntimePlatform } from './runtimes.mjs';
import { fail } from './protocol.mjs';

const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const pidOK = value => Number.isSafeInteger(value) && value > 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const rank = { working: 0, waitingApproval: 1, idle: 2, unknown: 3 };
const status = value => Object.hasOwn(rank, value) ? value : 'unknown';
const pair = row => `${row.threadId}:${row.pid}`;
const paneFormat = '#{session_id}|#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}';
const publicTmux = value => value && ({ sessionId: value.sessionId, sessionName: value.sessionName, windowIndex: value.windowIndex, paneIndex: value.paneIndex, paneId: value.paneId, target: value.target });

// This platform is the only manual-runtime path that can invoke tmux. It never
// reads pane output or forwards process environments/arguments to the browser.
export function createRunControlPlatform({ filesystem = fs, exec, uid = () => process.getuid(), env = process.env, system = process.platform } = {}) {
  const base = createRuntimePlatform({ filesystem, ...(exec ? { exec } : {}), uid, env });
  const snapshotKey = snapshot => hash({ server: snapshot.server, session: snapshot.session, panes: snapshot.panes, codex: snapshot.codex });
  const capture = async row => {
    if (system !== 'linux' || !pidOK(row.pid) || !/^\$\d+$/.test(row.tmux?.sessionId || '') || !/^%\d+$/.test(row.tmux?.paneId || '')) fail(409, 'runtime_identity', '运行身份不完整，不能关闭。');
    const server = await base.serverState(null);
    const codex = await base.getProcess(row.pid);
    if (!codex || !/^codex(?: \(deleted\))?$/.test(basename(codex.executable))) fail(409, 'runtime_identity', 'Codex 进程身份无法核对。');
    const environment = await filesystem.readFile(`/proc/${row.pid}/environ`);
    if (environment.length > 65536) fail(409, 'runtime_identity', '运行环境身份不完整。');
    const entries = environment.toString('utf8').split('\0'), tmuxValues = entries.filter(value => value.startsWith('TMUX=')), paneValues = entries.filter(value => value.startsWith('TMUX_PANE='));
    const match = tmuxValues.length === 1 && /^TMUX=(\/[^,\0]{1,4096}),(\d+),(\d+)$/.exec(tmuxValues[0]);
    if (!match || paneValues.length !== 1 || match[1] !== server.socket || Number(match[2]) !== server.serverPid || match[3] !== row.tmux.sessionId.slice(1) || paneValues[0] !== `TMUX_PANE=${row.tmux.paneId}`) fail(409, 'runtime_socket', '仅支持身份已核对的默认 tmux socket；不会猜测其他运行环境。');
    const listed = await base.tmux(['list-panes', '-s', '-t', row.tmux.sessionId, '-F', paneFormat]);
    const parsed = parseTmuxPanes(listed.stdout);
    if (listed.code || listed.stderr || !parsed.length || parsed.length !== listed.stdout.split('\n').filter(Boolean).length || parsed.some(pane => pane.sessionId !== row.tmux.sessionId || pane.sessionName !== row.tmux.sessionName) || new Set(parsed.map(pane => pane.paneId)).size !== parsed.length) fail(409, 'runtime_identity', '整个 tmux 会话的窗格身份无法核对。');
    const panes = [];
    for (const pane of parsed) {
      const process = await base.getProcess(pane.panePid);
      if (!process) fail(409, 'runtime_identity', '窗格进程身份无法核对。');
      panes.push({ ...pane, process: { pid: process.pid, startTicks: process.startTicks, executable: process.executable } });
    }
    const target = panes.find(pane => pane.paneId === row.tmux.paneId);
    if (!target || target.target !== row.tmux.target) fail(409, 'runtime_identity', '目标窗格已改变。');
    const chain = [], seen = new Set(); let current = codex;
    while (current && chain.length < 64 && !seen.has(current.pid)) {
      chain.push(current); seen.add(current.pid);
      if (current.pid === target.panePid) break;
      current = current.ppid > 1 ? await base.getProcess(current.ppid) : null;
    }
    if (chain.at(-1)?.pid !== target.panePid) fail(409, 'runtime_identity', 'Codex 与默认 tmux 窗格的进程关系无法核对。');
    for (const process of chain) { const again = await base.getProcess(process.pid); if (!base.processMatches(process, again) || again.ppid !== process.ppid) fail(409, 'runtime_changed', '运行进程身份已改变，请重新预览。'); }
    for (const pane of panes) { const again = await base.getProcess(pane.panePid); if (!again || again.startTicks !== pane.process.startTicks || again.executable !== pane.process.executable) fail(409, 'runtime_changed', '窗格进程身份已改变，请重新预览。'); }
    await base.serverState(server);
    return { row: copy(row), server, session: { id: row.tmux.sessionId, name: row.tmux.sessionName }, panes: panes.sort((a, b) => a.paneId.localeCompare(b.paneId)), codex: { pid: codex.pid, startTicks: codex.startTicks } };
  };
  return {
    capture,
    async close(snapshot) {
      const current = await capture(snapshot.row);
      if (snapshotKey(current) !== snapshotKey(snapshot)) fail(409, 'runtime_changed', '运行环境已改变，请重新预览。');
      let command;
      try { command = await base.tmux(['kill-session', '-t', snapshot.session.id]); }
      catch { return { status: 'unknown', reports: [{ phase: 'close', status: 'unknown' }] }; }
      try {
        const server = await base.serverState(snapshot.server, true);
        let absent = !server;
        if (server) { const remaining = await base.tmux(['list-sessions', '-F', '#{session_id}']); if (remaining.code || remaining.stderr || remaining.stdout.split('\n').filter(Boolean).some(id => !/^\$\d+$/.test(id))) return { status: 'unknown' }; absent = !remaining.stdout.split('\n').includes(snapshot.session.id); }
        let alive = false;
        for (const pane of snapshot.panes) { const process = await base.getProcess(pane.panePid); if (process?.startTicks === pane.process.startTicks) alive = true; }
        const codex = await base.getProcess(snapshot.codex.pid); alive ||= codex?.startTicks === snapshot.codex.startTicks;
        return { status: absent && !alive ? 'closed' : 'partial', reports: [{ phase: 'close', status: command.code || command.stderr ? 'uncertain' : 'requested' }, { phase: 'verification', status: absent && !alive ? 'closed' : 'partial' }] };
      } catch { return { status: 'unknown', reports: [{ phase: 'verification', status: 'unknown' }] }; }
    }
  };
}

export function createRunControl({ rpc, observeProcesses = observeCodexProcesses, clock = Date.now, platform = createRunControlPlatform() } = {}) {
  if (!rpc?.listRuns || !rpc?.stopRun || typeof observeProcesses !== 'function') fail(500, 'runtime_configuration', '运行管理接口不完整。');
  const plans = new Map(), ttl = 120000;
  let lastCoverage = { externalComplete: false };
  const observe = async () => {
    const [managed, observed] = await Promise.all([rpc.listRuns(), Promise.resolve().then(observeProcesses).catch(() => ({ agents: [], complete: false }))]);
    if (!Array.isArray(managed) || !Array.isArray(observed?.agents)) fail(503, 'runtime_observation', '运行环境观测不完整。');
    const managedRows = managed.filter(run => idOK(run.id) && idOK(run.threadId) && pidOK(run.pid));
    const metadataPid = rpc.library?.child?.pid || rpc.child?.pid;
    // A completely enumerated process with no rollout descriptor is not a
    // holder of every conversation. Actual /proc enumeration failures remain
    // incomplete; manual writers can still race after this observation.
    return { managed: managedRows, agents: observed.agents, metadataPid, complete: managedRows.length === managed.length && observed.complete === true };
  };
  const rowsOf = observation => {
    const rows = new Map();
    for (const run of observation.managed) rows.set(pair(run), { ...run, runtimeId: run.id, rootThreadId: run.threadId, status: status(run.status), managed: true, canOpen: true, tmux: publicTmux(run.tmux) });
    for (const agent of observation.agents) {
      if (agent.pid === observation.metadataPid || !idOK(agent.threadId) || !pidOK(agent.pid) || agent.tmuxState !== 'attached' || rows.has(pair(agent))) continue;
      rows.set(pair(agent), { runtimeId: `manual-${hash([agent.threadId, agent.pid, agent.tmux?.sessionId, agent.tmux?.paneId]).slice(0, 32)}`, threadId: agent.threadId, cwd: agent.cwd, name: agent.name, pid: agent.pid, status: status(agent.status), managed: false, canOpen: true, tmuxState: 'attached', tmux: publicTmux(agent.tmux) });
    }
    return [...rows.values()].sort((a, b) => rank[a.status] - rank[b.status] || a.runtimeId.localeCompare(b.runtimeId));
  };
  const list = async () => { const observation = await observe(); lastCoverage = { externalComplete: observation.complete }; return rowsOf(observation); };
  const inspectWriters = async ids => {
    if (!Array.isArray(ids) || ids.some(id => !idOK(id))) fail(400, 'invalid_threads', '对话集合无效。');
    const selected = new Set(ids), observation = await observe(), holders = new Map();
    for (const run of observation.managed) if (selected.has(run.threadId)) holders.set(pair(run), { threadId: run.threadId, managed: true, runId: run.id, rootThreadId: run.threadId, pid: run.pid, status: status(run.status) });
    for (const agent of observation.agents) {
      if (agent.pid === observation.metadataPid || !selected.has(agent.threadId) || !pidOK(agent.pid) || holders.has(pair(agent))) continue;
      const run = observation.managed.find(run => run.pid === agent.pid);
      holders.set(pair(agent), { threadId: agent.threadId, managed: !!run, runId: run?.id || null, rootThreadId: run?.threadId || null, pid: agent.pid, status: status(agent.status) });
    }
    return { complete: observation.complete, holders: [...holders.values()] };
  };
  return {
    list, inspectWriters, coverage: () => ({ ...lastCoverage }),
    async isFrozen(threadId) {
      if (!idOK(threadId)) fail(400, 'invalid_thread', '对话 id 无效。');
      if (!rpc.platform?.root || typeof rpc.platform.readJSON !== 'function' || rpc.mock) return false;
      try { await rpc.platform.readJSON(join(rpc.platform.root, 'runtime', 'thread-freezes', `${threadId}.json`)); return true; }
      catch (error) { return error.code !== 'ENOENT'; }
    },
    async stopManagedRuns(ids, { holders = [] } = {}) {
      if (!Array.isArray(ids) || !ids.length || ids.some(id => !idOK(id)) || !Array.isArray(holders)) fail(400, 'invalid_threads', '停止集合无效。');
      const selected = new Set(ids), runs = await rpc.listRuns(), requested = new Map();
      for (const holder of holders) {
        const run = runs.find(run => run.id === holder.runId && run.pid === holder.pid && run.threadId === holder.rootThreadId);
        if (!holder.managed || !selected.has(holder.threadId) || !selected.has(holder.rootThreadId)) fail(409, 'archive_run_outside_scope', '写入者不在已确认的停止范围内。');
        if (!run) return { complete: false, receipts: [{ runId: holder.runId, rootThreadId: holder.rootThreadId, status: 'unknown' }] };
        requested.set(run.id, run);
      }
      const receipts = [];
      for (const run of requested.values()) {
        try { const result = await rpc.stopRun(run.id, run.revision); receipts.push({ runId: run.id, rootThreadId: run.threadId, status: result?.stopped === true ? 'stopped' : 'unknown' }); }
        catch { receipts.push({ runId: run.id, rootThreadId: run.threadId, status: 'unknown' }); }
      }
      return { complete: receipts.every(row => row.status === 'stopped'), receipts };
    },
    async previewClose(runtimeId) {
      for (const [id, plan] of plans) if (clock() >= plan.expiresAt && !plan.executing) plans.delete(id);
      if (plans.size >= 100) fail(429, 'runtime_plan_limit', '关闭预览过多，请稍后重试。');
      const rows = await list(), row = rows.find(row => row.runtimeId === runtimeId);
      if (!row) fail(404, 'runtime_missing', '未找到该运行环境，请刷新。');
      const snapshot = row.managed ? null : await platform.capture(row);
      const affected = rows.filter(other => row.managed ? other.pid === row.pid : other.tmux?.sessionId === row.tmux.sessionId && other.tmux?.sessionName === row.tmux.sessionName);
      const affectedThreads = [...new Map(affected.map(item => [item.threadId, { id: item.threadId, name: item.name || item.threadId }])).values()];
      const planId = `close-${randomBytes(24).toString('base64url')}`;
      const fingerprint = hash(affected.map(item => [item.runtimeId, item.threadId, item.pid, item.status]).sort());
      const plan = { row, snapshot, fingerprint, expiresAt: clock() + ttl, affectedThreads, executing: false, result: null }; plans.set(planId, plan);
      const codexPanes = new Set(affected.map(item => item.tmux?.paneId));
      return { planId, scope: row.managed ? 'pane' : 'session', session: { id: row.tmux.sessionId, name: row.tmux.sessionName }, ...(row.managed ? { pane: { id: row.tmux.paneId, target: row.tmux.target }, otherPanesPreserved: true } : {}), affectedThreads, otherPanes: snapshot ? snapshot.panes.filter(pane => !codexPanes.has(pane.paneId)).map(pane => ({ paneId: pane.paneId, target: pane.target, label: '其他终端窗格' })) : [], working: affected.some(item => item.status === 'working' || item.status === 'waitingApproval'), requiresConfirmation: true, expiresAt: plan.expiresAt };
    },
    async close(planId) {
      const plan = plans.get(planId);
      if (!plan) fail(404, 'runtime_plan_missing', '关闭预览不存在，请重新预览。');
      if (plan.result) return copy(plan.result);
      if (plan.executing) fail(409, 'runtime_close_pending', '关闭操作正在执行，不会重复发送。');
      if (clock() >= plan.expiresAt) fail(409, 'runtime_plan_expired', '关闭预览已过期，请重新预览。');
      plan.executing = true;
      try {
        const rows = await list(), row = rows.find(row => row.runtimeId === plan.row.runtimeId);
        const affected = rows.filter(other => plan.row.managed ? other.pid === plan.row.pid : other.tmux?.sessionId === plan.row.tmux.sessionId && other.tmux?.sessionName === plan.row.tmux.sessionName);
        if (!row || hash(affected.map(item => [item.runtimeId, item.threadId, item.pid, item.status]).sort()) !== plan.fingerprint || (row.managed && row.revision !== plan.row.revision)) fail(409, 'runtime_changed', '运行环境已改变，请重新预览。');
        let result;
        if (row.managed) {
          try { const stopped = await rpc.stopRun(row.id, row.revision); result = { status: stopped?.stopped ? 'closed' : 'unknown' }; }
          catch (error) { if (error.code === 'runtime_changed') throw error; result = { status: 'unknown' }; }
        } else result = await platform.close(plan.snapshot);
        plan.result = { ...result, runtimeId: row.runtimeId, scope: row.managed ? 'pane' : 'session', archived: false, affected: plan.affectedThreads.map(thread => ({ ...thread, status: result.status === 'closed' ? 'closed' : 'unknown' })) };
        return copy(plan.result);
      } finally { plan.executing = false; }
    }
  };
}
