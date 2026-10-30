import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, RelayError, fail, safeThread, safeTurn, safeItem, safeThreadStatus, THREAD_SOURCE_KINDS, validateProduction, accessMode } from './protocol.mjs';
import { validateWorkspaceConfig, createWorkspaceBrowser, createProjectRegistry } from './workspace.mjs';
import { createOverviewCollector, observeCodexProcesses } from './overview.mjs';
import { RuntimeRpc } from './runtimes.mjs';
import { createRunControl } from './run-control.mjs';
import { createArchiveService } from './library.mjs';
import { createDeviceAuth } from './devices.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');
const token = () => randomBytes(32).toString('base64url');
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const short = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const fields = (obj, required, optional = []) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).some(k => !required.includes(k) && !optional.includes(k)) || required.some(k => !Object.hasOwn(obj, k))) fail(400, 'invalid_parameters', '请求参数不符合白名单。');
};
export function validateConfig(config, mock, env = process.env) {
  if (!config || !Array.isArray(config.projects) || !config.projects.length || config.projects.length > 20) fail(500, 'configuration', '配置需要 1–20 个固定项目。');
  accessMode(config);
  validateWorkspaceConfig(config, mock);
  if (config.eventTransport !== undefined && !['sse', 'poll'].includes(config.eventTransport)) fail(500, 'configuration', '事件传输配置必须为 sse 或 poll。');
  if (config.tls !== undefined) {
    const tls = config.tls;
    const localPath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) && !/^(?:\\\\|\/\/)/.test(value) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value));
    if (!tls || typeof tls !== 'object' || Array.isArray(tls) || Object.keys(tls).length !== 2 || !Object.hasOwn(tls, 'keyFile') || !Object.hasOwn(tls, 'certFile') || !localPath(tls.keyFile) || !localPath(tls.certFile)) fail(500, 'tls_configuration', 'TLS 配置需要且仅接受本地绝对路径 keyFile 和 certFile。');
  }
  const ids = new Set();
  for (const p of config.projects) {
    if (!identifier(p.id) || (config.workspace && p.id === 'all') || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(p.name) || typeof p.cwd !== 'string' || /[\u0000-\u001f\u007f]/.test(p.cwd) || (config.workspace ? !isAbsolute(p.cwd) : (!p.cwd.startsWith('/') || p.cwd === '/' || posix.normalize(p.cwd) !== p.cwd || p.cwd.endsWith('/')))) fail(500, 'configuration', '项目 id、名称或绝对 cwd 无效。');
    ids.add(p.id);
  }
  if (!mock) validateProduction(config, env);
  return config;
}

export async function createRelay({ mock = true, config = { projects: [{ id: 'home', name: '模拟工作区', cwd: '/workspace' }] }, env = process.env, port = 8787, rpc: suppliedRpc, overviewCollector, observeExternalThreads, projectStoreFile, runtimeManagement, runControl: suppliedRunControl, archiveService: suppliedArchive, archiveStoreFile, deviceAuthentication, deviceAuth: suppliedDeviceAuth, deviceStoreFile, devicePairingsDir, clock = Date.now, sessionTtlMs = 12 * 60 * 60 * 1000, idleTtlMs = 30 * 60 * 1000, maintenanceMs = 15000 } = {}) {
  validateConfig(config, mock, env);
  const loopbackHttp = accessMode(config) === 'ssh-loopback-http';
  const deviceAuthEnabled = deviceAuthentication ?? (!mock && loopbackHttp && (!suppliedRpc || Boolean(suppliedDeviceAuth) || deviceStoreFile !== undefined));
  if (deviceAuthEnabled && !loopbackHttp) fail(500, 'device_configuration', '受信浏览器认证只用于当前 SSH 回环入口。');
  const devices = deviceAuthEnabled ? suppliedDeviceAuth || await createDeviceAuth({ storeFile: deviceStoreFile === undefined ? resolve(ROOT, 'runtime', 'device-auth.json') : deviceStoreFile, pairingsDir: devicePairingsDir === undefined ? resolve(ROOT, 'runtime', 'device-pairings') : devicePairingsDir, clock,
    authorizeSession: ({ sessionId, origin }, isActiveDevice) => {
      const current = sessions.get(sessionId);
      return Boolean(current?.authenticated && !expired(current) && current.origin === origin && (!current.deviceId || isActiveDevice(current.deviceId)));
    }
  }) : null;
  await devices?.ready;
  let tlsOptions;
  if (config.tls) {
    try {
      const [key, cert] = await Promise.all([readFile(config.tls.keyFile), readFile(config.tls.certFile)]);
      tlsOptions = { key, cert };
    } catch { fail(500, 'tls_configuration', 'TLS 证书或私钥无法读取或无效。'); }
  }
  const runtimeMode = runtimeManagement ?? (!mock && config.transport === 'local' && Boolean(config.workspace) && (!suppliedRpc || suppliedRpc instanceof RuntimeRpc));
  const rpc = suppliedRpc || (runtimeMode ? new RuntimeRpc(config) : new RpcClient(config, { mock }));
  const workspace = config.workspace ? await createWorkspaceBrowser(config.workspace) : null;
  const registry = workspace ? await createProjectRegistry(config.projects, { workspace, storeFile: projectStoreFile === undefined ? (!mock ? resolve(ROOT, 'runtime', 'projects.json') : null) : projectStoreFile }) : null;
  const projects = registry?.projects || new Map(config.projects.map(p => [p.id, { id: p.id, name: p.name, cwd: p.cwd, revision: 1, managed: false }]));
  const canonicalProject = async cwd => workspace ? workspace.canonical(cwd) : (config.projects.find(p => p.cwd === cwd)?.cwd || fail(403, 'workspace_forbidden', '工作目录不在固定项目白名单内。'));
  const registerProject = async value => {
    if (registry) return registry.register(value);
    const cwd = await canonicalProject(value);
    return [...projects.values()].find(p => p.cwd === cwd);
  };
  const sessions = new Map(), streams = new Map(), polls = new Map(), approvals = new Map(), answered = new Set();
  const authorizedThreads = new Map(), loadedThreads = new Set(), submissions = new Map(), cursors = new Map(), busy = new Set(), activeTurns = new Map();
  const threadNames = new Map();
  const archiveMembership = new Map();
  const pendingTurns = new Set();
  let recoveringRuntimes = false;
  const recoveryApprovals = new Map();
  const externalThreads = new Map();
  const observeExternal = observeExternalThreads || (!mock && config.transport === 'local' ? observeCodexProcesses : async () => ({ agents: [], complete: true }));
  const runControl = runtimeMode ? suppliedRunControl || createRunControl({ rpc, observeProcesses: observeExternal, clock }) : null;
  const archiveOwner = createHash('sha256').update(env.RELAY_ACCESS_SECRET || 'local-mock-account').digest('hex');
  const archive = runtimeMode ? suppliedArchive || createArchiveService({ rpc, authoritativeDescendants: true, inspectWriters: ids => runControl.inspectWriters(ids), stopManagedRuns: (ids, options) => runControl.stopManagedRuns(ids, options), freezeThreads: (ids, op) => rpc.freezeThreads(ids, op), releaseFrozenThreads: (ids, op) => rpc.releaseThreads(ids, op), storeFile: archiveStoreFile === undefined ? (!mock ? resolve(ROOT, 'runtime', 'archive-operations.json') : null) : archiveStoreFile, clock }) : null;
  const refreshExternalThreads = async () => {
    let observed;
    try { observed = await observeExternal(); } catch { observed = { agents: [], complete: false }; }
    if (!Array.isArray(observed?.agents)) observed = { agents: [], complete: false };
    const holders = new Map();
    const managed = runtimeMode ? await rpc.listRuns() : [];
    for (const agent of observed.agents) {
      if (!identifier(agent?.threadId) || !Number.isSafeInteger(agent.pid) || agent.pid <= 0 || agent.pid === rpc.child?.pid) continue;
      if (managed.some(run => run.threadId === agent.threadId && run.pid === agent.pid)) continue;
      if (!holders.has(agent.threadId)) holders.set(agent.threadId, new Set());
      holders.get(agent.threadId).add(agent.pid);
    }
    // Partial/failed observations can add evidence, never erase a known writer.
    if (observed.complete === true) externalThreads.clear();
    for (const [threadId, pids] of holders) externalThreads.set(threadId, new Set([...(externalThreads.get(threadId) || []), ...pids]));
    return observed;
  };
  const rejectExternalWriter = threadId => { if (externalThreads.has(threadId)) fail(409, 'external_thread_open', '该会话仍在原 Codex 客户端中打开，请先关闭原客户端，再重新打开会话。'); };
  const baseOverview = overviewCollector || createOverviewCollector({ config, rpc, authorizedThreads, loadedThreads, threadNames, activeTurns, busy, approvals, clock, mock, projects, registerProject, canonicalProject, observeProcesses: runtimeMode ? async () => ({ agents: [], complete: true }) : refreshExternalThreads });
  let runtimeCache, runtimePending, runtimeEpoch = 0;
  const invalidateRuntimes = () => { runtimeCache = null; runtimeEpoch++; };
  const runtimeRows = async () => {
    if (runtimeCache && clock() - runtimeCache.at < 500) return runtimeCache.rows;
    if (runtimePending?.epoch === runtimeEpoch) return runtimePending.promise;
    const epoch = runtimeEpoch;
    const promise = (async () => {
    const value = await runControl.list();
    const rows = Array.isArray(value) ? value : value.data || [];
    const result = await Promise.all(rows.map(async row => {
      let p; try { p = await registerProject(row.cwd); } catch { /* Library remains readable when cwd disappears. */ }
      return { ...row, runtimeId: row.runtimeId || row.id, name: threadNames.get(row.threadId) || row.name || `${row.cwd?.split('/').pop() || 'Codex'} · ${row.threadId?.slice(0, 8)}`, projectId: p?.id || null, canOpen: identifier(row.threadId) };
    }));
    if (runtimeEpoch === epoch) runtimeCache = { at: clock(), rows: result }; return result;
    })().finally(() => { if (runtimePending?.epoch === epoch) runtimePending = null; });
    runtimePending = { epoch, promise }; return promise;
  };
  const collectOverview = async () => { const value = await baseOverview(); return runtimeMode ? { ...value, agents: await runtimeRows(), coverage: runControl.coverage?.() || value.coverage } : value; };
  let loginTries = [];
  const events = []; let nextEvent = 0, requests = 0, starting, upstreamClosed = false;
  let origin, expectedOrigin;
  const upstreamStatus = () => upstreamClosed || rpc.ended ? 'closed' : rpc.connected ? 'connected' : 'idle';
  const expired = session => !session || clock() - session.created >= sessionTtlMs || clock() - session.lastSeen >= idleTtlMs;
  const removeSession = sid => {
    sessions.delete(sid);
    for (const [res, streamSid] of streams) if (streamSid === sid) { res.end(); streams.delete(res); }
    for (const poll of polls.values()) if (poll.sid === sid) poll.finish(401, { error: { code: 'session_required', message: '本地会话已退出或过期，请重新登录。' } });
  };
  const cleanSessions = () => { for (const [sid, session] of sessions) if (expired(session)) removeSession(sid); };
  const eventPage = cursor => {
    const resync = cursor > nextEvent || (events.length > 0 && cursor < events[0].id - 1);
    return { events: resync ? [] : events.filter(entry => entry.id > cursor), cursor: nextEvent, resync, upstreamStatus: upstreamStatus() };
  };
  const checkEventConnections = sid => {
    if (streams.size + polls.size >= 12 || [...streams.values()].filter(value => value === sid).length + [...polls.values()].filter(value => value.sid === sid).length >= 2) fail(429, 'stream_limit', '事件连接过多。');
  };
  const push = (event, data) => {
    const entry = { id: ++nextEvent, event, data }; events.push(entry);
    if (events.length > 300) events.shift();
    const frame = `id: ${entry.id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [res, sid] of streams) { if (expired(sessions.get(sid))) { removeSession(sid); continue; } if (!res.write(frame)) { res.end(); streams.delete(res); } }
    for (const poll of polls.values()) { if (expired(sessions.get(poll.sid))) removeSession(poll.sid); else poll.finish(200, eventPage(poll.cursor)); }
  };
  const safeApproval = message => {
    const p = message.params || {};
    return { id: String(message.id), method: message.method, params: { threadId: short(p.threadId), turnId: short(p.turnId), itemId: short(p.itemId), command: short(p.command, 2000), cwd: short(p.cwd, 1000), reason: short(p.reason, 2000), grantRoot: short(p.grantRoot, 1000), ...(p.networkApprovalContext ? { networkApprovalContext: { host: short(p.networkApprovalContext.host, 1000), protocol: short(p.networkApprovalContext.protocol, 100) } } : {}) } };
  };
  const handleApproval = message => {
    const p = message.params || {}, threadCwd = authorizedThreads.get(p.threadId);
    if (approvals.has(String(message.id)) || answered.has(String(message.id))) return;
    if (!threadCwd || !identifier(p.turnId) || !identifier(p.itemId) || activeTurns.get(p.threadId) !== p.turnId || (p.cwd && p.cwd !== threadCwd) || approvals.size >= 100) {
      try { Promise.resolve(rpc.answer(message.id, { decision: 'decline' })).catch(() => {}); } catch { /* already disconnected */ }
      answered.add(String(message.id));
      push('relay', { status: 'warning', message: '拒绝了不属于当前已核对会话的审批请求。' }); return;
    }
    const entry = safeApproval(message); approvals.set(entry.id, { ...entry, rpcId: message.id }); push('approval', entry);
  };
  rpc.on('approval', message => {
    if (runtimeMode && recoveringRuntimes) { if (recoveryApprovals.size < 100) recoveryApprovals.set(String(message.id), message); return; }
    handleApproval(message);
  });
  rpc.on('unsupported', () => push('relay', { status: 'warning', message: '已安全拒绝不支持的服务器请求。' }));
  rpc.on('closed', () => { upstreamClosed = true; approvals.clear(); busy.clear(); activeTurns.clear(); loadedThreads.clear(); push('relay', { status: 'disconnected', message: '连接已关闭；待审批已清空。未自动重发消息。' }); });
  rpc.on('runtimeClosed', ({ threadId }) => { loadedThreads.delete(threadId); busy.delete(threadId); activeTurns.delete(threadId); for (const [id, approval] of approvals) if (approval.params.threadId === threadId) approvals.delete(id); push('relay', { status: 'runtime-closed', threadId, message: '运行环境已断开；对话仍保留在对话库。' }); });
  rpc.on('notification', message => {
    const p = message.params || {};
    if (message.method === 'thread/started') {
      // Only start/resume request responses establish ownership. Unsolicited threads never do.
      return;
    }
    if (!authorizedThreads.has(p.threadId)) return;
    if (message.method === 'serverRequest/resolved') { const id = String(p.requestId); const a = approvals.get(id); if (a?.params.threadId === p.threadId) { approvals.delete(id); answered.add(id); push('rpc', { method: message.method, params: { threadId: p.threadId, requestId: id } }); } return; }
    let params;
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      params = { threadId: short(p.threadId), turn: safeTurn(p.turn) };
      if (message.method === 'turn/started') { if (!identifier(p.turn?.id)) return; activeTurns.set(p.threadId, p.turn.id); busy.add(p.threadId); }
      if (message.method === 'turn/completed') {
        busy.delete(p.threadId); activeTurns.delete(p.threadId);
        for (const [id, approval] of approvals) if (approval.params.turnId === p.turn?.id && approval.params.threadId === p.threadId) { approvals.delete(id); answered.add(id); }
      }
    } else if (['item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(message.method)) {
      params = { threadId: short(p.threadId), turnId: short(p.turnId), itemId: short(p.itemId), delta: short(p.delta, 20000) };
      if (message.method === 'item/reasoning/summaryTextDelta') { if (!Number.isSafeInteger(p.summaryIndex) || p.summaryIndex < 0 || p.summaryIndex > 1000) return; params.summaryIndex = p.summaryIndex; }
      if (message.method === 'item/reasoning/textDelta' && Number.isSafeInteger(p.contentIndex) && p.contentIndex >= 0 && p.contentIndex <= 1000) params.contentIndex = p.contentIndex;
    }
    else if (message.method === 'item/reasoning/summaryPartAdded') { if (!Number.isSafeInteger(p.summaryIndex) || p.summaryIndex < 0 || p.summaryIndex > 1000) return; params = { threadId: short(p.threadId), turnId: short(p.turnId), itemId: short(p.itemId), summaryIndex: p.summaryIndex }; }
    else if (message.method === 'thread/status/changed') params = { threadId: short(p.threadId), status: safeThreadStatus(p.status) };
    else if (message.method === 'turn/plan/updated') params = { threadId: short(p.threadId), turnId: short(p.turnId), explanation: short(p.explanation, 2000), plan: (Array.isArray(p.plan) ? p.plan : []).slice(0, 100).map(step => ({ step: short(step?.step, 2000), status: ['pending', 'inProgress', 'completed'].includes(step?.status) ? step.status : 'pending' })) };
    else if (message.method === 'item/commandExecution/outputDelta') params = { threadId: short(p.threadId), turnId: short(p.turnId), itemId: short(p.itemId), delta: short(p.delta, 20000) };
    else if (message.method === 'item/started' || message.method === 'item/completed') params = { threadId: short(p.threadId), turnId: short(p.turnId), item: safeItem(p.item) };
    else return;
    push('rpc', { method: message.method, params });
  });
  const ensureConnected = async () => {
    if (upstreamStatus() === 'closed') fail(503, 'disconnected', '连接已关闭；请重启 relay 后检查历史。不会自动重连或重发。');
    if (starting) { await starting; return; }
    if (rpc.connected) return;
    if (!starting) starting = (async () => {
      recoveringRuntimes = runtimeMode;
      await rpc.start();
      if (runtimeMode) {
        const runs = await rpc.listRuns();
        for (const run of runs) {
          authorizedThreads.set(run.threadId, run.cwd); loadedThreads.add(run.threadId);
          if (run.activeTurnId) { activeTurns.set(run.threadId, run.activeTurnId); busy.add(run.threadId); }
        }
        recoveringRuntimes = false;
        for (const message of recoveryApprovals.values()) handleApproval(message);
        recoveryApprovals.clear();
        for (const run of runs) await rpc.replayThread(run.threadId);
      }
    })().catch(error => { recoveringRuntimes = false; recoveryApprovals.clear(); rpc.close(); throw error; });
    await starting;
  };
  const project = id => projects.get(id) || fail(400, 'project_forbidden', '项目尚未登记。');
  const selectedProject = async id => {
    const p = project(id);
    if (!workspace) return p;
    const cwd = await canonicalProject(p.cwd); return { ...p, cwd };
  };
  const threadMetadata = async (thread, archived = thread?.archived === true) => {
    const readOnly = externalThreads.has(thread?.id);
    const result = { ...safeThread(thread), readOnly, ...(readOnly ? { readOnlyReason: 'external_thread_open' } : {}), ...(runtimeMode ? { archived, historyReadable: true, runtimes: (await runtimeRows()).filter(row => row.threadId === thread.id), archiveFrozen: await runControl.isFrozen?.(thread.id) || false } : {}) };
    if (identifier(result.id) && (result.name || result.preview)) {
      threadNames.set(result.id, result.name || result.preview.slice(0, 100));
      if (threadNames.size > 1000) threadNames.delete(threadNames.keys().next().value);
    }
    if (!workspace) return result;
    try { const p = await registerProject(thread?.cwd); return { ...result, cwd: p.cwd, projectId: p.id }; }
    catch { return { ...result, projectId: null, unavailable: true }; }
  };
  const owned = async (projectId, threadId, resume = false) => {
    const p = await selectedProject(projectId);
    if (!identifier(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    await ensureConnected();
    const result = await rpc.call('thread/read', { threadId, includeTurns: false });
    let cwd;
    try { cwd = workspace ? await canonicalProject(result?.thread?.cwd) : result?.thread?.cwd; } catch { /* unavailable directories are not an alternate project */ }
    if (!result?.thread || result.thread.id !== threadId || cwd !== p.cwd) { authorizedThreads.delete(threadId); loadedThreads.delete(threadId); fail(403, 'cwd_mismatch', '该会话不属于所选项目，或工作目录已不可访问。'); }
    if (runtimeMode) {
      if (!(await rpc.listRuns()).some(run => run.threadId === threadId)) fail(409, 'runtime_required', '请先将此对话加入运行区。');
      if (await libraryArchived(threadId, true, true)) fail(409, 'thread_archived', '此对话已归档，可阅读历史。');
      authorizedThreads.set(threadId, cwd); loadedThreads.add(threadId); return result.thread;
    }
    if (resume) {
      await refreshExternalThreads();
      if (externalThreads.has(threadId)) { authorizedThreads.set(threadId, p.cwd); return result.thread; }
    }
    // Viewing an externally active thread must not load or take over its execution.
    if (workspace && result.thread.status?.type === 'active') { authorizedThreads.set(threadId, p.cwd); return result.thread; }
    if (resume && !loadedThreads.has(threadId)) {
      const result2 = await rpc.call('thread/resume', { threadId, ...(!workspace ? { cwd: p.cwd } : {}), excludeTurns: true, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
      let resumedCwd;
      try { resumedCwd = workspace ? await canonicalProject(result2?.thread?.cwd) : result2?.thread?.cwd; } catch { /* deny a changed directory */ }
      if (!result2?.thread || result2.thread.id !== threadId || resumedCwd !== p.cwd) { authorizedThreads.delete(threadId); loadedThreads.delete(threadId); fail(403, 'cwd_mismatch', '恢复会话的工作目录不匹配。'); }
      authorizedThreads.set(threadId, p.cwd); loadedThreads.add(threadId); return result2.thread;
    }
    authorizedThreads.set(threadId, p.cwd); return result.thread;
  };
  const libraryArchived = async (threadId, fresh = false, allowLoadedDraft = false) => {
    if (!fresh && archiveMembership.has(threadId)) return archiveMembership.get(threadId);
    for (const archived of [false, true]) {
      let cursor = null; const seen = new Set();
      for (let page = 0; page < 100; page++) {
        const result = await rpc.call('thread/list', { archived, cursor, limit: 100, sourceKinds: THREAD_SOURCE_KINDS });
        if (!Array.isArray(result?.data) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) fail(502, 'library_incomplete', '无法完整核验对话库状态。');
        for (const item of result.data) if (identifier(item?.id)) archiveMembership.set(item.id, archived);
        if (result.data.some(item => item.id === threadId)) return archived;
        cursor = result.nextCursor;
        if (!cursor) break;
        if (seen.has(cursor) || page === 99) fail(409, 'library_incomplete', '对话库状态未完整核验，请稍后重试。');
        seen.add(cursor);
      }
    }
    if (allowLoadedDraft) return null;
    fail(404, 'thread_not_in_library', '对话不在当前账号的对话库中。');
  };
  const readLibraryThread = async (threadId, fresh = false) => {
    if (!identifier(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    await ensureConnected();
    const result = await rpc.call('thread/read', { threadId, includeTurns: false });
    if (result?.thread?.id !== threadId) fail(502, 'protocol_mismatch', '对话身份无法核对。');
    const loaded = (await rpc.listRuns()).some(run => run.threadId === threadId);
    const archived = await libraryArchived(threadId, fresh, loaded);
    return { ...result.thread, archived: archived === true, unpersisted: archived === null };
  };
  const historyPage = async (threadId, cursor) => {
    const result = await rpc.call('thread/turns/list', { threadId, limit: 20, cursor: cursor || null, itemsView: 'full', sortDirection: 'desc' });
    if (!Array.isArray(result?.data) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) fail(502, 'protocol_mismatch', '历史分页 schema 不匹配。');
    const turns = result.data.map(safeTurn).reverse();
    if (!cursor && loadedThreads.has(threadId) && !externalThreads.has(threadId) && !pendingTurns.has(threadId)) {
      const active = turns.find(t => t.status === 'inProgress');
      if (active) { activeTurns.set(threadId, active.id); busy.add(threadId); }
      else { activeTurns.delete(threadId); busy.delete(threadId); }
    }
    return { turns, nextCursor: result.nextCursor || null };
  };
  const historyCursor = (projectId, threadId, remoteCursor) => { if (!remoteCursor) return null; const value = token(); cursors.set(value, { kind: 'history', projectId, threadId, remoteCursor }); if (cursors.size > 300) cursors.delete(cursors.keys().next().value); return value; };
  const snapshot = async (session, sid) => ({ mode: mock ? 'mock' : 'production', authenticated: session.authenticated, csrf: session.csrf, ...(loopbackHttp ? { authTransport: 'bearer', ...(sid ? { sessionToken: sid } : {}) } : {}), connected: upstreamStatus() === 'connected', upstreamStatus: upstreamStatus(), eventTransport: loopbackHttp ? 'poll' : config.eventTransport || 'sse', eventCursor: session.authenticated ? nextEvent : 0, projects: session.authenticated ? [...projects.values()] : [], capabilities: { workspaceBrowser: Boolean(workspace) && session.authenticated, projectManagement: Boolean(registry) && session.authenticated, allThreads: Boolean(workspace) && session.authenticated, overview: true, ...(runtimeMode ? { runtimeManagement: session.authenticated, archiveManagement: session.authenticated, library: session.authenticated } : {}), ...(devices ? { deviceAuthentication: true } : {}) }, ...(devices ? { trustedDevice: session.authenticated && session.deviceId ? await devices.status(session.deviceId) : null } : {}), ...(workspace && session.authenticated ? { workspace: { roots: workspace.roots, defaultCwd: workspace.defaultCwd } } : {}), pendingApprovals: session.authenticated ? [...approvals.values()].map(({ rpcId, ...a }) => a) : [], pendingArchiveOperations: session.authenticated && archive ? await archive.listOperations(archiveOwner) : [] });
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Cross-Origin-Resource-Policy': 'same-origin' };
  const json = (res, status, data) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const readBody = async req => {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'json_required', '请发送 JSON。');
    if (Number(req.headers['content-length']) > 32768) fail(413, 'body_too_large', '请求正文过大。');
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 32768) fail(413, 'body_too_large', '请求正文过大。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json', 'JSON 无效。'); }
  };
  const handleRequest = async (req, res) => {
    let counted = false;
    try {
      let allowedOrigin = expectedOrigin;
      if (loopbackHttp) {
        // Do not let URL canonicalization accept alternate IP spellings, zero-padded ports, or privileged ports.
        const host = req.headers.host;
        const match = typeof host === 'string' && /^127\.0\.0\.1:([1-9]\d{3,4})$/.exec(host);
        if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) fail(403, 'host_rejected', 'SSH 回环 HTTP 仅接受 127.0.0.1 的非特权端口。');
        allowedOrigin = `http://${host}`;
      } else if (req.headers.host !== new URL(expectedOrigin).host) fail(403, 'host_rejected', 'Host 不在已配置地址中。');
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== allowedOrigin) fail(403, 'origin_rejected', 'Origin 不匹配。');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin_rejected', '拒绝跨站请求。');
      if (loopbackHttp && (!req.url.startsWith('/') || req.url.startsWith('//'))) fail(400, 'invalid_query', 'SSH 回环 HTTP 仅接受当前地址的相对路径。');
      const url = new URL(req.url, allowedOrigin);
      if (url.username || url.password || url.origin !== allowedOrigin || [...url.searchParams.keys()].some(k => !['project', 'cursor', 'thread', ...(url.pathname === '/api/threads' && req.method === 'GET' && runtimeMode ? ['archived'] : []), ...(url.pathname === '/api/poll' ? ['wait'] : []), ...(url.pathname === '/api/directories' ? ['path'] : []), ...(url.pathname === '/api/projects' && req.method === 'GET' ? ['cwd'] : [])].includes(k)) || ['project', 'cursor', 'thread', 'path', 'cwd', 'archived'].some(key => url.searchParams.getAll(key).length > 1)) fail(400, 'invalid_query', '不接受此 URL 参数。');
      if (req.method === 'OPTIONS') fail(405, 'method_forbidden', '不支持跨域请求。');
      if (loopbackHttp && url.pathname.startsWith('/api/') && req.headers['x-relay-origin'] !== allowedOrigin) fail(403, 'origin_required', 'SSH 回环 HTTP 请求需要匹配当前地址的 X-Relay-Origin。');
      let sid = loopbackHttp ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1] : /(?:^|;\s*)relay_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
      let session = sessions.get(sid);
      if (session && loopbackHttp && session.origin !== allowedOrigin) fail(403, 'session_origin_rejected', '本地会话不属于当前回环端口。');
      if (session && expired(session)) { removeSession(sid); session = null; }
      if (session?.authenticated && session.deviceId && !await devices?.status(session.deviceId)) { removeSession(sid); session = null; }
      if (session) session.lastSeen = clock();
      if (url.pathname === '/api/session' && req.method === 'GET') {
        if (!session) {
          cleanSessions();
          if (sessions.size >= 100) fail(429, 'session_limit', '本地会话数达到上限。');
          sid = token(); session = { csrf: token(), authenticated: mock, created: clock(), lastSeen: clock(), ...(loopbackHttp ? { origin: allowedOrigin } : {}) }; sessions.set(sid, session);
          if (!loopbackHttp) res.setHeader('Set-Cookie', `relay_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${mock ? '' : '; Secure'}`);
        }
        return json(res, 200, await snapshot(session, loopbackHttp ? sid : undefined));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) fail(401, 'session_required', '请先建立本地会话。');
        if (req.method === 'POST') {
          if (requestOrigin !== allowedOrigin) fail(403, 'origin_required', '写入请求需要同源 Origin。');
          if (!eq(req.headers['x-csrf-token'], session.csrf)) fail(403, 'csrf_rejected', 'CSRF 校验失败。');
        }
        const requireLiveSession = async () => {
          if (sessions.get(sid) !== session || expired(session) || (session.deviceId && !await devices?.status(session.deviceId))) fail(401, 'session_required', '本地会话已退出或过期，请重新认证。');
        };
        if (devices && url.pathname === '/api/device/challenge' && req.method === 'POST') {
          const body = await readBody(req);
          await requireLiveSession();
          if (Object.hasOwn(body || {}, 'deviceId')) fields(body, ['deviceId']);
          else fields(body, ['publicKey', 'label'], ['pairingToken']);
          return json(res, 200, await devices.challenge({ ...body, sessionId: sid, origin: allowedOrigin, authenticated: session.authenticated }));
        }
        if (devices && url.pathname === '/api/device/verify' && req.method === 'POST') {
          const body = await readBody(req); fields(body, ['challengeId', 'signature']);
          await requireLiveSession();
          const verified = await devices.verify({ ...body, sessionId: sid, origin: allowedOrigin, authenticated: session.authenticated });
          if (!identifier(verified?.device?.id)) fail(502, 'device_protocol', '设备身份验证结果无效。');
          removeSession(sid); sid = token();
          session = { csrf: token(), authenticated: true, deviceId: verified.device.id, created: clock(), lastSeen: clock(), origin: allowedOrigin }; sessions.set(sid, session);
          return json(res, 200, await snapshot(session, sid));
        }
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const body = await readBody(req); fields(body, ['secret']);
          loginTries = loginTries.filter(t => t > clock() - 60000);
          if (loginTries.length >= 5) fail(429, 'login_rate_limit', '登录尝试过于频繁，请稍后再试。');
          loginTries.push(clock());
          if (!mock && !eq(body.secret, env.RELAY_ACCESS_SECRET)) fail(401, 'login_failed', '访问口令不正确。');
          removeSession(sid); sid = token(); session = { csrf: token(), authenticated: true, created: clock(), lastSeen: clock(), ...(loopbackHttp ? { origin: allowedOrigin } : {}) }; sessions.set(sid, session);
          if (!loopbackHttp) res.setHeader('Set-Cookie', `relay_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${mock ? '' : '; Secure'}`);
          return json(res, 200, await snapshot(session, loopbackHttp ? sid : undefined));
        }
        if (!session.authenticated) fail(401, 'authentication_required', devices ? '请先验证受信浏览器身份。' : '请先输入 relay 访问口令。');
        if (devices && url.pathname === '/api/devices' && req.method === 'GET') return json(res, 200, { devices: await devices.list() });
        if (devices && url.pathname === '/api/devices/revoke' && req.method === 'POST') {
          const body = await readBody(req); fields(body, ['deviceId']);
          await requireLiveSession();
          await devices.revoke(body.deviceId);
          for (const [id, current] of sessions) if (current.deviceId === body.deviceId) removeSession(id);
          return json(res, 200, { ok: true, deviceId: body.deviceId });
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          const body = await readBody(req); fields(body, []);
          removeSession(sid);
          if (!loopbackHttp) res.setHeader('Set-Cookie', `relay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${mock ? '' : '; Secure'}`); return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/events' && req.method === 'GET') {
          if (loopbackHttp) fail(405, 'transport_forbidden', 'SSH 回环 HTTP 模式仅支持 poll。');
          if (requestOrigin && requestOrigin !== allowedOrigin) fail(403, 'origin_rejected', 'SSE Origin 不匹配。');
          checkEventConnections(sid);
          const last = req.headers['last-event-id'] ?? url.searchParams.get('cursor');
          if ((last !== null && !/^\d{1,15}$/.test(last)) || url.searchParams.getAll('cursor').length > 1) fail(400, 'invalid_event_id', '事件游标无效。');
          res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(': relay stream\n\n');
          if (last && (Number(last) > nextEvent || (events.length && Number(last) < events[0].id - 1))) res.write(`event: relay\ndata: ${JSON.stringify({ status: 'resync', message: '事件缓冲已过期，请刷新会话历史和待审批。' })}\n\n`);
          else if (last) for (const event of events) if (event.id > Number(last)) res.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
          res.write(`event: relay\ndata: ${JSON.stringify({ status: upstreamStatus(), message: upstreamStatus() === 'closed' ? '连接已关闭；请重启 relay。不会自动重连或重发消息。' : mock ? '【模拟模式】未连接 SSH、Codex 或模型。' : '官方 CLI 消息转发。' })}\n\n`);
          streams.set(res, sid);
          const timer = setInterval(() => { if (expired(sessions.get(sid))) removeSession(sid); else res.write(': heartbeat\n\n'); }, maintenanceMs);
          res.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
        }
        if (url.pathname === '/api/poll' && req.method === 'GET') {
          const rawCursor = url.searchParams.get('cursor'), rawWait = url.searchParams.get('wait');
          if ((rawCursor !== null && !/^\d{1,15}$/.test(rawCursor)) || url.searchParams.getAll('cursor').length > 1) fail(400, 'invalid_event_id', '事件游标无效。');
          if ((rawWait !== null && (!/^\d{1,5}$/.test(rawWait) || Number(rawWait) > 20000)) || url.searchParams.getAll('wait').length > 1) fail(400, 'invalid_wait', '轮询等待时间必须为 0–20000 毫秒。');
          checkEventConnections(sid);
          const cursor = rawCursor === null ? nextEvent : Number(rawCursor), page = eventPage(cursor), wait = rawWait === null ? 20000 : Number(rawWait);
          if (page.resync || page.events.length || wait === 0 || page.upstreamStatus === 'closed') return json(res, 200, page);
          let timer;
          const cleanup = () => { clearTimeout(timer); polls.delete(res); res.off('close', cleanup); };
          const finish = (status, data) => { cleanup(); if (!res.destroyed && !res.writableEnded) json(res, status, data); };
          polls.set(res, { sid, cursor, finish }); res.once('close', cleanup);
          timer = setTimeout(() => { if (expired(sessions.get(sid))) removeSession(sid); else finish(200, eventPage(cursor)); }, Math.max(0, Math.min(wait, sessionTtlMs - (clock() - session.created), idleTtlMs - (clock() - session.lastSeen))));
          return;
        }
        if (++requests > 8) { requests--; fail(429, 'concurrency_limit', '请求过多。'); } counted = true;
        if (url.pathname === '/api/overview' && req.method === 'GET') { if (runtimeMode) await ensureConnected(); return json(res, 200, await collectOverview()); }
        if (runtimeMode && url.pathname === '/api/runtimes' && req.method === 'GET') { await ensureConnected(); return json(res, 200, { data: await runtimeRows() }); }
        if (url.pathname === '/api/directories' && req.method === 'GET') {
          if (!workspace) fail(403, 'workspace_disabled', '当前未启用文件夹浏览。');
          return json(res, 200, await workspace.browse(url.searchParams.has('path') ? url.searchParams.get('path') : undefined));
        }
        if (url.pathname === '/api/projects' && req.method === 'GET') {
          let p;
          if (url.searchParams.has('cwd')) {
            if (!registry) fail(403, 'workspace_disabled', '当前未启用文件夹选择。');
            p = await registry.register(url.searchParams.get('cwd'));
          }
          return json(res, 200, { projects: [...projects.values()], ...(p ? { project: p } : {}) });
        }
        if (url.pathname === '/api/threads' && req.method === 'GET') {
          const rawArchived = url.searchParams.get('archived');
          if (rawArchived !== null && !['true', 'false'].includes(rawArchived)) fail(400, 'invalid_query', '归档筛选必须为 true 或 false。');
          const archived = rawArchived === 'true';
          const filter = url.searchParams.get('project') ?? (workspace ? 'all' : null);
          const p = workspace && filter === 'all' ? null : await selectedProject(filter); await ensureConnected();
          const cursor = url.searchParams.get('cursor'); let remoteCursor;
          if (cursor) { const record = cursors.get(cursor); if (!record || record.kind !== 'threads' || record.projectId !== filter || (record.archived || false) !== archived) fail(400, 'invalid_cursor', '列表游标无效。'); remoteCursor = record.remoteCursor; }
          const data = []; let pages = 0, seen = new Set();
          do {
            const result = await rpc.call('thread/list', { limit: 50, cursor: remoteCursor || null, ...(runtimeMode ? { archived } : {}), ...(p ? { cwd: p.cwd } : {}), sourceKinds: workspace ? THREAD_SOURCE_KINDS : ['cli','vscode','appServer'] });
            if (!Array.isArray(result?.data) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) fail(502, 'protocol_mismatch', '会话列表 schema 不匹配。');
            for (const thread of result.data) {
              if (!identifier(thread?.id)) continue;
              if (runtimeMode) archiveMembership.set(thread.id, archived);
              if (!p) data.push(await threadMetadata(thread, archived));
              else if (!workspace) { if (thread.cwd === p.cwd) data.push(runtimeMode ? await threadMetadata(thread, archived) : safeThread(thread)); }
              else { try { if (await canonicalProject(thread.cwd) === p.cwd) data.push(await threadMetadata(thread, archived)); } catch { /* skip inaccessible or foreign working directories */ } }
            }
            remoteCursor = result.nextCursor; pages++;
            if (remoteCursor && (typeof remoteCursor !== 'string' || seen.has(remoteCursor))) fail(502, 'protocol_mismatch', '会话列表游标无效。');
            seen.add(remoteCursor);
          } while (data.length < 20 && remoteCursor && pages < 10);
          let nextCursor = null;
          if (remoteCursor) { nextCursor = token(); cursors.set(nextCursor, { kind: 'threads', projectId: filter, archived, remoteCursor }); if (cursors.size > 300) cursors.delete(cursors.keys().next().value); }
          return json(res, 200, { data, nextCursor });
        }
        if (url.pathname === '/api/history' && req.method === 'GET') {
          const threadId = url.searchParams.get('thread'), p = runtimeMode ? { id: 'library' } : project(url.searchParams.get('project'));
          const libraryThread = runtimeMode ? await readLibraryThread(threadId) : null;
          if (!runtimeMode) await owned(p.id, threadId);
          const cursor = url.searchParams.get('cursor'); let remoteCursor;
          if (cursor) { const record = cursors.get(cursor); if (!record || record.kind !== 'history' || record.projectId !== p.id || record.threadId !== threadId) fail(400, 'invalid_cursor', '历史游标无效。'); remoteCursor = record.remoteCursor; }
          const page = libraryThread?.unpersisted ? { turns: [], nextCursor: null } : await historyPage(threadId, remoteCursor); return json(res, 200, { turns: page.turns, nextCursor: historyCursor(p.id, threadId, page.nextCursor), eventCursor: nextEvent });
        }
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (runtimeMode && url.pathname === '/api/runtimes/join' && req.method === 'POST') {
          fields(body, ['threadId'], ['projectId']);
          const original = await readLibraryThread(body.threadId, true);
          if (original.archived) fail(409, 'thread_archived', '此对话已归档，可阅读历史。');
          const cwd = await canonicalProject(original.cwd);
          await refreshExternalThreads(); rejectExternalWriter(body.threadId);
          const writers = await runControl.inspectWriters([body.threadId]);
          if (!writers.complete) fail(409, 'writer_observation_incomplete', '尚未完整核实原客户端状态，暂不能接管对话。');
          const result = await rpc.call('thread/resume', { threadId: body.threadId, cwd, excludeTurns: true, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
          if (result?.thread?.id !== body.threadId || await canonicalProject(result.thread.cwd) !== cwd) fail(502, 'cwd_mismatch', '加入运行区的对话身份或目录不匹配。');
          authorizedThreads.set(body.threadId, cwd); loadedThreads.add(body.threadId); invalidateRuntimes();
          await rpc.replayThread(body.threadId);
          return json(res, 200, { thread: await threadMetadata(result.thread), runtime: (await runtimeRows()).find(run => run.threadId === body.threadId && run.managed) });
        }
        if (runtimeMode && url.pathname === '/api/runtimes/close/preview' && req.method === 'POST') { fields(body, ['runtimeId']); await ensureConnected(); return json(res, 200, await runControl.previewClose(body.runtimeId)); }
        if (runtimeMode && url.pathname === '/api/runtimes/close' && req.method === 'POST') { fields(body, ['planId']); await ensureConnected(); const result = await runControl.close(body.planId); invalidateRuntimes(); return json(res, 200, result); }
        if (runtimeMode && url.pathname === '/api/library/archive/preview' && req.method === 'POST') { fields(body, ['threadId']); await ensureConnected(); return json(res, 200, await archive.preview(body.threadId, archiveOwner)); }
        if (runtimeMode && url.pathname === '/api/library/archive' && req.method === 'POST') { fields(body, ['planId']); await ensureConnected(); const result = await archive.execute(body.planId, archiveOwner); archiveMembership.clear(); invalidateRuntimes(); return json(res, 200, result); }
        if (runtimeMode && url.pathname === '/api/library/archive/recheck' && req.method === 'POST') { fields(body, ['operationId']); await ensureConnected(); const result = await archive.recheck(body.operationId, archiveOwner); archiveMembership.clear(); invalidateRuntimes(); return json(res, 200, result); }
        if (url.pathname === '/api/projects' && req.method === 'POST') {
          fields(body, ['cwd'], ['name']);
          if (!workspace) fail(403, 'workspace_disabled', '当前未启用文件夹选择。');
          return json(res, 200, { project: await registry.create(body.cwd, body.name) });
        }
        if (url.pathname === '/api/projects/update' && req.method === 'POST') {
          fields(body, ['projectId', 'cwd', 'revision'], ['name']);
          if (!registry) fail(403, 'workspace_disabled', '当前未启用项目修改。');
          const result = await registry.update(body.projectId, body.cwd, body.name, body.revision);
          // Directory-scoped pagination cannot continue against a new binding.
          for (const [id, record] of cursors) if (record.kind === 'threads' && record.projectId === body.projectId) cursors.delete(id);
          return json(res, 200, result);
        }
        if (url.pathname === '/api/threads' && req.method === 'POST') {
          fields(body, ['projectId']); const p = await selectedProject(body.projectId); await ensureConnected();
          const result = await rpc.call('thread/start', { cwd: p.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
          let cwd; try { cwd = workspace ? await canonicalProject(result?.thread?.cwd) : result?.thread?.cwd; } catch { /* never authorize an inaccessible result */ }
          if (!result?.thread || cwd !== p.cwd || !identifier(result.thread.id)) fail(502, 'cwd_mismatch', '新会话 cwd 或 id 不匹配。');
          authorizedThreads.set(result.thread.id, p.cwd); loadedThreads.add(result.thread.id); invalidateRuntimes(); return json(res, 200, { thread: await threadMetadata(result.thread), ...(runtimeMode ? { runtime: (await runtimeRows()).find(run => run.threadId === result.thread.id && run.managed) } : {}) });
        }
        if (url.pathname === '/api/resume' && req.method === 'POST') {
          if (runtimeMode) { fields(body, ['threadId'], ['projectId']); const original = await readLibraryThread(body.threadId); await refreshExternalThreads(); const thread = await threadMetadata(original); const page = original.unpersisted ? { turns: [], nextCursor: null } : await historyPage(thread.id); thread.turns = page.turns; return json(res, 200, { thread, nextCursor: historyCursor('library', thread.id, page.nextCursor), eventCursor: nextEvent }); }
          fields(body, ['projectId', 'threadId']); const thread = await threadMetadata(await owned(body.projectId, body.threadId, true)); const page = await historyPage(thread.id); thread.turns = page.turns; return json(res, 200, { thread, nextCursor: historyCursor(body.projectId, thread.id, page.nextCursor), eventCursor: nextEvent });
        }
        if (url.pathname === '/api/turns' && req.method === 'POST') {
          fields(body, ['projectId', 'threadId', 'text', 'submissionId']);
          if (!identifier(body.threadId) || !identifier(body.submissionId) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) fail(400, 'invalid_parameters', '消息、会话或提交 id 无效。');
          project(body.projectId);
          const key = `${body.threadId}:${body.submissionId}`; const previous = submissions.get(key);
          if (previous) {
            if (previous.projectId !== body.projectId || previous.text !== body.text) fail(409, 'submission_conflict', '提交 id 已用于不同内容。');
            return json(res, 200, { ...await previous.promise, duplicate: true });
          }
          if (submissions.size >= 1000) fail(429, 'submission_limit', '提交去重容量已满，请重启 relay 后核对历史。');
          if (busy.has(body.threadId) || pendingTurns.has(body.threadId)) { await refreshExternalThreads(); rejectExternalWriter(body.threadId); fail(409, 'turn_busy', '该会话已有正在执行的消息。'); }
          busy.add(body.threadId); pendingTurns.add(body.threadId);
          const promise = (async () => {
            try {
              const thread = await owned(body.projectId, body.threadId, true);
              await refreshExternalThreads(); rejectExternalWriter(body.threadId);
              if (workspace && thread.status?.type === 'active' && !runtimeMode) fail(409, 'turn_busy', '该会话正在其他客户端执行，请先查看现有任务。');
              const result = await rpc.call('turn/start', { threadId: body.threadId, input: [{ type: 'text', text: body.text, text_elements: [] }] });
              if (!result?.turn || !identifier(result.turn.id)) fail(502, 'protocol_mismatch', '消息返回 schema 不匹配。');
              return { turn: safeTurn(result.turn) };
            } catch (e) { busy.delete(body.threadId); throw e; }
            finally { pendingTurns.delete(body.threadId); }
          })();
          submissions.set(key, { projectId: body.projectId, text: body.text, promise });
          return json(res, 200, { ...await promise, duplicate: false });
        }
        if (url.pathname === '/api/interrupt' && req.method === 'POST') {
          fields(body, ['threadId', 'turnId']);
          if (!authorizedThreads.has(body.threadId) || !identifier(body.turnId) || activeTurns.get(body.threadId) !== body.turnId) fail(403, 'thread_forbidden', '会话或当前任务尚未核对。');
          await refreshExternalThreads(); rejectExternalWriter(body.threadId);
          await rpc.call('turn/interrupt', { threadId: body.threadId, turnId: body.turnId }); return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/approvals' && req.method === 'POST') {
          fields(body, ['requestId', 'decision']);
          const a = approvals.get(body.requestId);
          if (!a || activeTurns.get(a.params.threadId) !== a.params.turnId || !['accept', 'decline'].includes(body.decision)) fail(409, 'approval_unavailable', '审批已处理、已失效或决策无效。');
          await rpc.answer(a.rpcId, { decision: body.decision });
          approvals.delete(body.requestId); answered.add(body.requestId);
          push('relay', { status: 'approval-resolved', requestId: body.requestId, message: body.decision === 'accept' ? '审批已批准。' : '审批已拒绝。' });
          return json(res, 200, { ok: true });
        }
        fail(404, 'not_found', '接口不存在。');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'method_forbidden', '不支持此方法。');
      const staticPaths = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/styles.css': 'styles.css' };
      const name = staticPaths[url.pathname]; if (!name) fail(404, 'not_found', '文件不存在。');
      let file; try { file = await readFile(resolve(PUBLIC, name)); } catch { fail(404, 'not_found', '文件不存在。'); }
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { ...headers, 'Content-Type': mime[extname(name)] }); res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof RelayError ? error.status : 500, { error: { code: error instanceof RelayError ? error.code : 'internal_error', message: error instanceof RelayError ? error.message : '内部错误。未发送详细私密信息。', ...(error instanceof RelayError && identifier(error.operationId) ? { operationId: error.operationId, freezeRetained: error.freezeRetained === true } : {}) } });
      else res.end();
    } finally { if (counted) requests--; }
  };
  const serverOptions = { requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 8192 };
  let server;
  if (tlsOptions) {
    try { server = https.createServer({ ...serverOptions, ...tlsOptions }, handleRequest); }
    catch { fail(500, 'tls_configuration', 'TLS 证书或私钥无法读取或无效。'); }
  } else server = http.createServer(serverOptions, handleRequest);
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  origin = `${tlsOptions ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  expectedOrigin = mock ? origin : config.publicOrigin;
  const cleanupTimer = setInterval(cleanSessions, maintenanceMs); cleanupTimer.unref();
  return { server, rpc, origin, publicOrigin: expectedOrigin, config, close: async () => { clearInterval(cleanupTimer); for (const [res] of streams) res.end(); streams.clear(); for (const poll of polls.values()) poll.finish(503, { error: { code: 'disconnected', message: 'Relay 已关闭。' } }); rpc.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }, state: { approvals, events, submissions, authorizedThreads, loadedThreads, activeTurns, sessions, polls, streams, projects } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let mock = true, configPath, port = 8787;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--mock') mock = true;
      else if (args[i] === '--config') { configPath = args[++i]; mock = false; }
      else if (args[i] === '--port') port = Number(args[++i]);
      else fail(500, 'arguments', '仅支持 --mock、--config path、--port。');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(500, 'arguments', '端口无效。');
    const config = configPath ? JSON.parse(await readFile(resolve(configPath), 'utf8')) : undefined;
    const relay = await createRelay({ mock, config, port });
    console.log(`${mock ? '【模拟模式：无 SSH / 模型调用】' : '【生产转发：仅复用远端官方 CLI】'} ${relay.origin}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
  } catch (error) { console.error(error instanceof RelayError ? error.message : '启动失败，请检查配置。'); process.exitCode = 1; }
}
