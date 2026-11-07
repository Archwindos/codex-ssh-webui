import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

export class RelayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new RelayError(status, code, message); }
export const METHODS = new Set(['initialize', 'account/read', 'model/list', 'config/read', 'permissionProfile/list', 'project/list', 'project/read', 'project/create', 'project/update', 'project/move', 'project/delete', 'threadSection/list', 'thread/name/set', 'thread/metadata/update', 'thread/section/move', 'thread/start', 'thread/resume', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list', 'thread/archive', 'turn/start', 'turn/interrupt']);
export const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
// Empty sourceKinds means interactive-only in the verified 0.165 protocol.
export const THREAD_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

// Transport, executable and SSH alias are trusted server configuration only.
function productionTransport(config) {
  const transport = config.transport === undefined ? 'ssh' : config.transport;
  if (transport !== 'ssh' && transport !== 'local') fail(500, 'configuration', 'transport 只能为 ssh 或 local。');
  return transport;
}

export function validateTransportConfig(config) {
  const transport = productionTransport(config), executable = config.remoteCodex;
  // SSH invokes a remote shell. Accept only normalized, shell-safe POSIX paths.
  if (typeof executable !== 'string' || executable.length > 4096 || !/^\/(?:[A-Za-z0-9._-]+\/)*codex$/.test(executable) || posix.normalize(executable) !== executable || executable.split('/').some(part => part === '.' || part === '..')) fail(500, 'configuration', '官方 CLI 路径必须为安全、规范且以 codex 结尾的绝对 POSIX 路径。');
  if (transport === 'ssh' && (typeof config.sshTarget !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(config.sshTarget))) fail(500, 'configuration', 'SSH 目标必须为受信配置中的安全 alias。');
  return transport;
}

export function validateProtocolConfig(config) {
  const p = config.verifiedProtocol;
  if (!p || p.version !== '0.165.0' || p.verified !== true || p.schemaVerified !== true) fail(500, 'protocol_unverified', '远端 0.165.0 协议和 schema 尚未通过显式验证门。');
}

export function accessMode(config) {
  const mode = config.accessMode === undefined ? 'https' : config.accessMode;
  if (!['https', 'ssh-loopback-http'].includes(mode)) fail(500, 'configuration', 'accessMode 只能为 https 或 ssh-loopback-http。');
  if (mode === 'ssh-loopback-http' && (config.publicOrigin !== undefined || config.tls !== undefined || (config.eventTransport !== undefined && config.eventTransport !== 'poll'))) fail(500, 'configuration', 'SSH 回环 HTTP 模式必须省略 publicOrigin、TLS，并仅使用 poll。');
  return mode;
}

export function validateProduction(config, env = process.env) {
  const mode = accessMode(config);
  validateTransportConfig(config);
  validateProtocolConfig(config);
  if (env.RELAY_VERIFIED_PROTOCOL !== '0.165.0') fail(500, 'protocol_unverified', '远端 0.165.0 协议和 schema 尚未通过显式验证门。');
  if (typeof env.RELAY_ACCESS_SECRET !== 'string' || env.RELAY_ACCESS_SECRET.length < 32) fail(500, 'secret_required', '生产模式需要用户提供至少 32 字符的 RELAY_ACCESS_SECRET。');
  if (mode === 'https') {
    let origin; try { origin = new URL(config.publicOrigin); } catch { fail(500, 'configuration', '生产模式需要明确的 HTTPS publicOrigin。'); }
    if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin || origin.hostname.endsWith('.invalid') || origin.username || origin.password) fail(500, 'configuration', '生产模式需要已确认的 HTTPS publicOrigin，不接受占位值。');
  }
}

export class RpcClient extends EventEmitter {
  constructor(config, { mock = true, spawnProcess = spawn, experimentalApi = false } = {}) {
    super(); this.config = config; this.mock = mock; this.spawnProcess = spawnProcess; this.experimentalApi = experimentalApi === true;
    this.pending = new Map(); this.counter = 0; this.connected = false; this.ended = false;
  }
  async start() {
    if (this.child) fail(503, 'disconnected', '连接已关闭；不会自动重新发送。');
    const transport = this.mock ? productionTransport(this.config) : validateTransportConfig(this.config);
    if (!this.mock) validateProtocolConfig(this.config);
    const command = this.mock ? process.execPath : transport === 'local' ? this.config.remoteCodex : 'ssh';
    const args = this.mock ? [fileURLToPath(new URL('./mock-app-server.mjs', import.meta.url))] : transport === 'local' ? ['app-server'] : ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', this.config.sshTarget, `exec ${this.config.remoteCodex} app-server`];
    // Windows OpenSSH needs ProgramData even for ssh -G; do not forward application secrets.
    const envKeys = !this.mock && transport === 'local' ? ['PATH','Path','SystemRoot','WINDIR','USERPROFILE','HOME','TEMP','TMP'] : ['PATH','Path','SystemRoot','WINDIR','ProgramData','USERPROFILE','HOME','SSH_AUTH_SOCK','TEMP','TMP'];
    const childEnv = Object.fromEntries(envKeys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    this.child = this.spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
    // stderr can contain account and local path information. Never forward it.
    this.child.stderr?.resume();
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2 * 1024 * 1024) { this.child.kill(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        try { this.receive(JSON.parse(line)); } catch { this.child.kill(); }
      }
    });
    const closed = () => {
      if (this.ended) return;
      this.ended = true; this.connected = false;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new RelayError(503, 'disconnected', '连接已关闭；提交结果可能未知，请检查历史，勿自动重发。')); }
      this.pending.clear(); this.emit('closed');
    };
    this.child.on('error', closed); this.child.on('exit', closed);
    this.child.stdin.on('error', closed);
    const init = await this.call('initialize', { clientInfo: { name: 'codex-ssh-webui', title: 'Codex SSH WebUI', version: '0.1.0' }, capabilities: { experimentalApi: this.experimentalApi } });
    if (!this.mock && !/(?:^|\D)0\.165\.0(?:\D|$)/.test(init?.userAgent || '')) { this.close(); fail(503, 'protocol_mismatch', '远端 CLI 版本与已验证版本不一致。'); }
    this.notify('initialized', {});
    if (!this.mock) {
      const auth = await this.call('account/read', { refreshToken: false });
      if (auth?.account?.type !== 'chatgpt') { this.close(); fail(503, 'chatgpt_login_required', '远端官方 CLI 必须已使用 ChatGPT 登录。'); }
    }
    if (this.ended) fail(503, 'disconnected', '远端连接已关闭。');
    this.connected = true;
  }
  write(message) {
    if (!this.child || this.ended || !this.child.stdin.writable) fail(503, 'disconnected', '连接已关闭；不会自动重新发送。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params) {
    if (!METHODS.has(method)) fail(400, 'method_forbidden', '方法不在白名单中。');
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timeoutMs = method === 'initialize' ? 30000 : 15000;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RelayError(504, 'rpc_timeout', '远端响应超时；结果可能未知，不会自动重发。')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method, params) { this.write({ method, params }); }
  answer(id, result) { this.write({ id, result }); }
  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Malformed protocol');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (APPROVALS.has(message.method)) this.emit('approval', message);
        else { this.write({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } }); this.emit('unsupported'); }
      } else this.emit('notification', message);
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new RelayError(502, 'upstream_error', '官方 CLI 拒绝了请求，请检查连接状态与所选会话。'));
      else pending.resolve(message.result);
    }
  }
  close() { this.child?.kill(); }
}

const text = (s, n = 20000) => typeof s === 'string' ? s.slice(0, n) : '';
const textParts = value => {
  let remaining = 20000;
  return (Array.isArray(value) ? value : []).slice(0, 100).filter(part => typeof part === 'string').map(part => { const result = part.slice(0, remaining); remaining -= result.length; return result; });
};
export function safeThreadStatus(status) {
  const type = ['notLoaded', 'idle', 'systemError', 'active'].includes(status?.type) ? status.type : 'unknown';
  return { type, ...(type === 'active' ? { activeFlags: [...new Set((Array.isArray(status.activeFlags) ? status.activeFlags : []).filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)))] } : {}) };
}
function safeSource(source) {
  if (typeof source === 'string') return ['cli', 'vscode', 'exec', 'appServer', 'unknown'].includes(source) ? source : 'unknown';
  if (typeof source?.custom === 'string') return { custom: text(source.custom, 100) };
  const sub = source?.subAgent;
  if (['review', 'compact', 'memory_consolidation'].includes(sub)) return { subAgent: sub };
  if (typeof sub?.other === 'string') return { subAgent: { other: text(sub.other, 100) } };
  if (sub?.thread_spawn && typeof sub.thread_spawn === 'object') {
    const spawn = sub.thread_spawn;
    return { subAgent: { thread_spawn: { parent_thread_id: text(spawn.parent_thread_id, 200), depth: Number.isSafeInteger(spawn.depth) && spawn.depth >= 0 ? spawn.depth : null, agent_nickname: text(spawn.agent_nickname, 100), agent_role: text(spawn.agent_role, 100) } } };
  }
  return 'unknown';
}
export function safeItem(item) {
  if (!item || typeof item !== 'object') return { type: 'unknown', id: '' };
  const result = { id: text(item.id, 200), type: text(item.type, 80) };
  if (item.type === 'agentMessage' || item.type === 'plan') { result.text = text(item.text); result.truncated = typeof item.text === 'string' && item.text.length > 20000; if (['commentary', 'partial_answer', 'final_answer'].includes(item.phase)) result.phase = item.phase; }
  else if (item.type === 'userMessage') {
    const attachments = [], prefix = '用户上传的附件；可按本次任务需要读取以下本地文件：\n';
    result.content = (Array.isArray(item.content) ? item.content : []).filter(x => x?.type === 'text').flatMap(part => {
      let content = typeof part.text === 'string' ? part.text : '', index = content.indexOf(prefix);
      if (index >= 0) {
        try {
          const lines = content.slice(index + prefix.length).split('\n').filter(line => line.trim());
          if (!lines.length || lines.length > 5) throw Error('Not attachment metadata');
          const files = lines.map(line => JSON.parse(line));
          if (files.some(file => !file || Object.keys(file).sort().join(',') !== 'mimeType,name,path,size' || typeof file.name !== 'string' || !file.name || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name) || typeof file.path !== 'string' || !file.path || typeof file.mimeType !== 'string' || file.mimeType.length > 200 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 10 * 1024 * 1024)) throw Error('Not attachment metadata');
          attachments.push(...files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size }))); content = content.slice(0, index);
        } catch { /* Ordinary user text is never discarded by a prefix alone. */ }
      }
      return content ? [{ type: 'text', text: text(content) }] : [];
    });
    if (attachments.length) result.attachments = attachments;
  }
  else if (item.type === 'reasoning') { result.summary = textParts(item.summary); result.content = textParts(item.content); result.truncated = [item.summary, item.content].some(parts => Array.isArray(parts) && (parts.length > 100 || parts.reduce((total, part) => total + (typeof part === 'string' ? part.length : 0), 0) > 20000)); }
  else if (item.type === 'commandExecution') {
    result.command = text(item.command, 2000); result.cwd = text(item.cwd, 1000); result.status = text(item.status, 80);
    result.aggregatedOutput = text(item.aggregatedOutput); result.truncated = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length > 20000; result.exitCode = Number.isInteger(item.exitCode) ? item.exitCode : null;
    if (Array.isArray(item.commandActions)) result.commandActions = item.commandActions.slice(0, 24).filter(action => ['read', 'search', 'listFiles', 'unknown'].includes(action?.type)).map(action => ({ type: action.type, name: text(action.name, 240), path: text(action.path, 1000), query: text(action.query, 240) }));
  }
  else if (item.type === 'fileChange') { result.status = text(item.status, 80); result.changes = (Array.isArray(item.changes) ? item.changes : []).slice(0, 100).map(x => ({ path: text(x.path, 1000), kind: text(typeof x.kind === 'string' ? x.kind : x.kind?.type, 80), diff: text(x.diff) })); }
  else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') { result.server = text(item.server, 200); result.tool = text(item.tool, 200); result.status = text(item.status, 80); }
  else if (item.type === 'webSearch') { result.query = text(item.query, 2000); if (['search', 'openPage', 'findInPage'].includes(item.action?.type)) result.action = { type: item.action.type, query: text(item.action.query, 2000), queries: textParts(item.action.queries), url: text(item.action.url, 2000), pattern: text(item.action.pattern, 2000) }; }
  else if (item.type === 'subAgentActivity') {
    result.kind = ['started', 'interacted', 'interrupted', 'completed'].includes(item.kind) ? item.kind : null;
    result.agentThreadId = text(item.agentThreadId, 160); result.agentPath = text(item.agentPath, 500);
  } else if (item.type === 'collabAgentToolCall') {
    result.tool = text(item.tool, 100); result.status = text(item.status, 80); result.senderThreadId = text(item.senderThreadId, 200);
    result.receiverThreadIds = (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)).slice(0, 100);
    result.agentsStates = Object.fromEntries(result.receiverThreadIds.flatMap(id => {
      const status = item.agentsStates?.[id]?.status;
      return ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'].includes(status) ? [[id, { status }]] : [];
    }));
  }
  return result;
}
export const MAX_SAFE_TURN_ITEMS = 10000;
export const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
export function safeTurn(turn) {
  if (turn?.items !== undefined && !Array.isArray(turn.items)) fail(502, 'protocol_mismatch', '历史项目格式无效。');
  const source = turn?.items || [];
  if (source.length > MAX_SAFE_TURN_ITEMS) fail(413, 'history_limit', '历史记录超出单次读取上限，未返回不完整内容。');
  const items = []; let bytes = 0;
  for (const raw of source) {
    const item = safeItem(raw); bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes > MAX_HISTORY_BYTES) fail(413, 'history_limit', '历史记录超出单次读取上限，未返回不完整内容。');
    items.push(item);
  }
  return { id: text(turn?.id, 200), status: text(turn?.status, 80), items, ...(['notLoaded', 'summary', 'full'].includes(turn?.itemsView) ? { itemsView: turn.itemsView } : {}) };
}
export function safeThread(thread) { return { id: text(thread?.id, 200), cwd: text(thread?.cwd, 4096), preview: text(thread?.preview, 500), name: text(thread?.name, 200), projectId: text(thread?.projectId, 200) || null, section: thread?.section && typeof thread.section.id === 'string' ? { id: text(thread.section.id, 200), name: text(thread.section.name, 200), appearance: thread.section.appearance && typeof thread.section.appearance === 'object' ? { icon: text(thread.section.appearance.icon, 100) || null, color: text(thread.section.appearance.color, 100) || null } : null } : null, pinned: thread?.section?.id === '01984de2-8f74-7c91-a3b2-5c5e937cf318', sectionEnteredAt: Number.isSafeInteger(thread?.sectionEnteredAt) ? thread.sectionEnteredAt : null, recencyAt: Number.isSafeInteger(thread?.recencyAt) ? thread.recencyAt : null, status: safeThreadStatus(thread?.status), createdAt: Number.isSafeInteger(thread?.createdAt) ? thread.createdAt : null, updatedAt: Number.isSafeInteger(thread?.updatedAt) ? thread.updatedAt : null, parentThreadId: text(thread?.parentThreadId || thread?.source?.subAgent?.thread_spawn?.parent_thread_id, 200) || null, forkedFromId: text(thread?.forkedFromId, 200) || null, source: safeSource(thread?.source), turns: (Array.isArray(thread?.turns) ? thread.turns : []).slice(-100).map(safeTurn) }; }
