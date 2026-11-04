import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection, createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcClient, RelayError, fail } from './protocol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const runOK = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(done => setTimeout(done, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const tmuxFormat = '#{pid}|#{session_id}|#{session_name}|#{window_id}|#{window_index}|#{pane_id}|#{pane_index}|#{pane_pid}';
const safeEnvironment = env => Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL'].filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
const errorOf = (error, fallback = 'runtime_unavailable') => ({ status: error?.status || 503, code: error?.code || fallback, message: '运行连接不可用；提交结果可能未知，请检查历史，勿自动重发。' });
export const WEB_PRESENCE_LEASE_MS = 90000;
const presenceClientOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const approvalId = (runId, id) => `${runId}:${Buffer.from(JSON.stringify(id)).toString('base64url')}`;

export function parseRuntimePane(output) {
  const lines = String(output).trim().split('\n');
  if (lines.length !== 1) fail(409, 'runtime_identity', 'tmux 运行身份无法核对。');
  const [serverPid, sessionId, sessionName, windowId, windowIndex, paneId, paneIndex, panePid, extra] = lines[0].split('|');
  if (extra !== undefined || !/^\$\d+$/.test(sessionId || '') || !/^@\d+$/.test(windowId || '') || !/^%\d+$/.test(paneId || '') || !/^codex-chat-[a-f0-9]{16}$/.test(sessionName || '') || ![serverPid, windowIndex, paneIndex, panePid].every(value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value))) || Number(serverPid) < 2 || Number(panePid) < 2) fail(409, 'runtime_identity', 'tmux 运行身份无法核对。');
  return { serverPid: Number(serverPid), sessionId, sessionName, windowId, windowIndex: Number(windowIndex), paneId, paneIndex: Number(paneIndex), panePid: Number(panePid) };
}

// Only this narrow platform layer touches Linux processes, tmux and private IPC.
export function createRuntimePlatform({ root = ROOT, filesystem = fs, exec = execute, env = process.env, uid = () => process.getuid(), pid = () => process.pid, node = process.execPath, clock = Date.now, recoveryMutex } = {}) {
  const runsRoot = join(root, 'runtime', 'runs'), lockRoot = join(root, 'runtime', 'thread-locks'), freezeRoot = join(root, 'runtime', 'thread-freezes'), preferencesRoot = join(root, 'runtime', 'thread-preferences');
  const socketPath = () => `/tmp/tmux-${uid()}/default`;
  const privatePath = async (path, kind, mode) => {
    const info = await filesystem.lstat(path);
    if (info.uid !== uid() || (info.mode & 0o777) !== mode || !info[kind]() || info.isSymbolicLink()) fail(409, 'runtime_permissions', '运行目录或文件权限无法核对。');
    return info;
  };
  const privateDirectory = async path => {
    await privatePath(path, 'isDirectory', 0o700);
    if (await filesystem.realpath(path) !== path) fail(409, 'runtime_permissions', '运行目录链接无法核对。');
  };
  const readJSON = async path => {
    const info = await privatePath(path, 'isFile', 0o600);
    if (info.size > 2 * 1024 * 1024) fail(409, 'runtime_record', '运行记录超出限制。');
    return JSON.parse(await filesystem.readFile(path, 'utf8'));
  };
  const writeJSON = async (path, value, exclusive = false) => {
    const data = JSON.stringify(value) + '\n';
    if (exclusive) return filesystem.writeFile(path, data, { flag: 'wx', mode: 0o600 });
    const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
    await filesystem.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    try { await filesystem.rename(temporary, path); } finally { await filesystem.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  const processRelation = async pid => {
    const folder = `/proc/${pid}`, info = await filesystem.stat(folder);
    if (info.uid !== uid()) fail(409, 'runtime_process_owner', '运行进程所有者不匹配。');
    const text = await filesystem.readFile(`${folder}/stat`, 'utf8'), end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || !/^\d+$/.test(fields[19] || '') || !fields.slice(1, 5).every(value => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) || fields.slice(1, 4).some(value => Number(value) < 0)) fail(409, 'runtime_identity', '进程关系身份无法核对。');
    if (fields[0] === 'Z') return null;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), tty: Number(fields[4]), startTicks: fields[19] };
  };
  const getProcess = async (pid, { allowIdentityUnavailable = false } = {}) => {
    try {
      const folder = `/proc/${pid}`, relation = await processRelation(pid);
      if (!relation) return null;
      let executable, raw;
      try { executable = await filesystem.readlink(`${folder}/exe`); raw = await filesystem.readFile(`${folder}/cmdline`); }
      catch (error) {
        if (!allowIdentityUnavailable || !['EACCES', 'EPERM'].includes(error.code)) throw error;
        // Non-dumpable same-UID processes may hide exe/cmdline. Keep their
        // relationship identity; unreadable or changed stat remains an error.
        if (!same(relation, await processRelation(pid))) fail(409, 'runtime_identity', '不可读进程的关系身份已改变。');
        return { ...relation, identityUnavailable: true };
      }
      if (raw[raw.length - 1] !== 0) throw Error('cmdline');
      const commandline = raw.subarray(0, -1).toString('utf8').split('\0');
      if (!same(relation, await processRelation(pid))) fail(409, 'runtime_identity', '进程身份已改变。');
      return { ...relation, executable, commandline };
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  };
  const processMatches = (expected, actual) => actual && ['pid', 'startTicks', 'executable'].every(key => expected[key] === actual[key]) && same(expected.commandline, actual.commandline);
  const socketInfo = async (missing = false) => {
    const path = socketPath(), parent = dirname(path);
    try {
      await privateDirectory(parent);
      const info = await filesystem.lstat(path);
      if (!info.isSocket() || info.uid !== uid() || ![0o600, 0o660].includes(info.mode & 0o777)) fail(409, 'runtime_socket', '默认 tmux socket 身份无法核对。');
      return info;
    } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  };
  const tmux = async args => {
    try { return { ...(await exec('/usr/bin/tmux', ['-S', socketPath(), ...args], { timeout: 5000, maxBuffer: 262144, env: safeEnvironment(env), windowsHide: true })), code: 0 }; }
    catch (error) { if (Number.isInteger(error.code)) return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; throw error; }
  };
  const serverState = async (reference, missing = false) => {
    const info = await socketInfo(missing);
    if (!info) return null;
    if (reference && (reference.socket !== socketPath() || reference.socketDevice !== info.dev || reference.socketInode !== info.ino)) fail(409, 'runtime_socket_changed', '默认 tmux socket 已改变。');
    const result = await tmux(['display-message', '-p', '#{pid}']);
    if (missing && result.code === 1) return null; // tmux itself handles its closed socket on the next normal new-session.
    if (result.code || result.stderr || !/^\d+\s*$/.test(result.stdout)) fail(409, 'runtime_identity', '默认 tmux 服务无法核对。');
    const server = await getProcess(Number(result.stdout.trim()));
    if (!server || server.executable !== '/usr/bin/tmux' || (reference && (server.pid !== reference.serverPid || server.startTicks !== reference.serverStartTicks))) fail(409, 'runtime_identity', '默认 tmux 服务身份已改变。');
    return { socket: socketPath(), serverPid: server.pid, serverStartTicks: server.startTicks, socketDevice: info.dev, socketInode: info.ino };
  };
  const validReceipt = receipt => {
    if (!receipt || receipt.schemaVersion !== 1 || !runOK(receipt.id) || receipt.root !== root || receipt.worker?.executable !== node || !same(receipt.worker?.commandline, [node, join(root, 'src', 'runtime-worker.mjs'), '--run-dir', join(runsRoot, receipt.id)]) || !Number.isSafeInteger(receipt.worker?.pid) || receipt.worker.pid < 2 || !/^\d+$/.test(receipt.worker.startTicks || '') || receipt.tmux?.sessionName !== `codex-chat-${receipt.id}` || receipt.tmux?.panePid !== receipt.worker?.pid || !/^\$\d+$/.test(receipt.tmux?.sessionId || '') || !/^%\d+$/.test(receipt.tmux?.paneId || '') || (receipt.threadId !== null && !idOK(receipt.threadId))) fail(409, 'runtime_record', '运行记录身份无效。');
    return receipt;
  };
  const verify = async (value, { requireCodex = true } = {}) => {
    const receipt = validReceipt(value);
    await privateDirectory(join(runsRoot, receipt.id));
    if (!await serverState(receipt.tmux, true)) return null;
    const result = await tmux(['list-panes', '-s', '-t', receipt.tmux.sessionId, '-F', tmuxFormat]);
    if (result.code === 1) return null;
    if (result.code || result.stderr) fail(409, 'runtime_identity', 'tmux 运行区无法核对。');
    const line = result.stdout.split('\n').find(line => line.split('|')[5] === receipt.tmux.paneId);
    if (!line) return null;
    const pane = parseRuntimePane(line);
    if (['serverPid', 'sessionId', 'sessionName', 'windowId', 'paneId', 'panePid'].some(key => pane[key] !== receipt.tmux[key])) fail(409, 'runtime_identity', 'tmux pane 身份已改变。');
    if (!processMatches(receipt.worker, await getProcess(receipt.worker.pid))) return null;
    const codex = requireCodex && receipt.codex ? await getProcess(receipt.codex.pid) : null;
    if (requireCodex && (!receipt.codex || !processMatches(receipt.codex, codex))) return null;
    if (requireCodex && (codex.ppid !== receipt.worker.pid || basename(receipt.codex.executable) !== 'codex' || !same(receipt.codex.commandline.slice(1), ['app-server']))) fail(409, 'runtime_identity', '官方 Codex 子进程身份无法核对。');
    await serverState(receipt.tmux);
    return { ...receipt, tmux: { ...receipt.tmux, windowIndex: pane.windowIndex, paneIndex: pane.paneIndex } };
  };
  const guard = join(root, 'runtime', 'admission.guard');
  // The kernel releases an abstract socket even after SIGKILL. It only elects
  // a stale-guard reclaimer; ordinary admissions still own the private guard.
  // No recovery lock file can itself become another abandoned filesystem lock.
  const withRecovery = recoveryMutex || (async operation => {
    const server = createServer(socket => socket.destroy());
    const name = '\0codex-relay-recover-' + hash([uid(), root]);
    try {
      const acquired = await new Promise((done, reject) => {
        server.once('error', error => error.code === 'EADDRINUSE' ? done(false) : reject(error));
        server.listen(name, () => done(true));
      });
      if (!acquired) return false;
      return await operation();
    } finally { if (server.listening) await new Promise(done => server.close(done)); }
  });
  const inodeMatches = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const readGuard = async path => {
    const info = await privatePath(path, 'isDirectory', 0o700);
    if (await filesystem.realpath(path) !== path) fail(409, 'runtime_admission_unknown', '准入目录身份未知，不会回收。');
    const ownerInfo = await privatePath(join(path, 'owner.json'), 'isFile', 0o600);
    const owner = await readJSON(join(path, 'owner.json'));
    if (!owner || !same(Object.keys(owner).sort(), ['executable', 'owner', 'pid', 'schemaVersion', 'startTicks']) || owner.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(owner.owner || '') || !Number.isSafeInteger(owner.pid) || owner.pid < 2 || !/^\d+$/.test(owner.startTicks || '') || owner.executable !== node) fail(409, 'runtime_admission_unknown', '准入持有者身份未知，不会回收。');
    const entries = (await filesystem.readdir(path)).sort();
    if (!entries.length) throw Object.assign(Error('guard changed'), { code: 'ENOENT' });
    if (!same(entries, ['owner.json'])) fail(409, 'runtime_admission_unknown', '准入目录包含未知记录，不会回收。');
    if (!inodeMatches(info, await filesystem.lstat(path)) || !inodeMatches(ownerInfo, await filesystem.lstat(join(path, 'owner.json')))) fail(409, 'runtime_admission_changed', '准入目录或记录身份已改变。');
    return { info, ownerInfo, owner };
  };
  const guardOwnerDead = async owner => {
    const current = await getProcess(owner.pid);
    if (!current || current.startTicks !== owner.startTicks) return true;
    if (current.executable !== owner.executable) fail(409, 'runtime_admission_unknown', '准入持有者已改变执行身份，不会回收。');
    return false;
  };
  const recoverGuard = () => withRecovery(async () => {
    let previous;
    try { previous = await readGuard(guard); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!await guardOwnerDead(previous.owner)) return false;
    const again = await readGuard(guard);
    if (!inodeMatches(previous.info, again.info) || !inodeMatches(previous.ownerInfo, again.ownerInfo) || !same(previous.owner, again.owner) || !await guardOwnerDead(again.owner)) fail(409, 'runtime_admission_changed', '准入锁在回收前已经改变。');
    const stale = join(root, 'runtime', `admission.stale-${randomBytes(16).toString('hex')}`);
    await filesystem.rename(guard, stale);
    // The recovery mutex forbids another reclaimer from applying an old
    // snapshot to the fresh guard created at the standard path after rename.
    const moved = await readGuard(stale);
    if (!inodeMatches(previous.info, moved.info) || !inodeMatches(previous.ownerInfo, moved.ownerInfo) || !same(previous.owner, moved.owner)) fail(409, 'runtime_admission_changed', '隔离后的旧准入锁身份不匹配。');
    await filesystem.unlink(join(stale, 'owner.json')); await filesystem.rmdir(stale);
    return true;
  });
  const admission = async operation => {
    const identity = await getProcess(pid());
    if (!identity || identity.executable !== node) fail(409, 'runtime_admission_unknown', '当前准入进程身份无法核对。');
    const owner = { schemaVersion: 1, owner: randomBytes(16).toString('hex'), pid: identity.pid, startTicks: identity.startTicks, executable: identity.executable };
    for (let attempt = 0; ; attempt++) {
      try { await filesystem.mkdir(guard, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (await recoverGuard()) continue; if (attempt >= 39) fail(409, 'runtime_admission_busy', '准入操作正在进行或持有者未知；不会按超时移除。'); await delay(10); }
    }
    const directory = await privatePath(guard, 'isDirectory', 0o700);
    try {
      await writeJSON(join(guard, 'owner.json'), owner, true);
      return await operation();
    } finally {
      const current = await readGuard(guard);
      if (!same(current.owner, owner) || !inodeMatches(current.info, directory)) fail(409, 'runtime_admission_changed', '准入锁已改变。');
      await filesystem.unlink(join(guard, 'owner.json')); await filesystem.rmdir(guard);
    }
  };
  const maybeJSON = async path => { try { return await readJSON(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const assertUnfrozen = async threadId => { if (await maybeJSON(join(freezeRoot, `${threadId}.json`))) fail(409, 'thread_frozen', '会话正在处理归档操作，请先完成或明确恢复该操作。'); };
  const lockPath = threadId => join(lockRoot, `${threadId}.json`);
  const sameOwner = (a, b) => a?.runId === b?.runId && a?.worker?.pid === b?.worker?.pid && a?.worker?.startTicks === b?.worker?.startTicks;
  const assertLock = async (threadId, owner) => {
    if (!idOK(threadId) || !sameOwner(await maybeJSON(lockPath(threadId)), owner)) fail(409, 'thread_writer_changed', '会话运行写入者已改变。');
    await assertUnfrozen(threadId);
  };
  const preference = async threadId => {
    if (!idOK(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    const value = await maybeJSON(join(preferencesRoot, `${threadId}.json`));
    if (value && (value.schemaVersion !== 1 || value.threadId !== threadId || typeof value.keepRunning !== 'boolean')) fail(409, 'runtime_preference_unknown', '会话运行偏好无法核对。');
    return { threadId, keepRunning: value?.keepRunning ?? false };
  };
  const presencePath = join(root, 'runtime', 'web-presence.json');
  const readPresence = async () => {
    const value = await maybeJSON(presencePath);
    if (!value) return [];
    if (value.schemaVersion !== 1 || !Array.isArray(value.leases) || value.leases.length > 1000 || value.leases.some(lease => !presenceClientOK(lease?.clientId) || !idOK(lease.threadId) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0) || new Set(value.leases.map(lease => lease.clientId)).size !== value.leases.length) fail(409, 'runtime_presence_unknown', '网页连接记录无法核对，不会自动回收。');
    return value.leases;
  };
  const webPresence = async threadId => {
    if (!idOK(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    return { threadId, connected: (await readPresence()).some(lease => lease.threadId === threadId && lease.expiresAt > clock()), leaseMs: WEB_PRESENCE_LEASE_MS };
  };
  const processes = async () => {
    const result = [];
    for (const name of await filesystem.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if ((await filesystem.stat(`/proc/${name}`)).uid !== uid()) continue;
        const entry = await getProcess(Number(name), { allowIdentityUnavailable: true });
        if (entry) result.push(entry);
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    return result;
  };
  const cleanupIdentity = async receipt => {
    if (!await verify(receipt)) fail(409, 'runtime_identity', '运行身份无法核对，不会回收。');
    const listed = await tmux(['list-panes', '-s', '-t', receipt.tmux.sessionId, '-F', tmuxFormat]);
    if (listed.code || listed.stderr || listed.stdout.trim().split('\n').length !== 1) fail(409, 'runtime_shared', '运行区含其他窗格，不会自动回收。');
    const pane = parseRuntimePane(listed.stdout);
    if (['serverPid', 'sessionId', 'sessionName', 'windowId', 'paneId', 'panePid'].some(key => pane[key] !== receipt.tmux[key])) fail(409, 'runtime_identity', '运行区身份已改变。');
    const attached = await tmux(['display-message', '-p', '-t', receipt.tmux.sessionId, '#{session_attached}']);
    if (attached.code || attached.stderr || !/^0\s*$/.test(attached.stdout)) fail(409, 'runtime_attached', '终端已连接或连接状态未知，不会自动回收。');
    const all = await processes(), descendants = new Set([receipt.worker.pid]);
    for (let changed = true; changed;) { changed = false; for (const entry of all) if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) { descendants.add(entry.pid); changed = true; } }
    const ownedIds = new Set([receipt.worker.pid, receipt.codex.pid]);
    if (!all.some(entry => processMatches(receipt.worker, entry)) || !all.some(entry => processMatches(receipt.codex, entry)) || [...descendants].some(pid => !ownedIds.has(pid)) || all.some(entry => !ownedIds.has(entry.pid) && (entry.sid === receipt.worker.sid || receipt.worker.tty !== 0 && entry.tty === receipt.worker.tty))) fail(409, 'runtime_child_process', '运行进程树或终端会话有其他命令，不会自动回收。');
    return { pane, identities: all.filter(entry => descendants.has(entry.pid)) };
  };
  return {
    root, runsRoot, readJSON, writeJSON, getProcess, processMatches, verify, tmux, serverState, admission, processes, cleanupIdentity,
    getKeepRunning: preference,
    getWebPresence: webPresence,
    async setWebPresence(clientId, threadId) {
      if (!presenceClientOK(clientId) || (threadId !== null && !idOK(threadId))) fail(400, 'invalid_presence', '网页连接标识或会话无效。');
      return admission(async () => {
        const now = clock(), leases = (await readPresence()).filter(lease => lease.expiresAt > now && lease.clientId !== clientId);
        if (threadId !== null) { if (leases.length >= 1000) fail(429, 'runtime_presence_limit', '网页连接记录已满，请稍后重试。'); leases.push({ clientId, threadId, expiresAt: now + WEB_PRESENCE_LEASE_MS }); }
        await writeJSON(presencePath, { schemaVersion: 1, leases });
        return { threadId, connected: threadId !== null, leaseMs: WEB_PRESENCE_LEASE_MS };
      });
    },
    async setKeepRunning(threadId, keepRunning) {
      if (typeof keepRunning !== 'boolean') fail(400, 'invalid_preference', '持续运行设置无效。');
      return admission(async () => { await preference(threadId); await writeJSON(join(preferencesRoot, `${threadId}.json`), { schemaVersion: 1, threadId, keepRunning }); return { threadId, keepRunning }; });
    },
    async cleanupAdmitted(threadId, owner, operation) { return admission(async () => { await assertLock(threadId, owner); if ((await preference(threadId)).keepRunning) fail(409, 'runtime_keep_running', '会话已设置持续运行。'); if ((await webPresence(threadId)).connected) fail(409, 'runtime_web_connected', '网页仍连接此会话，不会自动回收。'); return operation(); }); },
    async secureSocket(path) { await filesystem.chmod(path, 0o600); await privatePath(path, 'isSocket', 0o600); },
    runDir: id => { if (!runOK(id)) fail(400, 'invalid_run', '运行 id 无效。'); return join(runsRoot, id); },
    async initialize() {
      if (process.platform !== 'linux' && filesystem === fs) fail(503, 'runtime_platform', '独立运行区需要 Linux 默认 tmux 服务。');
      await privateDirectory(root); await privateDirectory(join(root, 'runtime'));
      for (const path of [runsRoot, lockRoot, freezeRoot, preferencesRoot]) { await filesystem.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await privateDirectory(path); }
      // Explicit -S bypasses tmux's ordinary creation of its default directory.
      // Create only this standard UID directory; never chmod an existing one.
      const directory = dirname(socketPath());
      await filesystem.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await privateDirectory(directory);
    },
    async receipts() {
      const entries = await filesystem.readdir(runsRoot), result = [];
      for (const id of entries.filter(runOK)) { try { result.push(validReceipt(await readJSON(join(runsRoot, id, 'receipt.json')))); } catch { /* Incomplete/invalid receipts never claim a live runner. */ } }
      return result;
    },
    async launch(id, launch) {
      const directory = this.runDir(id); await filesystem.mkdir(directory, { mode: 0o700 });
      await writeJSON(join(directory, 'launch.json'), launch, true);
      const previous = await serverState(null, true), sessionName = `codex-chat-${id}`;
      if (previous) { const sessions = await tmux(['list-sessions', '-F', '#{session_name}']); if (sessions.code || sessions.stderr) fail(409, 'runtime_identity', 'tmux 服务无法核对。'); if (sessions.stdout.split('\n').includes(sessionName)) fail(409, 'runtime_session_exists', '同名 tmux session 已存在，不会接管。'); }
      const commandline = [node, join(root, 'src', 'runtime-worker.mjs'), '--run-dir', directory];
      const cleanEnv = ['/usr/bin/env', '-i', ...Object.entries(safeEnvironment(env)).map(([key, value]) => `${key}=${value}`)];
      // Expand only tmux's own two identity variables in the newly allocated
      // pane shell; all other inherited server variables remain excluded.
      const command = 'exec ' + cleanEnv.map(shellQuote).join(' ') + ' "TMUX=$TMUX" "TMUX_PANE=$TMUX_PANE" ' + commandline.map(shellQuote).join(' ');
      const created = await tmux(['new-session', '-d', '-P', '-F', tmuxFormat, '-s', sessionName, '-n', 'codex', '-c', launch.params.cwd || root, command]);
      if (created.code || created.stderr) fail(503, 'runtime_start_failed', '独立运行启动失败；不会接管已有 session。');
      const pane = parseRuntimePane(created.stdout), server = await serverState(previous);
      if (pane.sessionName !== sessionName || pane.serverPid !== server.serverPid) fail(409, 'runtime_identity', '新运行身份无法核对。');
      let worker;
      for (let n = 0; n < 40; n++) { worker = await getProcess(pane.panePid); if (worker?.executable === node && same(worker.commandline, commandline)) break; worker = null; await delay(50); }
      if (!worker) fail(409, 'runtime_identity', '新 runner 进程身份无法核对。');
      const receipt = { schemaVersion: 1, id, root, cwd: launch.params.cwd || null, threadId: null, createdAt: clock(), worker, codex: null, tmux: { ...server, ...pane } };
      await writeJSON(join(directory, 'receipt.json'), receipt, true);
      return receipt;
    },
    async readReceipt(id) { return validReceipt(await readJSON(join(this.runDir(id), 'receipt.json'))); },
    async reconcileAbsent(receipt) {
      return admission(async () => {
        validReceipt(receipt);
        if (![1, 2].includes(receipt.lifecycle?.version) || receipt.closed || !receipt.threadId) return false;
        await assertUnfrozen(receipt.threadId);
        for (const expected of [receipt.worker, receipt.codex].filter(Boolean)) if ((await getProcess(expected.pid))?.startTicks === expected.startTicks) return false;
        // A dead runner is not evidence that a surviving pane is disposable.
        // Only reconcile a proven missing owned pane; never touch tmux here.
        const server = await serverState(receipt.tmux, true);
        if (server) {
          const listed = await tmux(['list-panes', '-s', '-t', receipt.tmux.sessionId, '-F', tmuxFormat]);
          if (listed.code !== 1) {
            if (listed.code || listed.stderr) return false;
            if (listed.stdout.split('\n').some(line => line.split('|')[5] === receipt.tmux.paneId)) return false;
          }
        }
        const current = await this.readReceipt(receipt.id);
        if (!same(current, receipt)) return false;
        await writeJSON(join(this.runDir(receipt.id), 'receipt.json'), { ...receipt, closed: true, cleanupReason: 'already_absent' });
        return true;
      });
    },
    async connect(receipt) {
      const path = join(this.runDir(receipt.id), 'control.sock'); await privatePath(path, 'isSocket', 0o600);
      return WorkerConnection.connect(path);
    },
    async stop(receipt, { idle = false } = {}) {
      validReceipt(receipt);
      if (receipt.codex && (!Number.isSafeInteger(receipt.codex.pid) || receipt.codex.pid < 2 || !/^\d+$/.test(receipt.codex.startTicks || '') || typeof receipt.codex.executable !== 'string' || basename(receipt.codex.executable) !== 'codex' || receipt.codex.ppid !== receipt.worker.pid || !Array.isArray(receipt.codex.commandline) || !same(receipt.codex.commandline.slice(1), ['app-server']))) fail(409, 'runtime_record', '官方 Codex 记录身份无效。');
      const worker = await getProcess(receipt.worker.pid), codex = receipt.codex && await getProcess(receipt.codex.pid);
      const originalWorkerAlive = worker?.startTicks === receipt.worker.startTicks;
      const originalCodexAlive = !!receipt.codex && codex?.startTicks === receipt.codex.startTicks;
      // A closed receipt belongs to its original process identities, not to a
      // later default server or unrelated processes which reused those PIDs.
      if (!originalWorkerAlive && !originalCodexAlive) return { alreadyAbsent: true };
      if (!await verify(receipt, { requireCodex: false })) {
        if (await getProcess(receipt.worker.pid) || (receipt.codex && await getProcess(receipt.codex.pid))) fail(409, 'runtime_identity', '运行身份改变，不会停止。');
        return;
      }
      const currentCodex = receipt.codex && await getProcess(receipt.codex.pid);
      if (currentCodex && (!processMatches(receipt.codex, currentCodex) || currentCodex.ppid !== receipt.worker.pid)) fail(409, 'runtime_identity', '官方 Codex 身份已改变，不会停止。');
      let result;
      if (idle) {
        // Evaluate attachment and pane/window ownership on the tmux server's
        // command queue immediately before mutation, not in an earlier probe.
        const checks = [['pid', receipt.tmux.serverPid], ['session_id', receipt.tmux.sessionId], ['session_name', receipt.tmux.sessionName], ['window_id', receipt.tmux.windowId], ['pane_id', receipt.tmux.paneId], ['pane_pid', receipt.worker.pid], ['session_attached', 0], ['session_windows', 1], ['window_panes', 1], ['pane_dead', 0]].map(([key, value]) => `#{==:#{${key}},${value}}`);
        const condition = checks.reduceRight((right, left) => right ? `#{&&:${left},${right}}` : left, '');
        result = await tmux(['if-shell', '-F', '-t', receipt.tmux.paneId, condition, `kill-pane -t ${receipt.tmux.paneId}`, 'display-message -p runtime_cleanup_blocked']);
        if (result.stdout?.includes('runtime_cleanup_blocked')) fail(409, 'runtime_changed', '终端连接或窗格状态在停止前改变，不会自动回收。');
      } else result = await tmux(['kill-pane', '-t', receipt.tmux.paneId]);
      if (result.code || result.stderr) fail(409, 'runtime_stop_failed', '独立运行未确认关闭。');
      for (let n = 0; n < 60; n++) { if (!await getProcess(receipt.worker.pid) && (!receipt.codex || !await getProcess(receipt.codex.pid))) return; await delay(50); }
      fail(409, 'runtime_stop_failed', '运行进程仍然在线，请重新核对。');
    },
    async claimThread(threadId, owner) {
      if (!idOK(threadId) || !runOK(owner?.runId)) fail(400, 'invalid_thread', '会话 id 无效。');
      return admission(async () => {
        await assertUnfrozen(threadId);
        const previous = await maybeJSON(lockPath(threadId));
        if (previous && !sameOwner(previous, owner)) {
          const identities = [previous.worker, previous.codex].filter(Boolean);
          if (previous.schemaVersion !== 1 || previous.threadId !== threadId || !runOK(previous.runId) || !previous.worker || identities.some(item => !Number.isSafeInteger(item.pid) || item.pid < 2 || !/^\d+$/.test(item.startTicks || ''))) fail(409, 'thread_writer_unknown', '原写入者身份未知，不会接管。');
          for (const expected of [previous.worker, previous.codex].filter(Boolean)) {
            const current = await getProcess(expected.pid);
            if (current?.startTicks === expected.startTicks) fail(409, 'thread_writer_busy', '该会话已有独立运行写入者。');
          }
          if (!same(previous, await readJSON(lockPath(threadId)))) fail(409, 'thread_writer_changed', '会话写入者已改变。');
        }
        await writeJSON(lockPath(threadId), { schemaVersion: 1, threadId, ...owner });
      });
    },
    async admitted(threadId, owner, operation) {
      // Dispatch while the guard is held; do not hold it during the RPC wait.
      let pending;
      await admission(async () => { await assertLock(threadId, owner); pending = Promise.resolve(operation()).then(value => ({ value }), error => ({ error })); });
      const result = await pending;
      if (result.error) throw result.error;
      return result.value;
    },
    async releaseThread(threadId, owner) {
      await admission(async () => { const previous = await maybeJSON(lockPath(threadId)); if (previous && sameOwner(previous, owner)) { if (previous.codex && (await getProcess(previous.codex.pid))?.startTicks === previous.codex.startTicks) fail(409, 'thread_writer_busy', '官方 Codex 仍在线，保留写入者锁。'); await filesystem.unlink(lockPath(threadId)); } });
    },
    async freezeThreads(threadIds, operationId) {
      if (!idOK(operationId) || !Array.isArray(threadIds) || !threadIds.length || threadIds.length > 1000 || threadIds.some(id => !idOK(id))) fail(400, 'invalid_freeze', '归档冻结参数无效。');
      const ids = [...new Set(threadIds)];
      await admission(async () => {
        const created = [];
        for (const id of ids) { const prior = await maybeJSON(join(freezeRoot, `${id}.json`)); if (prior && prior.operationId !== operationId) fail(409, 'thread_frozen', '会话已由另一个操作冻结。'); }
        try {
          for (const id of ids) {
            const path = join(freezeRoot, `${id}.json`);
            if (await maybeJSON(path)) continue;
            const value = { schemaVersion: 1, threadId: id, operationId }, temporary = `${path}.new-${randomBytes(16).toString('hex')}`;
            try {
              await writeJSON(temporary, value, true);
              const info = await privatePath(temporary, 'isFile', 0o600);
              // Publish a complete marker exclusively; a failed write cannot
              // leave a truncated marker at the authoritative thread path.
              await filesystem.link(temporary, path);
              created.push({ path, value, info });
            } finally { await filesystem.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          }
        } catch (error) {
          for (const entry of created.reverse()) {
            const current = await maybeJSON(entry.path);
            if (current?.operationId === operationId && same(current, entry.value) && inodeMatches(entry.info, await filesystem.lstat(entry.path))) await filesystem.unlink(entry.path);
          }
          throw error;
        }
      });
      return { operationId, threadIds: ids, release: () => this.releaseThreads(ids, operationId) };
    },
    async releaseThreads(threadIds, operationId) {
      if (!idOK(operationId) || !Array.isArray(threadIds) || threadIds.some(id => !idOK(id))) fail(400, 'invalid_freeze', '归档冻结参数无效。');
      await admission(async () => {
        for (const id of threadIds) { const value = await maybeJSON(join(freezeRoot, `${id}.json`)); if (value && value.operationId !== operationId) fail(409, 'thread_frozen', '只能由创建冻结的操作释放。'); }
        for (const id of threadIds) { const path = join(freezeRoot, `${id}.json`); if (await maybeJSON(path)) await filesystem.unlink(path); }
      });
    }
  };
}

export class WorkerConnection extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.pending = new Map(); this.counter = 0; this.ended = false; let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        let message; try { message = JSON.parse(buffer.slice(0, index)); } catch { socket.destroy(); return; } buffer = buffer.slice(index + 1);
        if (message.event) this.emit('event', message);
        else { const pending = this.pending.get(message.id); if (!pending) continue; clearTimeout(pending.timer); this.pending.delete(message.id); if (message.error) pending.reject(new RelayError(message.error.status || 503, message.error.code || 'runtime_error', message.error.message)); else pending.resolve(message.result); }
      }
    });
    const closed = () => { if (this.ended) return; this.ended = true; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RelayError(503, 'runtime_disconnected', '运行连接已关闭；提交结果可能未知，不会自动重发。')); } this.pending.clear(); this.emit('closed'); };
    socket.on('close', closed); socket.on('error', closed);
  }
  static async connect(path) { const socket = createConnection(path); await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); }); return new WorkerConnection(socket); }
  call(op, params = {}) {
    if (this.ended) fail(503, 'runtime_disconnected', '运行连接已关闭；不会自动重发。');
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RelayError(504, 'runtime_timeout', '运行响应超时；结果可能未知，不会自动重发。')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }
  close() { this.socket.destroy(); }
}

export class RuntimeRpc extends EventEmitter {
  constructor(config, { mock = false, root = ROOT, clock = Date.now, rpcFactory = (config, options) => new RpcClient(config, options), platform = createRuntimePlatform({ root, clock }), connectWorker } = {}) {
    super(); this.config = config; this.mock = mock; this.platform = platform; this.connectWorker = connectWorker || (receipt => platform.connect(receipt));
    this.library = rpcFactory(config, { mock, experimentalApi: true }); this.runs = new Map(); this.threadRuns = new Map(); this.creating = new Map(); this.preferences = new Map(); this.presence = new Map(); this.clock = clock; this.ended = false; this.connected = false;
    this.library.on('closed', () => { this.ended = true; this.connected = false; this.emit('closed'); });
    for (const event of ['notification', 'approval', 'unsupported']) this.library.on(event, message => {
      if (this.mock || event === 'unsupported') this.emit(event, message);
      else if (event === 'approval') { try { this.library.answer(message.id, { decision: 'decline' }); } catch {} this.emit('unsupported'); }
    });
  }
  get child() { return this.library.child; }
  ownsPid(pid) { return this.library.child?.pid === pid || [...this.runs.values()].some(run => run.receipt.codex?.pid === pid || run.receipt.worker?.pid === pid); }
  async start() {
    await this.library.start();
    if (!this.mock) { await this.platform.initialize(); for (const receipt of await this.platform.receipts()) { try { if (await this.platform.verify(receipt)) await this.attach(receipt); } catch { /* An unknown identity is never revived or terminated. */ } } }
    this.connected = true;
  }
  async attach(receipt) {
    const existing = this.runs.get(receipt.id); if (existing && !existing.connection.ended) return existing;
    const connection = await this.connectWorker(receipt), run = { receipt, connection, cursor: existing?.cursor || 0, snapshot: null };
    connection.on('event', event => {
      if (!Number.isSafeInteger(event.cursor) || event.cursor <= run.cursor) return;
      run.cursor = event.cursor;
      if (event.snapshot) run.snapshot = event.snapshot;
      if (event.event === 'approval') this.emit('approval', { ...event.data, id: approvalId(receipt.id, event.data.id) });
      else if (event.event === 'notification') {
        const message = clone(event.data);
        if (message.method === 'serverRequest/resolved') message.params.requestId = approvalId(receipt.id, message.params.requestId);
        this.emit('notification', message);
      } else if (event.event === 'unsupported') this.emit('unsupported');
    });
    connection.on('closed', () => {
      const superseded = this.threadRuns.get(receipt.threadId) !== run;
      if (!superseded) this.threadRuns.delete(receipt.threadId);
      this.emit('runtimeClosed', { id: receipt.id, runtimeId: receipt.id, threadId: receipt.threadId, superseded });
    });
    try {
      const snapshot = await connection.call('hello', { cursor: run.cursor, replay: Boolean(existing) });
      if (snapshot.runId !== receipt.id || snapshot.workerPid !== receipt.worker.pid || snapshot.workerStartTicks !== receipt.worker.startTicks || snapshot.pid !== receipt.codex.pid || snapshot.threadId !== receipt.threadId) fail(409, 'runtime_identity', 'IPC 身份与运行记录不匹配。');
      run.snapshot = snapshot; run.cursor = snapshot.cursor; this.runs.set(receipt.id, run); this.threadRuns.set(receipt.threadId, run); return run;
    } catch (error) { connection.close(); throw error; }
  }
  async findThread(threadId) {
    let run = [...this.runs.values()].find(run => run.receipt.threadId === threadId);
    if (run && !run.connection.ended && await this.platform.verify(run.receipt)) return run;
    for (const receipt of await this.platform.receipts()) { if (receipt.threadId === threadId && await this.platform.verify(receipt)) return this.attach(receipt); }
    return null;
  }
  async create(method, params) {
    // Only startup metadata is persisted. Prompt/instruction/history payloads
    // are never copied into the launch or receipt files.
    if (Object.keys(params).some(key => !['threadId', 'cwd', 'projectId', 'excludeTurns', 'approvalPolicy', 'sandbox'].includes(key)) || (params.projectId !== undefined && params.projectId !== null && !idOK(params.projectId))) fail(400, 'invalid_parameters', '运行启动仅接受会话身份、项目、目录与审批设置。');
    const key = method === 'thread/resume' ? params.threadId : randomBytes(8).toString('hex');
    if (this.creating.has(key)) return this.creating.get(key);
    const pending = (async () => {
      if (method === 'thread/resume') { const existing = await this.findThread(params.threadId); if (existing) return existing.connection.call('rpc', { method, params }); }
      const id = randomBytes(8).toString('hex');
      // The launch file contains metadata only; prompts/history stay in Codex.
      const config = { transport: 'local', remoteCodex: this.config.remoteCodex, verifiedProtocol: this.config.verifiedProtocol };
      const initial = await this.platform.launch(id, { schemaVersion: 1, id, method, params, config });
      let receipt = initial;
      for (let n = 0; n < 200; n++) {
        receipt = await this.platform.readReceipt(id);
        if (receipt.failure) fail(503, receipt.failure, '独立运行初始化失败；不会自动重发。');
        if (receipt.ready && receipt.threadId && receipt.codex && await this.platform.verify(receipt)) break;
        if (!await this.platform.verify(receipt, { requireCodex: false })) fail(503, 'runtime_exited', '独立运行已结束；请核对历史。');
        await delay(50);
      }
      if (!receipt.ready || !receipt.threadId || !receipt.codex) fail(504, 'runtime_timeout', '独立运行初始化结果未知；请检查运行区，勿自动重发。');
      const run = await this.attach(receipt);
      return run.connection.call('rpc', { method: 'thread/read', params: { threadId: receipt.threadId, includeTurns: method === 'thread/resume' && !params.excludeTurns } });
    })();
    this.creating.set(key, pending);
    try { return await pending; } finally { this.creating.delete(key); }
  }
  async call(method, params = {}) {
    if (this.mock) return this.library.call(method, params);
    if (method === 'thread/resume' && !idOK(params.threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    if (['thread/start', 'thread/resume'].includes(method)) return this.create(method, params);
    if (params.threadId && ['turn/start', 'turn/interrupt', 'thread/read', 'thread/turns/list', 'thread/items/list'].includes(method)) {
      const run = await this.findThread(params.threadId);
      if (run) return run.connection.call('rpc', { method, params });
      if (method.startsWith('turn/')) fail(409, 'runtime_required', '请先将该会话加入独立运行区。');
    }
    if (!['initialize', 'account/read', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list', 'thread/archive', 'project/list', 'project/read', 'project/create', 'project/update', 'thread/name/set', 'thread/metadata/update', 'thread/section/move', 'threadSection/list'].includes(method)) fail(400, 'method_forbidden', '元数据连接不能执行会话写入。');
    return this.library.call(method, params);
  }
  answer(id, result) {
    if (this.mock) return this.library.answer(id, result);
    if (typeof id !== 'string' || !id.includes(':')) fail(409, 'approval_unavailable', '审批运行身份无效。');
    const [runId, encoded] = id.split(':'), run = this.runs.get(runId);
    if (!run || run.connection.ended || !encoded) fail(409, 'approval_unavailable', '审批所属运行已断开。');
    let original; try { original = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { fail(409, 'approval_unavailable', '审批身份无效。'); }
    return run.connection.call('answer', { requestId: original, result });
  }
  async listRuns() {
    if (this.mock) return [];
    const rows = [];
    for (const receipt of await this.platform.receipts()) {
      try {
        if (!receipt.ready || receipt.closed || !receipt.threadId) continue;
        const actual = await this.platform.verify(receipt); if (!actual) continue;
        const run = await this.attach(actual), snapshot = await run.connection.call('hello', { cursor: run.cursor, replay: false }); run.snapshot = snapshot;
        const tmux = { sessionId: actual.tmux.sessionId, sessionName: actual.tmux.sessionName, windowIndex: actual.tmux.windowIndex, paneIndex: actual.tmux.paneIndex, paneId: actual.tmux.paneId, target: `${actual.tmux.sessionId}:${actual.tmux.windowIndex}.${actual.tmux.paneIndex}` };
        let preference;
        try { preference = await this.getKeepRunning(actual.threadId); } catch { preference = { keepRunning: true, unknown: true }; }
        const lifecycle = snapshot.lifecycle?.version === 2 && Number.isFinite(snapshot.lifecycle.lastOutputAt) ? clone(snapshot.lifecycle) : { version: null, idleSince: null, terminalSavedAt: null, lastOutputAt: null, reason: 'worker_upgrade_required' };
        if (preference.unknown) { lifecycle.reason = 'runtime_preference_unknown'; lifecycle.idleSince = null; }
        let webConnected = true;
        try { webConnected = (await this.getWebPresence(actual.threadId)).connected; } catch { lifecycle.reason = 'runtime_presence_unknown'; }
        rows.push({ id: actual.id, threadId: actual.threadId, cwd: snapshot.cwd, status: snapshot.status, pid: actual.codex.pid, managed: true, tmuxState: 'attached', tmux, revision: hash({ worker: actual.worker, codex: actual.codex, tmux: actual.tmux, revision: snapshot.revision }), activeTurnId: snapshot.activeTurnId, keepRunning: preference.keepRunning, webConnected, lifecycle, pendingApprovals: (snapshot.approvals || []).map(message => ({ ...message, id: approvalId(actual.id, message.id) })) });
      } catch { /* A receipt alone is never a live run. */ }
    }
    return rows;
  }
  async getRun(id) { return (await this.listRuns()).find(run => run.id === id) || null; }
  async getKeepRunning(threadId) {
    if (!idOK(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    return this.mock ? { threadId, keepRunning: this.preferences.get(threadId) || false } : this.platform.getKeepRunning(threadId);
  }
  async setKeepRunning(threadId, keepRunning) {
    if (!idOK(threadId) || typeof keepRunning !== 'boolean') fail(400, 'invalid_preference', '会话持续运行设置无效。');
    if (!this.mock) return this.platform.setKeepRunning(threadId, keepRunning);
    this.preferences.set(threadId, keepRunning); return { threadId, keepRunning };
  }
  async getWebPresence(threadId) {
    if (!idOK(threadId)) fail(400, 'invalid_thread', '会话 id 无效。');
    if (!this.mock) return this.platform.getWebPresence(threadId);
    return { threadId, connected: [...this.presence.values()].some(lease => lease.threadId === threadId && lease.expiresAt > this.clock()), leaseMs: WEB_PRESENCE_LEASE_MS };
  }
  async setWebPresence(clientId, threadId) {
    if (!presenceClientOK(clientId) || (threadId !== null && !idOK(threadId))) fail(400, 'invalid_presence', '网页连接标识或会话无效。');
    if (!this.mock) return this.platform.setWebPresence(clientId, threadId);
    for (const [id, lease] of this.presence) if (lease.expiresAt <= this.clock()) this.presence.delete(id);
    if (threadId === null) this.presence.delete(clientId);
    else { if (!this.presence.has(clientId) && this.presence.size >= 1000) fail(429, 'runtime_presence_limit', '网页连接记录已满，请稍后重试。'); this.presence.set(clientId, { threadId, expiresAt: this.clock() + WEB_PRESENCE_LEASE_MS }); }
    return { threadId, connected: threadId !== null, leaseMs: WEB_PRESENCE_LEASE_MS };
  }
  releaseWebPresence(clientId) { return this.setWebPresence(clientId, null); }
  async reapRun(id, expectedRevision, { idleMs = 120 * 60 * 1000 } = {}) {
    if (this.mock) return { stopped: false, reason: 'mock' };
    const row = await this.getRun(id);
    if (!row || row.revision !== expectedRevision || row.lifecycle?.version !== 2) fail(409, 'runtime_changed', '运行状态未知或已改变，不会回收。');
    const receipt = await this.platform.readReceipt(id), run = this.runs.get(id);
    const owner = { runId: id, worker: { pid: receipt.worker.pid, startTicks: receipt.worker.startTicks } };
    let prepared = false;
    try {
      await this.platform.cleanupAdmitted(row.threadId, owner, async () => {
        await this.platform.cleanupIdentity(receipt);
        const preparedState = await run.connection.call('prepareIdleStop', { revision: run.snapshot.revision, idleMs }); prepared = true;
        // This second inspection happens after the worker seals admission.
        // Unknown or changed tmux/process state prevents the stop.
        await this.platform.cleanupIdentity(receipt);
        await run.connection.call('confirmIdleStop', { revision: preparedState.revision, idleMs });
        await this.platform.stop(receipt, { idle: true });
      });
    } catch (error) {
      if (prepared) await run.connection.call('cancelIdleStop').catch(() => {});
      throw error;
    }
    run.connection.close(); this.runs.delete(id);
    return { stopped: true, id, threadId: row.threadId, archived: false, reason: 'idle_timeout' };
  }
  async cleanupStaleRuns() {
    if (this.mock) return [];
    const results = [];
    for (const receipt of await this.platform.receipts()) {
      if (![1, 2].includes(receipt.lifecycle?.version) || receipt.closed) continue;
      try { if (await this.platform.reconcileAbsent(receipt)) { this.runs.get(receipt.id)?.connection.close(); this.runs.delete(receipt.id); results.push({ id: receipt.id, threadId: receipt.threadId, stopped: true, reason: 'already_absent', archived: false }); } }
      catch { /* A crashed or changed runtime remains unknown, never a kill target. */ }
    }
    return results;
  }
  async stopRun(id, expectedRevision) {
    const row = await this.getRun(id);
    const revision = typeof expectedRevision === 'object' ? expectedRevision?.revision : expectedRevision;
    if (!row || !revision || row.revision !== revision) fail(409, 'runtime_changed', '运行状态已改变，请重新预览。');
    const receipt = await this.platform.readReceipt(id);
    const run = this.runs.get(id);
    await run.connection.call('prepareStop', { revision: run.snapshot.revision });
    await this.platform.stop(receipt); this.runs.get(id)?.connection.close(); this.runs.delete(id);
    return { stopped: true, id, threadId: row.threadId, archived: false };
  }
  async replayThread(threadId) {
    const run = await this.findThread(threadId); if (!run) return;
    const snapshot = await run.connection.call('hello', { cursor: run.cursor, replay: false });
    if (snapshot.activeTurnId) this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: snapshot.activeTurnId, status: 'inProgress', items: [] } } });
    for (const message of snapshot.approvals || []) this.emit('approval', { ...message, id: approvalId(run.receipt.id, message.id) });
  }
  freezeThreads(ids, operationId) { return this.mock ? Promise.resolve({ operationId, threadIds: ids, release: async () => {} }) : this.platform.freezeThreads(ids, operationId); }
  releaseThreads(ids, operationId) { return this.mock ? Promise.resolve() : this.platform.releaseThreads(ids, operationId); }
  close() { for (const run of this.runs.values()) run.connection.close(); this.library.close(); this.connected = false; }
}

export { errorOf as runtimeError, safeEnvironment as runtimeEnvironment };
