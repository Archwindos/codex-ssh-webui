import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, fail, validateTransportConfig, validateProtocolConfig } from './protocol.mjs';
import { createRuntimePlatform, runtimeError } from './runtimes.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(done => setTimeout(done, ms));
const methods = new Set(['thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt']);

// One worker owns one official app-server and exactly one durable Codex thread.
// Gateway sockets are observers/controllers; their close never closes this RPC.
export async function startRuntimeWorker({ runDir, clock = Date.now, platform = createRuntimePlatform({ root: dirname(dirname(dirname(runDir))), clock }), rpcFactory = config => new RpcClient(config, { mock: false, experimentalApi: true }), createIPCServer = createServer, workerPid = process.pid, env = process.env, onExit = () => {} } = {}) {
  const id = basename(runDir);
  if (!/^[a-f0-9]{16}$/.test(id) || resolve(runDir) !== platform.runDir(id)) fail(409, 'runtime_identity', 'runner 目录身份无法核对。');
  await platform.initialize();
  const launch = await platform.readJSON(join(runDir, 'launch.json'));
  if (launch.schemaVersion !== 1 || launch.id !== id || !['thread/start', 'thread/resume'].includes(launch.method) || launch.config?.transport !== 'local') fail(409, 'runtime_launch', 'runner 启动记录无效。');
  try { validateTransportConfig(launch.config); validateProtocolConfig(launch.config); }
  catch { fail(409, 'runtime_launch', 'runner 的 CLI 路径或协议验证记录无效。'); }
  let receipt;
  for (let n = 0; n < 100; n++) { try { receipt = await platform.readReceipt(id); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await wait(50); } }
  if (!receipt || receipt.worker.pid !== workerPid || !await platform.verify(receipt, { requireCodex: false }) || env.TMUX_PANE !== receipt.tmux.paneId || env.TMUX !== `${receipt.tmux.socket},${receipt.tmux.serverPid},${receipt.tmux.sessionId.slice(1)}`) fail(409, 'runtime_identity', 'runner 不在创建它的默认 tmux pane 中。');
  const rpc = rpcFactory(launch.config), sockets = new Set(), approvals = new Map(), events = [];
  let threadId = null, cwd = launch.params.cwd || null, status = 'unknown', activeTurnId = null, revision = 1, cursor = 0, server, closing = false, stopping = false;
  let idleSince = null, terminalSavedAt = null, lifecycleReason = 'unknown', inFlightWrites = 0, completedTurnId = null, lifecycleRead = null, unsupportedState = false;
  // A fresh worker starts a conservative activity window. Subsequent reads,
  // browser renewals and metadata notifications never advance this clock.
  let lastOutputAt = clock();
  const taskActivity = message => ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].includes(message.method) || /^item\/(agentMessage|reasoning|commandExecution|fileChange|mcpToolCall|dynamicToolCall)\//.test(message.method) && ['delta', 'text', 'message'].some(key => typeof message.params?.[key] === 'string' && message.params[key].length > 0);
  const touchActivity = () => { lastOutputAt = Math.max(lastOutputAt, clock()); };
  const childThreads = new Set(), activeItems = new Set(), observedOutput = new Map();
  let owner = { runId: id, worker: { pid: workerPid, startTicks: receipt.worker.startTicks }, codex: null };
  let persisting = Promise.resolve();
  const persist = extra => { const pending = persisting.then(async () => { receipt = { ...receipt, ...extra }; await platform.writeJSON(join(runDir, 'receipt.json'), receipt); }); persisting = pending.catch(() => {}); return pending; };
  const lifecycle = () => ({ version: 2, idleSince, terminalSavedAt, lastOutputAt, reason: lifecycleReason, inFlightWrites, activeItems: activeItems.size, childThreads: childThreads.size });
  const invalidateIdle = reason => { idleSince = null; terminalSavedAt = null; lifecycleReason = reason; };
  const snapshot = () => ({ runId: id, workerPid, workerStartTicks: receipt.worker.startTicks, pid: receipt.codex?.pid || null, threadId, cwd, status, activeTurnId, revision, cursor, lifecycle: lifecycle(), approvals: [...approvals.values()].map(clone) });
  const refreshLifecycle = async () => {
    if (lifecycleRead) return lifecycleRead;
    lifecycleRead = (async () => {
      if (!threadId || closing || stopping || status !== 'idle' || activeTurnId || approvals.size || inFlightWrites || activeItems.size || unsupportedState) { invalidateIdle('busy_or_unknown'); return; }
      const before = revision, visited = new Set();
      const savedIdle = async selected => {
        if (visited.has(selected)) return; if (visited.size >= 100) fail(409, 'runtime_children_unknown', '子会话状态无法完整核对。'); visited.add(selected);
        const read = await rpc.call('thread/read', { threadId: selected, includeTurns: true }), thread = read?.thread;
        if (thread?.id === selected && Array.isArray(thread.turns)) {
          // Child output is not guaranteed to be forwarded to this worker.
          // Compare task content, excluding thread metadata and read time.
          const signature = createHash('sha256').update(JSON.stringify(thread.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.items })))).digest('hex');
          const previous = observedOutput.get(selected);
          if (previous !== undefined && previous !== signature || previous === undefined && selected !== threadId && thread.turns.length) touchActivity();
          observedOutput.set(selected, signature);
        }
        if (thread?.id !== selected || thread.status?.type !== 'idle' || !Array.isArray(thread.turns)) fail(409, 'runtime_not_idle', '会话尚未确认空闲。');
        const latest = thread.turns.at(-1);
        if (latest && (!['completed', 'interrupted', 'failed'].includes(latest.status) || !Array.isArray(latest.items))) fail(409, 'runtime_turn_unsaved', '最后一轮尚未确认保存。');
        for (const turn of thread.turns) for (const item of turn.items || []) {
          if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && !['completed', 'failed', 'declined'].includes(item.status)) fail(409, 'runtime_command_active', '命令或工具操作状态未知。');
          if (item.type === 'collabAgentToolCall') {
            if (!Array.isArray(item.receiverThreadIds) || !['completed', 'failed'].includes(item.status)) fail(409, 'runtime_children_unknown', '子任务状态未知。');
            for (const child of item.receiverThreadIds) { if (!/^[A-Za-z0-9_-]{1,160}$/.test(child)) fail(409, 'runtime_children_unknown', '子会话身份未知。'); if (selected === threadId) childThreads.add(child); await savedIdle(child); }
          }
          if (item.type === 'subAgentActivity') {
            if (!/^[A-Za-z0-9_-]{1,160}$/.test(item.agentThreadId || '')) fail(409, 'runtime_children_unknown', '子会话身份未知。');
            if (selected === threadId) childThreads.add(item.agentThreadId); await savedIdle(item.agentThreadId);
          }
        }
      };
      try {
        await platform.cleanupIdentity(receipt);
        await savedIdle(threadId);
        for (const child of childThreads) await savedIdle(child);
        if (revision !== before || status !== 'idle' || activeTurnId || approvals.size || inFlightWrites || activeItems.size || closing || stopping) { invalidateIdle('changed_during_check'); return; }
        terminalSavedAt = clock(); idleSince ??= terminalSavedAt; lifecycleReason = null;
        await persist({ lifecycle: lifecycle() });
      } catch (error) { invalidateIdle(error.code || 'unknown'); }
    })().finally(() => { lifecycleRead = null; });
    return lifecycleRead;
  };
  const send = (socket, value) => { if (!socket.destroyed && !socket.write(JSON.stringify(value) + '\n')) socket.destroy(); };
  const emit = (event, data) => {
    revision++; const entry = { event, data, cursor: ++cursor }; events.push(entry); if (events.length > 500) events.shift();
    const message = { ...entry, snapshot: snapshot() };
    for (const socket of sockets) send(socket, message);
  };
  rpc.on('notification', message => {
    const p = message.params || {};
    if (!threadId || (p.threadId !== threadId && !childThreads.has(p.threadId))) return;
    if (taskActivity(message)) touchActivity();
    if (p.threadId !== threadId) { revision++; invalidateIdle('child_changed'); return; }
    if (message.method === 'turn/started') { activeTurnId = p.turn?.id || null; status = 'working'; invalidateIdle('active_turn'); }
    if (message.method === 'turn/completed') { completedTurnId = p.turn?.id || null; activeTurnId = null; status = 'idle'; approvals.clear(); invalidateIdle('terminal_save_pending'); }
    if (message.method === 'thread/status/changed') {
      if (p.status?.type === 'idle') status = 'idle';
      else if (p.status?.type === 'active') status = p.status.activeFlags?.includes('waitingOnApproval') ? 'waitingApproval' : 'working';
      else status = 'unknown';
      if (status !== 'idle') invalidateIdle('active_or_unknown');
    }
    if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'collabAgentToolCall', 'mcpToolCall', 'dynamicToolCall'].includes(p.item?.type)) { activeItems.add(p.item.id); invalidateIdle('active_item'); }
    if (message.method === 'item/completed') activeItems.delete(p.item?.id);
    if (p.item?.type === 'collabAgentToolCall') for (const child of p.item.receiverThreadIds || []) childThreads.add(child);
    if (p.item?.type === 'subAgentActivity') { childThreads.add(p.item.agentThreadId); invalidateIdle('child_changed'); }
    if (/requestUserInput|userInput|requestApproval/i.test(message.method)) invalidateIdle('pending_input');
    if (message.method === 'serverRequest/resolved') { approvals.delete(JSON.stringify(p.requestId)); if (!approvals.size && status === 'waitingApproval') status = activeTurnId ? 'working' : 'idle'; }
    emit('notification', message);
    if (status === 'idle') void refreshLifecycle();
  });
  rpc.on('approval', message => {
    if (!threadId || message.params?.threadId !== threadId) { try { rpc.answer(message.id, { decision: 'decline' }); } catch {} return; }
    approvals.set(JSON.stringify(message.id), clone(message)); status = 'waitingApproval'; activeTurnId ||= message.params?.turnId || null;
    touchActivity();
    invalidateIdle('pending_approval');
    emit('approval', message);
  });
  rpc.on('unsupported', () => { unsupportedState = true; invalidateIdle('unsupported_state'); emit('unsupported', null); });
  const finished = async () => {
    if (closing) return; closing = true; status = 'unknown';
    rpc.close();
    try { await persist({ closed: true }); if (threadId) await platform.releaseThread(threadId, owner); } catch { /* Unknown ownership is retained for explicit recovery. */ }
    for (const socket of sockets) socket.destroy(); server?.close(); onExit();
  };
  rpc.on('closed', finished);
  const request = async message => {
    if (message.op === 'hello') {
      await refreshLifecycle();
      const result = snapshot(), after = Number.isSafeInteger(message.cursor) ? message.cursor : 0;
      return { result: { ...result, resync: after > cursor || (events.length > 0 && after < events[0].cursor - 1) }, replay: message.replay ? events.filter(event => event.cursor > after) : [] };
    }
    if (message.op === 'prepareStop') {
      if (message.revision !== revision) fail(409, 'runtime_changed', '运行状态已改变，请重新预览。');
      stopping = true; return { result: { prepared: true } };
    }
    if (message.op === 'prepareIdleStop') {
      if (message.revision !== revision || closing || stopping) fail(409, 'runtime_changed', '运行状态已改变。');
      await refreshLifecycle();
      if (message.revision !== revision || lifecycleReason || idleSince === null || !Number.isFinite(message.idleMs) || message.idleMs < 0 || !Number.isFinite(lastOutputAt) || clock() - lastOutputAt < message.idleMs || inFlightWrites || approvals.size || activeTurnId || status !== 'idle') fail(409, 'runtime_not_idle', '运行尚未满足无新产出的空闲回收条件。');
      stopping = true; return { result: { prepared: true, revision, lifecycle: lifecycle() } };
    }
    if (message.op === 'confirmIdleStop') {
      if (!stopping || closing || message.revision !== revision || lifecycleReason || !Number.isFinite(message.idleMs) || clock() - lastOutputAt < message.idleMs || inFlightWrites || approvals.size || activeTurnId || activeItems.size || unsupportedState || status !== 'idle') fail(409, 'runtime_changed', '停止前出现新活动或状态改变，不会回收。');
      return { result: { prepared: true } };
    }
    if (message.op === 'cancelIdleStop') { if (!closing) stopping = false; return { result: { cancelled: true } }; }
    if (closing || stopping) fail(503, 'runtime_closed', '独立运行已结束或正在关闭。');
    if (message.op === 'answer') {
      const key = JSON.stringify(message.requestId);
      if (!approvals.has(key) || !['accept', 'decline'].includes(message.result?.decision)) fail(409, 'approval_unavailable', '该审批不属于这个运行，或已经处理。');
      await platform.admitted(threadId, owner, () => { if (closing || stopping) fail(409, 'runtime_closed', '运行正在关闭。'); touchActivity(); rpc.answer(message.requestId, { decision: message.result.decision }); return null; });
      approvals.delete(key); status = activeTurnId ? 'working' : 'idle'; revision++;
      return { result: { ok: true } };
    }
    if (message.op !== 'rpc' || !methods.has(message.method) || message.params?.threadId !== threadId) fail(403, 'runtime_thread_mismatch', '独立运行只能处理它自己的会话。');
    if (message.method === 'thread/resume') {
      await platform.admitted(threadId, owner, () => null);
      return { result: await rpc.call('thread/read', { threadId, includeTurns: !message.params.excludeTurns }) };
    }
    const params = message.method === 'turn/start' ? { ...message.params, effort: 'high' } : message.params;
    let result, dispatched = false;
    try {
      result = message.method.startsWith('turn/') ? await platform.admitted(threadId, owner, () => { if (closing || stopping) fail(409, 'runtime_closed', '运行正在关闭。'); dispatched = true; inFlightWrites++; touchActivity(); invalidateIdle('write_in_flight'); revision++; if (message.method === 'turn/start') status = 'working'; return rpc.call(message.method, params).finally(() => { inFlightWrites--; }); }) : await rpc.call(message.method, params);
    } catch (error) { if (dispatched && message.method === 'turn/start' && !activeTurnId) { status = 'unknown'; revision++; } throw error; }
    if (message.method === 'turn/start') { activeTurnId = result?.turn?.id === completedTurnId ? null : result?.turn?.id || activeTurnId; status = activeTurnId ? 'working' : 'idle'; revision++; }
    return { result };
  };
  try {
    if (launch.method === 'thread/resume') await platform.claimThread(launch.params.threadId, owner);
    await rpc.start();
    let codex;
    for (let n = 0; n < 50; n++) { codex = await platform.getProcess(rpc.child?.pid); if (codex && basename(codex.executable) === 'codex' && codex.ppid === workerPid && JSON.stringify(codex.commandline.slice(1)) === JSON.stringify(['app-server'])) break; codex = null; await wait(20); }
    if (!codex) fail(409, 'runtime_codex_identity', '官方 Codex 子进程无法核对。');
    owner = { ...owner, codex: { pid: codex.pid, startTicks: codex.startTicks } };
    if (launch.method === 'thread/resume') await platform.claimThread(launch.params.threadId, owner);
    const params = { ...launch.params, config: { ...launch.params.config, model_reasoning_effort: 'high' } };
    const result = await rpc.call(launch.method, params);
    threadId = result?.thread?.id; cwd = result?.thread?.cwd;
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(threadId || '') || typeof cwd !== 'string' || (launch.method === 'thread/resume' && threadId !== launch.params.threadId) || (launch.params.cwd && cwd !== launch.params.cwd)) fail(409, 'runtime_thread_mismatch', '官方会话身份或目录与运行不匹配。');
    await platform.claimThread(threadId, owner);
    status = result.thread.status?.type === 'idle' ? 'idle' : result.thread.status?.type === 'active' ? 'working' : 'unknown';
    await persist({ threadId, cwd, codex, closed: false });
    await refreshLifecycle();
    server = createIPCServer(socket => {
      sockets.add(socket); socket.setEncoding('utf8'); let buffer = '';
      socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
      socket.on('data', chunk => {
        buffer += chunk; if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          let message; try { message = JSON.parse(buffer.slice(0, index)); } catch { socket.destroy(); return; } buffer = buffer.slice(index + 1);
          if (!Number.isSafeInteger(message?.id) || message.id < 1) { socket.destroy(); return; }
          request(message).then(({ result, replay = [] }) => { send(socket, { id: message.id, result }); for (const event of replay) send(socket, event); }, error => send(socket, { id: message.id, error: runtimeError(error) }));
        }
      });
    });
    const path = join(runDir, 'control.sock');
    if (Buffer.byteLength(path) > 103) fail(500, 'runtime_socket_path', 'IPC 路径过长。');
    await new Promise((done, reject) => { server.once('error', reject); server.listen(path, done); });
    await platform.secureSocket(path);
    await persist({ ready: true });
    return { rpc, snapshot, request, server, close: () => rpc.close() };
  } catch (error) {
    await persist({ failure: /^[a-z_]{1,80}$/.test(error.code || '') ? error.code : 'runtime_initialization_failed' }).catch(() => {});
    rpc.close(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--run-dir') process.exitCode = 1;
  else {
    process.umask(0o077);
    startRuntimeWorker({ runDir: resolve(args[1]), onExit: () => { process.exitCode = 0; } }).then(worker => {
      for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, () => worker.close());
    }).catch(() => { process.exitCode = 1; });
  }
}
