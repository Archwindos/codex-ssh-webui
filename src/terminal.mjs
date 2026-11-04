import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fail } from './protocol.mjs';

const HELPER = fileURLToPath(new URL('../scripts/terminal-pty.py', import.meta.url));
const terminalId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
const dimensions = (value = {}, allowDefault = true) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['cols', 'rows'].includes(key)) || (!allowDefault && (!Object.hasOwn(value, 'cols') || !Object.hasOwn(value, 'rows')))) fail(400, 'terminal_size', '终端尺寸无效。');
  const { cols = 80, rows = 24 } = value;
  if (!Number.isInteger(cols) || cols < 10 || cols > 500 || !Number.isInteger(rows) || rows < 2 || rows > 200) fail(400, 'terminal_size', '终端尺寸无效。');
  return { cols, rows };
};
const ownerId = owner => typeof owner === 'string' && owner.length > 0 && owner.length <= 256;

// The relay process carries authentication secrets. Only this environment reaches
// the helper and interactive shell; neither receives the relay's environment.
export function terminalEnvironment(env = process.env) {
  let username = '', home = homedir();
  try { const user = userInfo(); username = user.username; home = user.homedir; } catch { /* USER is optional. */ }
  return { PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, HOME: home, ...(username ? { USER: username, LOGNAME: username } : {}), SHELL: '/bin/bash', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: /^[A-Za-z0-9_.@-]{1,80}$/.test(env.LANG || '') ? env.LANG : 'C.UTF-8', HISTFILE: '/dev/null' };
}

export function createPtyBackend({ cols, rows, onOutput, onExit, spawnProcess = spawn, readyTimeoutMs = 5000 }) {
  const child = spawnProcess('/usr/bin/python3', ['-I', '-u', HELPER, String(cols), String(rows)], { cwd: '/', env: terminalEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = Buffer.alloc(0), ready = false, finished = false, closing = false, closeTimer;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => { rejectReady(new Error('Terminal helper did not start')); stop(); }, readyTimeoutMs);
  readyTimer.unref?.();
  const finish = (code, reason) => {
    if (finished) return;
    finished = true; clearTimeout(readyTimer); clearTimeout(closeTimer);
    if (!ready) rejectReady(new Error('Terminal helper unavailable'));
    onExit(Number.isInteger(code) ? code : null, reason);
  };
  const send = value => {
    if (finished || child.stdin.destroyed) fail(409, 'terminal_closed', '终端已关闭。');
    const line = JSON.stringify(value) + '\n';
    if (child.stdin.writableLength + Buffer.byteLength(line) > 65536) fail(429, 'terminal_input_busy', '终端输入暂时拥堵，本次输入未发送。');
    child.stdin.write(line);
  };
  function stop() {
    if (finished || closing) return;
    closing = true;
    try { send({ type: 'close' }); } catch { child.stdin.end(); }
    closeTimer ??= setTimeout(() => { child.kill('SIGTERM'); }, 1000);
    closeTimer.unref?.();
  }
  child.stdout.on('data', data => {
    if (finished) return;
    pending = Buffer.concat([pending, data]);
    if (pending.length > 131072) { stop(); return; }
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
      try {
        const frame = JSON.parse(line.toString('utf8'));
        if (frame.type === 'ready' && !ready) { ready = true; clearTimeout(readyTimer); resolveReady(); }
        else if (frame.type === 'output' && ready && typeof frame.data === 'string' && frame.data.length <= 12000) onOutput(Buffer.from(frame.data, 'base64'));
        else if (frame.type === 'exit') finish(frame.code, 'exited');
        else throw new Error('Invalid helper frame');
      } catch { stop(); }
    }
  });
  // Consume diagnostics without recording shell content or helper details.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => stop());
  child.on('error', () => finish(null, 'unavailable'));
  child.on('close', code => finish(code, ready ? 'exited' : 'unavailable'));
  return { ready: started, write: data => send({ type: 'input', data: data.toString('base64') }), resize: size => send({ type: 'resize', ...size }), close: stop };
}

export function createTerminalManager({ enabled = true, platform = process.platform, authorizeOwner = () => false, backendFactory = createPtyBackend, clock = Date.now, maxTotal = 8, outputLimit = 262144, pageLimit = 65536, leaseMs = 60000, retentionMs = 60000, maintenanceMs = 5000 } = {}) {
  const records = new Map(), owners = new Map();
  let stopped = false;
  const available = enabled && platform === 'linux';
  const checkOwner = owner => {
    if (!ownerId(owner) || authorizeOwner(owner) !== true) {
      if (ownerId(owner)) closeOwner(owner, 'authentication_expired');
      fail(401, 'session_required', '登录已失效，终端已关闭。');
    }
  };
  const describe = record => ({ id: record.id, cursor: record.cursor, cols: record.cols, rows: record.rows, cwd: '/', closed: record.closed });
  const notify = record => { for (const listener of [...record.listeners]) listener(); };
  function finish(record, code = null, reason = 'closed') {
    if (record.closed) return;
    record.closed = true; record.closedAt = clock(); record.exitCode = code; record.reason = reason;
    if (owners.get(record.owner) === record.id) owners.delete(record.owner);
    notify(record);
  }
  function stop(record, reason) {
    if (record.closed) return;
    finish(record, null, reason);
    record.backend?.close();
  }
  function closeOwner(owner, reason = 'session_closed') {
    for (const record of records.values()) if (record.owner === owner) stop(record, reason);
  }
  const lookup = (owner, id, { touch = true } = {}) => {
    checkOwner(owner);
    if (!terminalId(id)) fail(400, 'terminal_id', '终端标识无效。');
    const record = records.get(id);
    if (!record || record.owner !== owner) fail(404, 'terminal_missing', '终端不存在或已过期。');
    if (!record.closed && clock() - record.lastSeen >= leaseMs) stop(record, 'lease_expired');
    if (touch && !record.closed) record.lastSeen = clock();
    return record;
  };
  const live = (owner, id) => { const record = lookup(owner, id); if (record.closed) fail(409, 'terminal_closed', '终端已关闭，请重新打开。'); return record; };
  const maintenance = () => {
    for (const record of records.values()) {
      if (!record.closed && authorizeOwner(record.owner) !== true) stop(record, 'authentication_expired');
      if (!record.closed && clock() - record.lastSeen >= leaseMs) stop(record, 'lease_expired');
      if (record.closed && record.ended && clock() - record.closedAt >= retentionMs) records.delete(record.id);
    }
    // A rapid sequence of short shells must not accumulate replay buffers.
    for (const record of records.values()) {
      if (records.size < maxTotal * 2) break;
      if (record.closed && record.ended) records.delete(record.id);
    }
  };
  const timer = maintenanceMs > 0 ? setInterval(maintenance, maintenanceMs) : null;
  timer?.unref?.();
  return {
    capability: () => available && !stopped,
    async create(owner, size = {}) {
      checkOwner(owner);
      if (!available || stopped) fail(503, 'terminal_unavailable', '此服务当前不支持临时终端。');
      const { cols, rows } = dimensions(size); maintenance();
      if (owners.has(owner)) fail(409, 'terminal_exists', '此页面已有一个临时终端。');
      if ([...records.values()].filter(record => !record.ended).length >= maxTotal) fail(429, 'terminal_limit', '临时终端已达上限，请稍后再试。');
      // Reserve ownership before awaiting helper startup, including logout races.
      const record = { id: randomBytes(24).toString('base64url'), owner, cols, rows, cursor: 0, base: 0, output: Buffer.alloc(0), closed: false, ended: false, lastSeen: clock(), listeners: new Set(), polling: false, backend: null };
      records.set(record.id, record); owners.set(owner, record.id);
      try {
        record.backend = backendFactory({ cols, rows, onOutput: data => {
          if (record.closed || !Buffer.isBuffer(data)) return;
          record.cursor += data.length;
          record.output = Buffer.concat([record.output, data]);
          if (record.output.length > outputLimit) record.output = record.output.subarray(record.output.length - outputLimit);
          record.base = record.cursor - record.output.length; notify(record);
        }, onExit: (code, reason) => { record.ended = true; finish(record, code, reason); } });
        if (record.closed) record.backend.close();
        await record.backend.ready;
        checkOwner(owner);
        if (record.closed) fail(409, 'terminal_closed', '终端在连接完成前已关闭。');
        return { ...describe(record), cursor: 0 };
      } catch (error) {
        if (!record.backend) record.ended = true;
        stop(record, 'unavailable');
        if (error?.status) throw error;
        fail(503, 'terminal_unavailable', '无法启动临时终端，请检查服务器的 Python 3 与 Bash。');
      }
    },
    async poll(owner, id, cursor = 0, { waitMs = 20000, signal } = {}) {
      const record = lookup(owner, id);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.cursor || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) fail(400, 'terminal_cursor', '终端输出游标无效。');
      if (record.polling) fail(429, 'terminal_poll_busy', '已有终端输出连接。');
      record.polling = true;
      try {
        if (cursor === record.cursor && !record.closed && waitMs > 0 && !signal?.aborted) await new Promise(resolve => {
          const done = () => { clearTimeout(timeout); record.listeners.delete(done); signal?.removeEventListener('abort', done); resolve(); };
          const timeout = setTimeout(done, waitMs); timeout.unref?.();
          record.listeners.add(done); signal?.addEventListener('abort', done, { once: true });
        });
        // Long polls may outlive their browser authentication.
        checkOwner(owner);
        const start = Math.max(cursor, record.base), end = Math.min(record.cursor, start + pageLimit);
        return { id, data: record.output.subarray(start - record.base, end - record.base).toString('base64'), cursor: end, reset: cursor < record.base, hasMore: end < record.cursor, closed: record.closed, exitCode: record.exitCode ?? null, reason: record.reason ?? null };
      } finally { record.polling = false; }
    },
    input(owner, id, data) {
      const record = live(owner, id);
      if (typeof data !== 'string' || data.length > 21848 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail(400, 'terminal_input', '终端输入无效或过长。');
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > 16384 || bytes.toString('base64') !== data) fail(400, 'terminal_input', '终端输入无效或过长。');
      record.backend.write(bytes);
      return { accepted: true };
    },
    resize(owner, id, size) { const record = live(owner, id); const next = dimensions(size, false); record.backend.resize(next); Object.assign(record, next); return { cols: record.cols, rows: record.rows }; },
    heartbeat(owner, id) { const record = lookup(owner, id); return { closed: record.closed }; },
    close(owner, id) { const record = lookup(owner, id); stop(record, 'closed'); return { closed: true }; },
    closeOwner,
    closeAll() { stopped = true; clearInterval(timer); for (const record of records.values()) stop(record, 'server_closed'); },
    maintenance
  };
}
