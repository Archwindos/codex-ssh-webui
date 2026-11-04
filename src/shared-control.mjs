import { fail } from './protocol.mjs';
import { createHash } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

// These records describe native daemon threads. They never own a process or
// create a second execution runtime for a conversation.
export function createSharedThreadControl({ rpc, canonical, authorizedThreads, loadedThreads, activeTurns, busy, pendingTurns, threadNames }) {
  const threads = new Map(), revisions = new Map();
  let bootstrapPending, epoch = 0;
  const remember = async (thread, { loaded = false, generation = epoch, revision = revisions.get(thread?.id) || 0 } = {}) => {
    if (!identifier(thread?.id)) fail(502, 'protocol_mismatch', '原生会话身份无效。');
    const cwd = await canonical(thread.cwd);
    if (generation !== epoch || !rpc.connected) fail(503, 'disconnected', '共享连接已断开；请重新核对会话。');
    authorizedThreads.set(thread.id, cwd);
    const changed = revision !== (revisions.get(thread.id) || 0), previous = threads.get(thread.id);
    if (!changed) {
      if (thread.status?.type !== 'notLoaded' && (loaded || ['active', 'idle', 'systemError'].includes(thread.status?.type))) loadedThreads.add(thread.id);
      else loadedThreads.delete(thread.id);
    }
    threads.set(thread.id, { ...thread, cwd, ...(changed ? { status: previous?.status || { type: activeTurns.has(thread.id) || busy.has(thread.id) ? 'active' : 'idle' } } : {}) });
    if (thread.name || thread.preview) threadNames.set(thread.id, String(thread.name || thread.preview).slice(0, 100));
    if (changed) return threads.get(thread.id);
    const active = (Array.isArray(thread.turns) ? thread.turns : []).findLast(turn => turn?.status === 'inProgress' && identifier(turn.id));
    const turnId = identifier(thread.activeTurnId) ? thread.activeTurnId : active?.id;
    if (turnId) { activeTurns.set(thread.id, turnId); busy.add(thread.id); }
    else if (thread.status?.type === 'active') busy.add(thread.id);
    else if (!pendingTurns.has(thread.id)) { activeTurns.delete(thread.id); busy.delete(thread.id); }
    return threads.get(thread.id);
  };
  const read = async (threadId, { loaded = false } = {}) => {
    if (!identifier(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    const generation = epoch, revision = revisions.get(threadId) || 0;
    const result = await rpc.call('thread/read', { threadId, includeTurns: false });
    if (result?.thread?.id !== threadId) fail(502, 'protocol_mismatch', '原生会话身份无法核对。');
    if (result.thread.status?.type === 'active' && !identifier(result.thread.activeTurnId)) {
      const page = await rpc.call('thread/turns/list', { threadId, limit: 1, cursor: null, itemsView: 'summary', sortDirection: 'desc' });
      if (!Array.isArray(page?.data)) fail(502, 'protocol_mismatch', '原生当前任务状态无效。');
      const active = page.data.find(turn => turn?.status === 'inProgress' && identifier(turn.id));
      if (active) result.thread.activeTurnId = active.id;
    }
    return remember(result.thread, { loaded, generation, revision });
  };
  const bootstrap = () => bootstrapPending ||= (async () => {
    const ids = new Set(), seen = new Set(), previousLoaded = new Set(loadedThreads), previousRevisions = new Map(revisions); let cursor = null;
    for (let page = 0; page < 100; page++) {
      const result = await rpc.call('thread/loaded/list', { cursor, limit: 100 });
      if (!Array.isArray(result?.data) || result.data.some(id => !identifier(id)) || (result.nextCursor != null && typeof result.nextCursor !== 'string')) fail(502, 'protocol_mismatch', '原生已加载会话列表无效。');
      for (const id of result.data) ids.add(id);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (seen.has(cursor) || page === 99) fail(502, 'loaded_threads_incomplete', '原生已加载会话列表未完整读取。');
      seen.add(cursor);
    }
    for (const id of ids) {
      try { await read(id, { loaded: true }); }
      catch (error) {
        // A daemon may also serve folders outside this gateway's workspace.
        // Their existence does not grant this gateway access.
        if (!['workspace_forbidden', 'directory_not_found', 'directory_unreadable', 'not_directory', 'invalid_path'].includes(error?.code)) throw error;
        loadedThreads.delete(id); threads.delete(id); authorizedThreads.delete(id); busy.delete(id); activeTurns.delete(id);
      }
    }
    for (const id of previousLoaded) if (!ids.has(id) && (revisions.get(id) || 0) === (previousRevisions.get(id) || 0)) { loadedThreads.delete(id); threads.delete(id); busy.delete(id); activeTurns.delete(id); }
    return [...threads.values()].filter(thread => loadedThreads.has(thread.id));
  })().finally(() => { bootstrapPending = null; });
  const clear = () => { epoch++; threads.clear(); revisions.clear(); authorizedThreads.clear(); loadedThreads.clear(); activeTurns.clear(); busy.clear(); };
  const state = threadId => ({ nativeLoaded: loadedThreads.has(threadId), activeTurnId: activeTurns.get(threadId) || null });
  const status = (threadId, value) => {
    revisions.set(threadId, (revisions.get(threadId) || 0) + 1);
    const thread = threads.get(threadId);
    if (thread) thread.status = value;
    if (value?.type === 'active') busy.add(threadId);
    else if (['idle', 'notLoaded', 'systemError'].includes(value?.type) && !pendingTurns.has(threadId)) { busy.delete(threadId); activeTurns.delete(threadId); }
    if (value?.type === 'notLoaded') loadedThreads.delete(threadId);
    else if (['idle', 'active'].includes(value?.type)) loadedThreads.add(threadId);
  };
  const turn = (threadId, value, started) => {
    revisions.set(threadId, (revisions.get(threadId) || 0) + 1);
    const thread = threads.get(threadId);
    if (started) loadedThreads.add(threadId);
    if (thread && (started || !activeTurns.has(threadId) || activeTurns.get(threadId) === value?.id)) thread.status = started ? { type: 'active', activeFlags: [] } : { type: 'idle' };
  };
  const agents = () => [...threads.values()].filter(thread => loadedThreads.has(thread.id)).map(thread => {
    const flags = thread.status?.activeFlags || [];
    const status = flags.includes('waitingOnUserInput') ? 'waitingUserInput' : flags.includes('waitingOnApproval') ? 'waitingApproval' : busy.has(thread.id) || activeTurns.has(thread.id) ? 'working' : thread.status?.type === 'systemError' ? 'unknown' : 'idle';
    return { threadId: thread.id, cwd: thread.cwd, name: threadNames.get(thread.id) || `Codex · ${thread.id.slice(0, 8)}`, projectId: thread.projectId ?? null, source: 'sharedDaemon', status, activeTurnId: activeTurns.get(thread.id) || null, canOpen: true, detail: status === 'waitingApproval' ? '等待批准操作' : status === 'waitingUserInput' ? '等待回答问题' : status === 'working' ? '正在执行任务' : '等待新任务' };
  });
  const revision = threadId => revisions.get(threadId) || 0;
  const inspectArchiveStates = async ids => {
    const generation = epoch, states = [], observed = new Map();
    for (const threadId of ids) {
      const before = revision(threadId), result = await rpc.call('thread/read', { threadId, includeTurns: false }), thread = result?.thread;
      if (thread?.id !== threadId) fail(502, 'archive_state_unknown', '原生归档会话身份无法核对。');
      const cwd = await canonical(thread.cwd);
      const page = await rpc.call('thread/turns/list', { threadId, limit: 1, cursor: null, itemsView: 'summary', sortDirection: 'desc' });
      if (!Array.isArray(page?.data) || page.data.length > 1 || page.data.some(turn => !identifier(turn?.id) || typeof turn.status !== 'string')) fail(502, 'archive_state_unknown', '原生归档当前任务无法核对。');
      const changed = before !== revision(threadId) || generation !== epoch || !rpc.connected;
      const type = pendingTurns.has(threadId) ? 'active' : changed ? 'unknown' : ['idle', 'notLoaded', 'active', 'systemError'].includes(thread.status?.type) ? thread.status.type : 'unknown';
      const fingerprint = createHash('sha256').update(JSON.stringify([threadId, cwd, type, thread.status?.activeFlags || [], Number.isSafeInteger(thread.updatedAt) ? thread.updatedAt : null, page.data.map(turn => [turn.id, turn.status]), revision(threadId)])).digest('hex');
      states.push({ threadId, status: type, fingerprint });
      observed.set(threadId, revision(threadId));
    }
    return { complete: generation === epoch && rpc.connected && ids.every(id => observed.get(id) === revision(id) && !pendingTurns.has(id)), states };
  };
  return { bootstrap, read, remember, clear, state, status, turn, revision, agents, inspectArchiveStates };
}
