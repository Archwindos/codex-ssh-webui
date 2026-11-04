// This process implements only local fixtures. It never launches Codex or SSH.
import { createInterface } from 'node:readline';
const threads = new Map(); const running = new Map(); const approvals = new Map();
const projects = new Map(), projectRequests = new Map();
const pinnedSection = { id: '01984de2-8f74-7c91-a3b2-5c5e937cf318', name: 'Pinned', appearance: null };
let threadNo = 0, turnNo = 0, requestNo = 0, projectNo = 0;
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
const notify = (method, params) => send({ method, params });
const respond = (id, result) => send({ id, result });
const foreign = { id: 'foreign-thread', cwd: '/private/foreign', projectId: null, section: null, sectionEnteredAt: null, recencyAt: 1, preview: 'MUST_NOT_LEAK', name: 'MUST_NOT_LEAK', source: 'cli', status: { type: 'notLoaded' }, createdAt: 1, updatedAt: 1, turns: [] };
threads.set(foreign.id, foreign);
function complete(threadId, turn, status) {
  const active = running.get(threadId); if (!active || active.turn.id !== turn.id) return;
  clearInterval(active.timer); running.delete(threadId); turn.status = status;
  notify('turn/completed', { threadId, turn });
  const thread = threads.get(threadId); thread.status = { type: 'idle' }; thread.updatedAt = Math.floor(Date.now() / 1000);
  notify('thread/status/changed', { threadId, status: thread.status });
}
function stream(threadId, turn, reply) {
  const item = { id: `answer-${turn.id}`, type: 'agentMessage', text: '' }; turn.items.push(item);
  const chars = [...reply]; let i = 0;
  const active = running.get(threadId); if (!active || active.turn.id !== turn.id) return;
  active.timer = setInterval(() => {
    if (i >= chars.length) { notify('item/completed', { threadId, turnId: turn.id, item }); complete(threadId, turn, 'completed'); return; }
    const delta = chars.slice(i, i + 3).join(''); i += 3; item.text += delta;
    notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: item.id, delta });
  }, 25);
}
createInterface({ input: process.stdin }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params: p = {} } = msg;
  if (!method) {
    const approval = approvals.get(String(id)); if (!approval) return;
    approvals.delete(String(id));
    if (running.has(approval.threadId)) stream(approval.threadId, approval.turn, msg.result?.decision === 'accept' ? '【模拟】审批已批准。这只是模拟命令，没有执行任何系统操作。' : '【模拟】审批已拒绝。未执行命令。');
    return;
  }
  if (method === 'initialized') return;
  if (method === 'initialize') return respond(id, { userAgent: 'mock-app-server/0.165.0', platformFamily: 'mock', platformOs: 'mock' });
  if (method === 'account/read') return respond(id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  if (method === 'threadSection/list') return respond(id, { data: [pinnedSection], nextCursor: null });
  if (method === 'project/list') {
    const all = [...projects.values()], from = Number(p.cursor || 0), limit = p.limit || 50;
    return respond(id, { data: all.slice(from, from + limit), nextCursor: from + limit < all.length ? String(from + limit) : null });
  }
  if (method === 'project/create') {
    const previous = projectRequests.get(p.idempotencyKey);
    if (previous) {
      if (previous.input !== JSON.stringify(p)) return send({ id, error: { code: -32602, message: 'Idempotency conflict' } });
      return respond(id, { project: projects.get(previous.id) });
    }
    const now = Math.floor(Date.now() / 1000), project = { id: `mock-project-${++projectNo}`, name: p.name, roots: p.roots, metadata: p.metadata || {}, position: projectNo, createdAt: now, updatedAt: now, recencyAt: null };
    projects.set(project.id, project); projectRequests.set(p.idempotencyKey, { input: JSON.stringify(p), id: project.id });
    respond(id, { project }); notify('project/changed', { projectId: project.id, changeType: 'created' }); return;
  }
  if (method === 'project/read' || method === 'project/update') {
    const project = projects.get(p.projectId);
    if (!project) return send({ id, error: { code: -32602, message: 'Project not found' } });
    if (method === 'project/update') { for (const key of ['name', 'roots', 'metadata']) if (Object.hasOwn(p, key)) project[key] = p[key]; project.updatedAt = Math.floor(Date.now() / 1000); notify('project/changed', { projectId: project.id, changeType: 'updated' }); }
    return respond(id, { project });
  }
  if (method === 'thread/list') {
    const all = [...threads.values()].filter(thread => !p.cwd || thread.cwd === p.cwd).filter(thread => !p.sourceKinds?.length || p.sourceKinds.includes(thread.source)).filter(thread => !Object.hasOwn(p, 'projectId') || thread.projectId === p.projectId).filter(thread => !Object.hasOwn(p, 'sectionId') || (thread.section?.id || null) === p.sectionId).filter(thread => !p.searchTerm || (thread.name || thread.preview || '').toLowerCase().includes(p.searchTerm.toLowerCase())).filter(thread => Boolean(thread.archived) === Boolean(p.archived));
    const from = Number(p.cursor || 0), limit = p.limit || 50;
    return respond(id, { data: all.slice(from, from + limit), nextCursor: from + limit < all.length ? String(from + limit) : null });
  }
  if (method === 'thread/start') {
    const now = Math.floor(Date.now() / 1000);
    if (p.projectId && !projects.has(p.projectId)) return send({ id, error: { code: -32602, message: 'Project not found' } });
    const thread = { id: `mock-thread-${++threadNo}`, cwd: p.cwd, projectId: p.projectId || null, section: null, sectionEnteredAt: null, recencyAt: now, preview: '【模拟】新会话', name: '模拟会话', source: 'appServer', status: { type: 'idle' }, createdAt: now, updatedAt: now, turns: [] }; threads.set(thread.id, thread); respond(id, { thread }); notify('thread/started', { thread }); return;
  }
  const thread = threads.get(p.threadId);
  if (!thread) return send({ id, error: { code: -32602, message: 'Thread not found' } });
  if (method === 'thread/name/set') { thread.name = p.name; respond(id, {}); notify('thread/name/updated', { threadId: thread.id, threadName: thread.name }); return; }
  if (method === 'thread/section/move') {
    if (p.sectionId !== null && p.sectionId !== pinnedSection.id) return send({ id, error: { code: -32602, message: 'Unknown section' } });
    thread.section = p.sectionId ? pinnedSection : null; thread.sectionEnteredAt = p.sectionId ? Math.floor(Date.now() / 1000) : null; return respond(id, {});
  }
  if (method === 'thread/metadata/update') {
    if (p.projectId && !projects.has(p.projectId)) return send({ id, error: { code: -32602, message: 'Project not found' } });
    if (typeof p.projectId === 'string') { thread.projectId = p.projectId || null; notify('thread/project/updated', { threadId: thread.id, projectId: thread.projectId }); }
    return respond(id, { thread: { ...thread, turns: [] } });
  }
  if (method === 'thread/read' || method === 'thread/resume') return respond(id, { thread: { ...thread, turns: p.includeTurns === true ? thread.turns : [] } });
  if (method === 'thread/turns/list') {
    const from = Number(p.cursor || 0); const all = [...thread.turns].reverse(); const data = all.slice(from, from + p.limit); return respond(id, { data, nextCursor: from + p.limit < all.length ? String(from + p.limit) : null });
  }
  if (method === 'turn/interrupt') {
    const active = running.get(thread.id); if (active && active.turn.id === p.turnId) complete(thread.id, active.turn, 'interrupted'); return respond(id, {});
  }
  if (method === 'turn/start') {
    if (running.has(thread.id)) return send({ id, error: { code: -32000, message: 'Busy' } });
    const input = p.input?.map(x => x.text || '').join('') || '';
    const turn = { id: `mock-turn-${++turnNo}`, status: 'inProgress', items: [{ id: `user-${turnNo}`, type: 'userMessage', content: [{ type: 'text', text: input }] }] };
    thread.turns.push(turn); thread.preview = input.slice(0, 100); running.set(thread.id, { turn });
    thread.status = { type: 'active', activeFlags: [] }; thread.updatedAt = Math.floor(Date.now() / 1000);
    respond(id, { turn }); notify('turn/started', { threadId: thread.id, turn });
    notify('thread/status/changed', { threadId: thread.id, status: thread.status });
    if (input.includes('思考')) {
      const item = { id: `reasoning-${turn.id}`, type: 'reasoning', summary: ['【模拟】检查已提供的信息。'], content: [] };
      turn.items.push(item); notify('item/started', { threadId: thread.id, turnId: turn.id, item: { ...item, summary: [] } });
      notify('item/reasoning/summaryPartAdded', { threadId: thread.id, turnId: turn.id, itemId: item.id, summaryIndex: 0 });
      notify('item/reasoning/summaryTextDelta', { threadId: thread.id, turnId: turn.id, itemId: item.id, summaryIndex: 0, delta: item.summary[0] });
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
    }
    if (input.includes('退出')) return setTimeout(() => process.exit(0), 80);
    if (input.includes('未知请求')) send({ id: `unknown-${++requestNo}`, method: 'account/requestPrivateSecret', params: { token: 'MUST_NOT_LEAK' } });
    if (input.includes('审批')) {
      const requestId = `mock-approval-${++requestNo}`; approvals.set(requestId, { threadId: thread.id, turn });
      send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: turn.id, itemId: `cmd-${turn.id}`, command: 'echo mock-only', cwd: thread.cwd, reason: '【模拟】测试审批，不执行真实命令。' } });
    } else if (input.includes('思考演示')) {
      const active = running.get(thread.id);
      active.timer = setTimeout(() => {
        if (running.get(thread.id)?.turn.id === turn.id) stream(thread.id, turn, `【模拟回复】收到：${input}。当前为本地模拟，没有连接服务器或调用模型。`);
      }, 3000);
    } else stream(thread.id, turn, `【模拟回复】收到：${input}。当前为本地模拟，没有连接服务器或调用模型。`);
    return;
  }
  send({ id, error: { code: -32601, message: 'Unknown method' } });
});
