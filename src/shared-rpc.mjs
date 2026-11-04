import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { METHODS, APPROVALS, RelayError, fail } from './protocol.mjs';

export const SHARED_METHODS = new Set([...METHODS, 'thread/loaded/list', 'thread/unsubscribe', 'turn/steer']);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOTSOCK', 'EINVAL', 'ENAMETOOLONG']);
const disconnected = () => new RelayError(503, 'disconnected', '共享连接已关闭；提交结果可能未知，请检查历史，勿自动重发。');
const protocolError = () => new RelayError(502, 'shared_protocol_error', '共享服务的传输格式无效，已断开本客户端。');
const validId = id => Number.isSafeInteger(id) || (typeof id === 'string' && id.length <= 512);
const machineCode = code => Number.isSafeInteger(code) || (typeof code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(code)) ? code : undefined;

// Every client frame is masked; the only transport action is on this connection.
function frame(opcode, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extra = bytes.length < 126 ? 0 : bytes.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + 4), mask = randomBytes(4);
  header[0] = 0x80 | opcode; header[1] = 0x80 | (extra === 0 ? bytes.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(bytes.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(bytes.length), 2);
  mask.copy(header, 2 + extra);
  const masked = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) masked[i] = bytes[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

export class SharedRpcClient extends EventEmitter {
  constructor(config, { mock = false, request = httpRequest, experimentalApi = true, timeoutMs = 15000, handshakeTimeoutMs = 10000, maxMessageBytes = 16 * 1024 * 1024 } = {}) {
    super();
    this.config = config; this.mock = mock; this.request = request; this.experimentalApi = experimentalApi === true;
    this.timeoutMs = timeoutMs; this.handshakeTimeoutMs = handshakeTimeoutMs; this.maxMessageBytes = maxMessageBytes;
    this.connected = false; this.ended = false; this.counter = 0; this.generation = 0;
    this.instanceId = randomUUID(); this.pending = new Map(); this.closeReason = null;
  }
  start() {
    if (this.starting) return this.starting;
    if (this.connected) return Promise.resolve();
    const socketPath = this.config.sharedDaemonSocket;
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('\0') || socketPath.includes('\n') || socketPath.includes('\r')) return Promise.reject(new RelayError(500, 'configuration', '共享服务需要可信配置中的绝对 Unix socket 路径。'));
    const session = { generation: ++this.generation, pending: new Map(), approvals: new Map(), buffer: Buffer.alloc(0), fragments: null, fragmentBytes: 0, ended: false };
    this.session = session; this.pending = session.pending; this.ended = false; this.connected = false; this.closeReason = null;
    const starting = this.initialize(session, socketPath).finally(() => { if (this.starting === starting) this.starting = null; });
    this.starting = starting;
    return starting;
  }
  async initialize(session, socketPath) {
    try {
      await this.connect(session, socketPath);
      const init = await this.call('initialize', { clientInfo: { name: 'codex-ssh-webui', title: 'Codex SSH WebUI', version: '0.1.0' }, capabilities: { experimentalApi: this.experimentalApi } });
      if (!this.mock && !/(?:^|\D)0\.165\.0(?:\D|$)/.test(init?.userAgent || '')) fail(503, 'protocol_mismatch', '共享服务 CLI 版本与已验证版本不一致。');
      this.notify('initialized', {});
      if (!this.mock) {
        const auth = await this.call('account/read', { refreshToken: false });
        if (auth?.account?.type !== 'chatgpt') fail(503, 'chatgpt_login_required', '共享服务的官方 CLI 必须已使用 ChatGPT 登录。');
      }
      if (session.ended) throw disconnected();
      this.connected = true;
    } catch (error) {
      this.finish(session, error instanceof RelayError ? error : new RelayError(503, 'shared_transport_error', '无法连接共享服务。'));
      throw error instanceof RelayError ? error : new RelayError(503, 'shared_transport_error', '无法连接共享服务。');
    }
  }
  connect(session, socketPath) {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString('base64');
      const expectedAccept = createHash('sha1').update(key + GUID).digest('base64');
      let settled = false;
      const done = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); session.cancelConnect = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { const error = new RelayError(504, 'shared_connect_timeout', '连接共享服务超时。'); done(error); this.finish(session, error); }, this.handshakeTimeoutMs);
      session.cancelConnect = done;
      try {
        const req = this.request({ socketPath, method: 'GET', path: '/', agent: false, headers: { Host: 'localhost', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
        session.request = req;
        req.on('error', error => {
          const safe = new RelayError(503, 'shared_transport_error', '无法连接共享服务。');
          if (TRANSPORT_CODES.has(error.code)) safe.transportCode = error.code;
          done(safe); this.finish(session, safe);
        });
        req.on('response', response => { response.destroy(); const error = protocolError(); done(error); this.finish(session, error); });
        req.on('upgrade', (response, socket, head) => {
          if (session.ended || settled || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket' || !response.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || response.headers['sec-websocket-accept'] !== expectedAccept || response.headers['sec-websocket-extensions'] || response.headers['sec-websocket-protocol']) {
            socket.destroy(); const error = protocolError(); done(error); this.finish(session, error); return;
          }
          session.socket = socket;
          socket.on('data', chunk => this.consume(session, chunk));
          socket.on('error', error => {
            const safe = new RelayError(503, 'shared_transport_error', '共享服务连接已中断。');
            if (TRANSPORT_CODES.has(error.code)) safe.transportCode = error.code;
            this.finish(session, safe);
          });
          socket.on('end', () => this.finish(session, disconnected()));
          socket.on('close', () => this.finish(session, disconnected()));
          done();
          if (head?.length) this.consume(session, head);
        });
        req.end();
      } catch { const error = new RelayError(503, 'shared_transport_error', '无法连接共享服务。'); done(error); this.finish(session, error); }
    });
  }
  consume(session, chunk) {
    if (session.ended) return;
    try {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      while (session.buffer.length >= 2 && !session.ended) {
        const bytes = session.buffer, fin = Boolean(bytes[0] & 0x80), opcode = bytes[0] & 15;
        if (bytes[0] & 0x70 || bytes[1] & 0x80 || ![0, 1, 8, 9, 10].includes(opcode)) throw protocolError();
        let length = bytes[1] & 127, offset = 2;
        if (length === 126) {
          if (bytes.length < 4) break;
          length = bytes.readUInt16BE(2); offset = 4;
          if (length < 126) throw protocolError();
        } else if (length === 127) {
          if (bytes.length < 10) break;
          const bigLength = bytes.readBigUInt64BE(2);
          if (bigLength <= 65535n || bigLength > BigInt(this.maxMessageBytes)) throw protocolError();
          length = Number(bigLength); offset = 10;
        }
        if (length > this.maxMessageBytes || (opcode >= 8 && (!fin || length > 125))) throw protocolError();
        if (bytes.length < offset + length) break;
        const payload = bytes.subarray(offset, offset + length);
        session.buffer = bytes.subarray(offset + length);
        if (opcode === 8) {
          if (length === 1) throw protocolError();
          if (length >= 2 && (payload.readUInt16BE() < 1000 || payload.readUInt16BE() >= 5000 || [1004, 1005, 1006, 1015].includes(payload.readUInt16BE()))) throw protocolError();
          if (length > 2) new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
          const error = disconnected();
          if (length >= 2) error.closeCode = payload.readUInt16BE();
          this.finish(session, error); return;
        }
        if (opcode === 9) { this.writeFrame(session, 10, payload); continue; }
        if (opcode === 10) continue;
        if (opcode === 1) {
          if (session.fragments) throw protocolError();
          session.fragments = []; session.fragmentBytes = 0;
        } else if (!session.fragments) throw protocolError();
        session.fragmentBytes += length;
        if (session.fragmentBytes > this.maxMessageBytes || session.fragments.length >= 4096) throw protocolError();
        session.fragments.push(payload);
        if (fin) {
          const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(session.fragments, session.fragmentBytes)));
          session.fragments = null; session.fragmentBytes = 0;
          this.receive(message, session);
        }
      }
      if (session.buffer.length > this.maxMessageBytes + 10) throw protocolError();
    } catch { this.finish(session, protocolError()); }
  }
  writeFrame(session, opcode, payload) {
    if (!session || session.ended || !session.socket?.writable || session.socket.destroyed) throw disconnected();
    try { session.socket.write(frame(opcode, payload)); }
    catch (error) {
      const safe = new RelayError(503, 'shared_transport_error', '共享服务连接已中断。');
      if (TRANSPORT_CODES.has(error.code)) safe.transportCode = error.code;
      this.finish(session, safe); throw safe;
    }
  }
  write(message) {
    let payload;
    try { payload = Buffer.from(JSON.stringify(message)); }
    catch { fail(400, 'invalid_parameters', '请求无法编码为共享服务消息。'); }
    if (payload.length > this.maxMessageBytes) fail(413, 'rpc_message_too_large', '请求超过共享连接消息大小限制。');
    this.writeFrame(this.session, 1, payload);
  }
  call(method, params) {
    if (!SHARED_METHODS.has(method)) fail(400, 'method_forbidden', '方法不在白名单中。');
    const session = this.session;
    if (!session || session.ended || !session.socket) return Promise.reject(disconnected());
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(id); reject(new RelayError(504, 'rpc_timeout', '共享服务响应超时；结果可能未知，不会自动重发。')); }, this.timeoutMs);
      session.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); session.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.write({ method, params }); }
  requestId(id, session) { return `shared-${this.instanceId}-${session.generation}-${createHash('sha256').update(JSON.stringify(id)).digest('base64url')}`; }
  answer(id, result) {
    const session = this.session;
    if (!session || session.ended || !session.approvals.has(id)) fail(409, 'approval_unavailable', '审批不属于当前共享连接，或已经处理。');
    this.write({ id: session.approvals.get(id), result });
    session.approvals.delete(id);
  }
  receive(message, session = this.session) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw protocolError();
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        if (!validId(message.id)) throw protocolError();
        if (APPROVALS.has(message.method) || message.method === 'item/tool/requestUserInput') {
          const id = this.requestId(message.id, session);
          if (session.approvals.size >= 1000 && !session.approvals.has(id)) throw protocolError();
          session.approvals.set(id, message.id);
          this.emit(message.method === 'item/tool/requestUserInput' ? 'userInput' : 'approval', { ...message, id });
        } else {
          // Another official client may own this request. Never resolve it for them.
          this.emit('unsupported', { method: message.method.slice(0, 160), requestId: this.requestId(message.id, session), ...(typeof message.params?.threadId === 'string' ? { threadId: message.params.threadId.slice(0, 160) } : {}) });
        }
      } else {
        if (message.method === 'serverRequest/resolved' && validId(message.params?.requestId)) {
          const id = this.requestId(message.params.requestId, session);
          session.approvals.delete(id);
          message = { ...message, params: { ...message.params, requestId: id } };
        }
        this.emit('notification', message);
      }
      return;
    }
    if (!validId(message.id) || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) throw protocolError();
    const pending = session.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); session.pending.delete(message.id);
    if (message.error) {
      const error = new RelayError(502, 'upstream_error', '共享服务拒绝了请求，请检查连接状态与所选会话。');
      const code = machineCode(message.error.code);
      if (code !== undefined) error.upstreamCode = code;
      pending.reject(error);
    } else pending.resolve(message.result);
  }
  finish(session, error) {
    if (!session || session.ended) return;
    session.ended = true;
    session.cancelConnect?.(error);
    if (this.session === session) {
      this.connected = false; this.ended = true;
      this.closeReason = { code: error.code, ...(error.transportCode ? { transportCode: error.transportCode } : {}), ...(Number.isInteger(error.closeCode) ? { closeCode: error.closeCode } : {}), ...(error.upstreamCode !== undefined ? { upstreamCode: error.upstreamCode } : {}) };
    }
    for (const { reject, timer } of session.pending.values()) { clearTimeout(timer); reject(disconnected()); }
    session.pending.clear(); session.approvals.clear(); session.buffer = Buffer.alloc(0); session.fragments = null;
    session.request?.destroy(); session.socket?.destroy();
    this.emit('closed', this.closeReason);
  }
  // No process is launched, signaled, or stopped: shared daemon ownership stays external.
  close() { this.finish(this.session, disconnected()); }
}
