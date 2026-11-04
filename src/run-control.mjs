import * as fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { observeCodexProcesses } from './overview.mjs';
import { createRuntimePlatform } from './runtimes.mjs';
import { fail } from './protocol.mjs';

const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const pidOK = value => Number.isSafeInteger(value) && value > 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const rank = { working: 0, waitingApproval: 1, idle: 2, unknown: 3 };
const status = value => Object.hasOwn(rank, value) ? value : 'unknown';
const pair = row => `${row.threadId}:${row.pid}`;
const publicTmux = value => value && ({ sessionId: value.sessionId, sessionName: value.sessionName, windowIndex: value.windowIndex, paneIndex: value.paneIndex, paneId: value.paneId, target: value.target });
const stopProcesses = `import os,sys,json,signal,ctypes,platform
if sys.platform!='linux': raise RuntimeError('Linux pidfds required')
native_open=getattr(os,'pidfd_open',None); native_send=getattr(signal,'pidfd_send_signal',None)
libc=None
if native_open is None or native_send is None:
 if platform.machine()!='x86_64': raise RuntimeError('Unsupported pidfd syscall architecture')
 libc=ctypes.CDLL(None,use_errno=True); libc.syscall.restype=ctypes.c_long
def syscall(number,*args):
 value=libc.syscall(ctypes.c_long(number),*args)
 if value<0: raise OSError(ctypes.get_errno(),'pidfd syscall failed')
 return value
def open_pidfd(pid):
 return native_open(pid,0) if native_open else syscall(434,ctypes.c_int(pid),ctypes.c_uint(0))
def terminate_pidfd(handle):
 if native_send: native_send(handle,signal.SIGTERM)
 else: syscall(424,ctypes.c_int(handle),ctypes.c_int(signal.SIGTERM),ctypes.c_void_p(),ctypes.c_uint(0))
expected=json.loads(sys.argv[1]); handles=[]
try:
 for item in expected:
  pid=item['pid']; handle=open_pidfd(pid); handles.append(handle)
  prefix='/proc/'+str(pid)
  stat=open(prefix+'/stat').read(); fields=stat[stat.rfind(')')+2:].split()
  command=open(prefix+'/cmdline','rb').read()[:-1].decode().split('\\0')
  if os.stat(prefix).st_uid!=os.getuid() or fields[19]!=item['startTicks'] or int(fields[1])!=item['ppid'] or os.readlink(prefix+'/exe')!=item['executable'] or command!=item['commandline']: raise RuntimeError('identity changed')
 for handle in handles: terminate_pidfd(handle)
 print('requested')
finally:
 for handle in handles: os.close(handle)
`;

// Manual close signals only identity-checked Codex processes through pidfds.
// It never invokes tmux or forwards process environments/arguments to browsers.
export function createRunControlPlatform({ filesystem = fs, exec, uid = () => process.getuid(), env = process.env, system = process.platform } = {}) {
  const execute = exec || promisify(execFile);
  const base = createRuntimePlatform({ filesystem, exec: execute, uid, env });
  const snapshotKey = snapshot => hash({ codex: snapshot.codex, processes: snapshot.processes });
  const capture = async row => {
    if (system !== 'linux' || !pidOK(row.pid)) fail(409, 'runtime_identity', '运行身份不完整，不能关闭。');
    const codex = await base.getProcess(row.pid);
    if (!codex || !/^codex(?: \(deleted\))?$/.test(basename(codex.executable))) fail(409, 'runtime_identity', 'Codex 进程身份无法核对。');
    const all = await base.processes(), subtree = new Set([codex.pid]);
    for (let changed = true; changed;) { changed = false; for (const process of all) if (subtree.has(process.ppid) && !subtree.has(process.pid)) { subtree.add(process.pid); changed = true; } }
    const targets = all.filter(process => subtree.has(process.pid)).sort((a, b) => a.pid - b.pid);
    if (!targets.some(process => base.processMatches(codex, process))) fail(409, 'runtime_identity', 'Codex 进程子树无法安全核对。');
    for (const process of targets) { const again = await base.getProcess(process.pid); if (!base.processMatches(process, again) || again.ppid !== process.ppid) fail(409, 'runtime_changed', '运行进程身份已改变，请重新预览。'); }
    return { row: copy(row), panes: [], codex, processes: targets };
  };
  return {
    capture,
    async close(snapshot) {
      const current = await capture(snapshot.row);
      if (snapshotKey(current) !== snapshotKey(snapshot)) fail(409, 'runtime_changed', '运行环境已改变，请重新预览。');
      let command;
      try { command = await execute('/usr/bin/python3', ['-I', '-c', stopProcesses, JSON.stringify(snapshot.processes)], { timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin' }, windowsHide: true }); }
      catch { return { status: 'unknown', reports: [{ phase: 'close', status: 'unknown' }] }; }
      try {
        let alive = false;
        for (let n = 0; n < 20; n++) {
          alive = false;
          for (const expected of snapshot.processes) { const process = await base.getProcess(expected.pid); if (process?.startTicks === expected.startTicks) alive = true; }
          if (!alive) break;
          if (n < 19) await new Promise(done => setTimeout(done, 25));
        }
        return { status: !alive ? 'closed' : 'partial', reports: [{ phase: 'close', status: command.stderr || command.stdout?.trim() !== 'requested' ? 'uncertain' : 'requested' }, { phase: 'verification', status: !alive ? 'closed' : 'partial' }] };
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
      if (agent.pid === observation.metadataPid || !pidOK(agent.pid) || rows.has(pair(agent))) continue;
      rows.set(pair(agent), { runtimeId: `manual-${hash([agent.threadId, agent.pid, agent.tmux?.sessionId, agent.tmux?.paneId]).slice(0, 32)}`, threadId: idOK(agent.threadId) ? agent.threadId : null, cwd: agent.cwd, name: agent.name, pid: agent.pid, status: status(agent.status), managed: false, keepRunning: false, canOpen: idOK(agent.threadId), tmuxState: ['attached', 'none'].includes(agent.tmuxState) ? agent.tmuxState : 'unknown', tmux: publicTmux(agent.tmux), lifecycle: { version: null, idleSince: null, terminalSavedAt: null, reason: 'external_runtime' } });
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
      const affectedPids = new Set(row.managed ? [row.pid] : snapshot.processes.map(process => process.pid));
      const affected = rows.filter(other => affectedPids.has(other.pid));
      const affectedThreads = [...new Map(affected.filter(item => idOK(item.threadId)).map(item => [item.threadId, { id: item.threadId, name: item.name || item.threadId }])).values()];
      const planId = `close-${randomBytes(24).toString('base64url')}`;
      const fingerprint = hash(affected.map(item => [item.runtimeId, item.threadId, item.pid, item.status]).sort());
      const plan = { row, snapshot, fingerprint, expiresAt: clock() + ttl, affectedThreads, executing: false, result: null }; plans.set(planId, plan);
      const codexPanes = new Set(affected.map(item => item.tmux?.paneId));
      return { planId, scope: row.managed ? 'pane' : 'process', session: row.tmux ? { id: row.tmux.sessionId, name: row.tmux.sessionName } : null, pane: row.tmux ? { id: row.tmux.paneId, target: row.tmux.target } : null, otherPanesPreserved: true, tmuxUntouched: !row.managed, affectedThreads, otherPanes: snapshot ? snapshot.panes.filter(pane => !codexPanes.has(pane.paneId)).map(pane => ({ paneId: pane.paneId, target: pane.target, label: '其他终端窗格' })) : [], working: affected.some(item => item.status === 'working' || item.status === 'waitingApproval'), requiresConfirmation: true, expiresAt: plan.expiresAt };
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
        const affectedPids = new Set(plan.row.managed ? [plan.row.pid] : plan.snapshot.processes.map(process => process.pid));
        const affected = rows.filter(other => affectedPids.has(other.pid));
        if (!row || hash(affected.map(item => [item.runtimeId, item.threadId, item.pid, item.status]).sort()) !== plan.fingerprint || (row.managed && row.revision !== plan.row.revision)) fail(409, 'runtime_changed', '运行环境已改变，请重新预览。');
        let result;
        if (row.managed) {
          try { const stopped = await rpc.stopRun(row.id, row.revision); result = { status: stopped?.stopped ? 'closed' : 'unknown' }; }
          catch (error) { if (error.code === 'runtime_changed') throw error; result = { status: 'unknown' }; }
        } else result = await platform.close(plan.snapshot);
        plan.result = { ...result, runtimeId: row.runtimeId, scope: row.managed ? 'pane' : 'process', archived: false, affected: plan.affectedThreads.map(thread => ({ ...thread, status: result.status === 'closed' ? 'closed' : 'unknown' })) };
        return copy(plan.result);
      } finally { plan.executing = false; }
    }
  };
}
