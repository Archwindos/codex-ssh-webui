import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { RuntimeRpc, WorkerConnection, createRuntimePlatform, parseRuntimePane, approvalId, runtimeEnvironment } from '../src/runtimes.mjs';
import { startRuntimeWorker } from '../src/runtime-worker.mjs';

const flush = () => new Promise(done => setImmediate(done));
const copy = value => JSON.parse(JSON.stringify(value));
const config = { transport: 'local', remoteCodex: '/home/demo/.local/bin/codex', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
const errno = code => Object.assign(Error(code), { code });

class MemoryLinux {
  constructor(root) {
    this.entries = new Map(); this.processes = new Map(); this.nextInode = 100;
    for (const path of [root, join(root, 'runtime'), '/tmp/tmux-1000']) this.directory(path);
    this.socket('/tmp/tmux-1000/default', 0o660);
  }
  key(path) { return String(path).replaceAll('\\', '/'); }
  directory(path) { this.entries.set(this.key(path), { kind: 'directory', mode: 0o700, uid: 1000, ino: this.nextInode++ }); }
  socket(path, mode = 0o600) { this.entries.set(this.key(path), { kind: 'socket', mode, uid: 1000 }); }
  info(entry) { return { ...entry, dev: entry.dev || 1, ino: entry.ino || 2, size: Buffer.byteLength(entry.data || ''), isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSocket: () => entry.kind === 'socket', isSymbolicLink: () => entry.kind === 'symlink' }; }
  async lstat(path) { const item = this.entries.get(this.key(path)); if (!item) throw errno('ENOENT'); return this.info(item); }
  async stat(path) { if (/^\/proc\/\d+$/.test(path)) { if (!this.processes.has(Number(path.split('/')[2]))) throw errno('ENOENT'); return { uid: 1000 }; } return this.lstat(path); }
  async realpath(path) { if (!this.entries.has(this.key(path))) throw errno('ENOENT'); return path; }
  async mkdir(path, options = {}) { if (this.entries.has(this.key(path))) throw errno('EEXIST'); this.directory(path); this.entries.get(this.key(path)).mode = options.mode || 0o700; }
  async writeFile(path, data, options = {}) { const key = this.key(path); if (options.flag === 'wx' && this.entries.has(key)) throw errno('EEXIST'); this.entries.set(key, { kind: 'file', uid: 1000, mode: options.mode || 0o600, ino: this.nextInode++, data: String(data) }); }
  async readFile(path, encoding) {
    const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(path);
    if (match) {
      const entry = this.processes.get(Number(match[1])); if (!entry) throw errno('ENOENT');
      if (match[2] === 'cmdline') return Buffer.from(entry.commandline.join('\0') + '\0');
      const fields = ['S', String(entry.ppid), String(entry.pid), String(entry.pid), ...Array(15).fill('0'), entry.startTicks, '0'];
      return `${entry.pid} (fixture process) ${fields.join(' ')}`;
    }
    const item = this.entries.get(this.key(path)); if (!item) throw errno('ENOENT');
    return encoding ? item.data : Buffer.from(item.data);
  }
  async readlink(path) { const match = /^\/proc\/(\d+)\/exe$/.exec(path); const item = match && this.processes.get(Number(match[1])); if (!item) throw errno('ENOENT'); return item.executable; }
  async rename(from, to) { const source = this.key(from), target = this.key(to), entry = this.entries.get(source); if (!entry) throw errno('ENOENT'); for (const [key, value] of [...this.entries]) if (key === source || key.startsWith(source + '/')) { this.entries.set(target + key.slice(source.length), value); this.entries.delete(key); } }
  async link(from, to) { const entry = this.entries.get(this.key(from)); if (!entry) throw errno('ENOENT'); if (this.entries.has(this.key(to))) throw errno('EEXIST'); this.entries.set(this.key(to), entry); }
  async unlink(path) { if (!this.entries.delete(this.key(path))) throw errno('ENOENT'); }
  async rmdir(path) { if ((await this.readdir(path)).length) throw errno('ENOTEMPTY'); return this.unlink(path); }
  async chmod(path, mode) { const item = this.entries.get(this.key(path)); if (!item) throw errno('ENOENT'); item.mode = mode; }
  async readdir(path) { const prefix = this.key(path) + '/'; return [...new Set([...this.entries.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('/')[0]))]; }
}

class SocketEnd extends EventEmitter {
  setEncoding() {}
  write(data) { if (this.destroyed) return false; queueMicrotask(() => { if (!this.peer.destroyed) this.peer.emit('data', data); }); return true; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); if (!this.peer.destroyed) { this.peer.destroyed = true; this.peer.emit('close'); } }
}

class FakeRpc extends EventEmitter {
  constructor(linux, threads, { workerPid = 1, cwd = '/project', library = false } = {}) { super(); this.linux = linux; this.threads = threads; this.workerPid = workerPid; this.cwd = cwd; this.library = library; this.calls = []; this.connected = false; this.child = { pid: workerPid + 10000 }; }
  async start() { this.connected = true; this.linux.processes.set(this.child.pid, { pid: this.child.pid, ppid: this.workerPid, startTicks: `${this.child.pid}0`, executable: '/official/codex', commandline: ['/official/codex', 'app-server'] }); }
  async call(method, params) {
    this.calls.push({ method, params: copy(params) });
    if (this.library && ['thread/start', 'thread/resume', 'turn/start'].includes(method)) throw Error('library must not own a writer');
    if (method === 'thread/start') { const thread = { id: `thread-${this.workerPid}`, cwd: params.cwd, status: { type: 'idle' }, turns: [] }; this.threads.set(thread.id, thread); return { thread: copy(thread) }; }
    if (method === 'thread/resume' || method === 'thread/read') { const thread = this.threads.get(params.threadId); if (!thread) throw Error('missing thread'); return { thread: copy(thread) }; }
    if (method === 'thread/list') return { data: [...this.threads.values()].map(copy), nextCursor: null };
    if (method === 'thread/turns/list') return { data: copy(this.threads.get(params.threadId).turns), nextCursor: null };
    if (method === 'turn/start') { const turn = { id: `turn-${this.calls.length}`, status: 'inProgress', items: [] }; this.threads.get(params.threadId).turns.push(turn); return { turn }; }
    if (method === 'turn/interrupt') return {};
    throw Error(`Unexpected method ${method}`);
  }
  answer(id, result) { this.answers ||= []; this.answers.push({ id, result }); }
  close() { if (this.ended) return; this.ended = true; this.linux.processes.delete(this.child.pid); this.emit('closed'); }
}

async function fixture(t, scenario = {}) {
  // This filesystem is entirely in memory. A short absolute Linux fixture
  // keeps the Unix socket limit independent of the deployment staging path.
  const root = resolve('/fixture-runtime-root'), linux = new MemoryLinux(root), threads = new Map(), servers = new Map(), workers = new Map(), commands = [];
  let counter = 200, newCalls = 0;
  const sessions = new Map([['$1', { sessionName: 'manual-a', paneId: '%0', panePid: 50 }], ['$3', { sessionName: 'manual-b', paneId: '%8', panePid: 60 }]]);
  linux.processes.set(40, { pid: 40, ppid: 1, startTicks: '400', executable: '/usr/bin/tmux', commandline: ['tmux: server'] });
  linux.processes.set(1111, { pid: 1111, ppid: 1, startTicks: '11110', executable: process.execPath, commandline: [process.execPath] });
  const line = pane => [40, pane.sessionId, pane.sessionName, pane.windowId, pane.windowIndex, pane.paneId, pane.paneIndex, pane.panePid].join('|') + '\n';
  const exec = async (command, raw, options) => {
    assert.equal(command, '/usr/bin/tmux'); assert.deepEqual(raw.slice(0, 2), ['-S', '/tmp/tmux-1000/default']);
    assert.equal(options.env.RELAY_ACCESS_SECRET, undefined); const args = raw.slice(2); commands.push(args);
    if (args[0] === 'display-message') { if (!linux.processes.has(40)) throw Object.assign(Error('closed'), { code: 1, stdout: '', stderr: 'closed' }); return { stdout: '40\n', stderr: '' }; }
    if (args[0] === 'list-sessions') return { stdout: [...sessions.values()].map(pane => pane.sessionName).join('\n'), stderr: '' };
    if (args[0] === 'new-session') {
      if (scenario.falseSuccessTmuxNewSession) { newCalls++; return { stdout: '', stderr: 'error creating default socket (No such file or directory)' }; }
      if (!linux.processes.has(40)) { linux.processes.set(40, { pid: 40, ppid: 1, startTicks: '401', executable: '/usr/bin/tmux', commandline: ['tmux: server'] }); linux.entries.get('/tmp/tmux-1000/default').ino++; }
      newCalls++; const sessionName = args[args.indexOf('-s') + 1], id = sessionName.slice('codex-chat-'.length), directory = join(root, 'runtime', 'runs', id);
      if ([...sessions.values()].some(pane => pane.sessionName === sessionName)) throw Object.assign(Error('duplicate'), { code: 1, stdout: '', stderr: 'duplicate' });
      const pid = counter++, pane = { sessionId: `$${pid}`, sessionName, windowId: `@${pid + 10}`, windowIndex: 2, paneId: `%${pid + 20}`, paneIndex: 3, panePid: pid };
      sessions.set(pane.sessionId, pane);
      linux.processes.set(pid, { pid, ppid: 40, startTicks: `${pid}0`, executable: process.execPath, commandline: [process.execPath, join(root, 'src', 'runtime-worker.mjs'), '--run-dir', directory] });
      assert.match(args.at(-1), /env' '-i'/); assert.doesNotMatch(args.at(-1), /TEST_SECRET|RELAY_ACCESS_SECRET|OPENAI_API_KEY/);
      assert.match(args.at(-1), /"TMUX=\$TMUX" "TMUX_PANE=\$TMUX_PANE"/);
      assert.deepEqual(args.at(-1).match(/"[A-Z_]+=\$[A-Z_]+"/g), ['"TMUX=$TMUX"', '"TMUX_PANE=$TMUX_PANE"']);
      return { stdout: line(pane), stderr: '' };
    }
    if (args[0] === 'list-panes') { const pane = sessions.get(args[args.indexOf('-t') + 1]); if (!pane) throw Object.assign(Error('gone'), { code: 1, stdout: '', stderr: 'gone' }); return { stdout: line(pane), stderr: '' }; }
    if (args[0] === 'kill-pane') {
      const found = [...sessions].find(([, pane]) => pane.paneId === args.at(-1)); if (!found) throw Error('unknown pane');
      const [sessionId, pane] = found; const worker = [...workers.values()].find(value => value.pid === pane.panePid); worker?.instance.close(); linux.processes.delete(pane.panePid); sessions.delete(sessionId); return { stdout: '', stderr: '' };
    }
    throw Error(`Forbidden tmux command ${args[0]}`);
  };
  let recovering = Promise.resolve();
  const recoveryMutex = operation => { const result = recovering.then(operation); recovering = result.catch(() => {}); return result; };
  const platform = createRuntimePlatform({ root, filesystem: linux, uid: () => 1000, pid: () => 1111, recoveryMutex, exec, env: { HOME: '/home/demo', PATH: '/usr/bin', RELAY_ACCESS_SECRET: 'TEST_SECRET', OPENAI_API_KEY: 'TEST_SECRET' } });
  const originalReadReceipt = platform.readReceipt.bind(platform);
  const createIPCServer = handler => {
    const server = new EventEmitter(); server.handler = handler;
    server.listen = (path, done) => { server.path = path; servers.set(linux.key(path), server); linux.socket(path); done(); };
    server.close = () => servers.delete(linux.key(server.path)); return server;
  };
  const startWorker = async receipt => {
    const id = receipt.id;
    if (workers.has(id)) return;
    const entry = { pid: receipt.worker.pid }; workers.set(id, entry);
    entry.instance = await startRuntimeWorker({ runDir: platform.runDir(id), platform: { ...platform, readReceipt: originalReadReceipt }, workerPid: receipt.worker.pid,
      env: { TMUX_PANE: receipt.tmux.paneId, TMUX: `${receipt.tmux.socket},${receipt.tmux.serverPid},${receipt.tmux.sessionId.slice(1)}` },
      rpcFactory: () => (entry.rpc = new FakeRpc(linux, threads, { workerPid: receipt.worker.pid })), createIPCServer,
      onExit: () => { linux.processes.delete(receipt.worker.pid); sessions.delete(receipt.tmux.sessionId); } });
  };
  // Workers use the unwrapped reader; gateway launch waits for the ready IPC.
  platform.readReceipt = async id => {
    const receipt = await originalReadReceipt(id);
    if (!receipt.threadId && !workers.has(id)) {
      await startWorker(receipt);
    }
    return originalReadReceipt(id);
  };
  platform.connect = async receipt => {
    const server = servers.get(linux.key(join(platform.runDir(receipt.id), 'control.sock'))); if (!server) throw errno('ECONNREFUSED');
    const gateway = new SocketEnd(), child = new SocketEnd(); gateway.peer = child; child.peer = gateway; server.handler(child); return new WorkerConnection(gateway);
  };
  let libraryCounter = 1000;
  const managers = [];
  const manager = () => {
    const rpc = new RuntimeRpc(config, { platform, rpcFactory: () => new FakeRpc(linux, threads, { workerPid: libraryCounter++, library: true }) }); managers.push(rpc); return rpc;
  };
  t.after(async () => { for (const rpc of managers) rpc.close(); for (const worker of workers.values()) worker.instance?.close(); await flush(); });
  return { root, linux, threads, sessions, platform, workers, manager, commands, newCalls: () => newCalls };
}

async function seedGuard(f, { pid = 700, startTicks = '7000', owner = 'a'.repeat(32) } = {}) {
  await f.platform.initialize();
  const guard = join(f.root, 'runtime', 'admission.guard');
  await f.linux.mkdir(guard, { mode: 0o700 });
  const record = { schemaVersion: 1, owner, pid, startTicks, executable: process.execPath };
  await f.platform.writeJSON(join(guard, 'owner.json'), record, true);
  return { guard, record };
}

test('ASCII tmux identity parser preserves allocated IDs and rejects forged rows', () => {
  const row = parseRuntimePane('40|$12|codex-chat-aaaaaaaaaaaaaaaa|@16|2|%27|3|200\n');
  assert.equal(row.paneId, '%27'); assert.equal(row.sessionId, '$12');
  for (const output of ['40\t$12\tbad', '40|$12|manual|@16|2|%27|3|200', '40|$12|codex-chat-aaaaaaaaaaaaaaaa|@16|2|%27|3|200|extra']) assert.throws(() => parseRuntimePane(output));
});

test('initialize creates only the missing standard UID tmux directory with mode 0700', async t => {
  const f = await fixture(t);
  await f.linux.unlink('/tmp/tmux-1000/default'); await f.linux.rmdir('/tmp/tmux-1000');
  const created = [], mkdir = f.linux.mkdir.bind(f.linux);
  f.linux.mkdir = async (path, options) => { created.push({ path, mode: options.mode }); return mkdir(path, options); };
  await f.platform.initialize();
  const info = await f.linux.lstat('/tmp/tmux-1000'); assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, 1000);
  assert.deepEqual(created.filter(row => row.path.startsWith('/tmp')), [{ path: '/tmp/tmux-1000', mode: 0o700 }]);
});

test('initialize refuses unsafe existing default directories without changing their permissions', async t => {
  for (const changes of [{ mode: 0o755 }, { uid: 0 }, { kind: 'symlink' }]) {
    const f = await fixture(t), directory = f.linux.entries.get('/tmp/tmux-1000'); Object.assign(directory, changes);
    const before = copy(directory); let chmods = 0;
    f.linux.chmod = async () => { chmods++; assert.fail('existing directory must not be chmodded'); };
    await assert.rejects(f.platform.initialize(), { code: 'runtime_permissions' });
    assert.deepEqual(directory, before); assert.equal(chmods, 0);
  }
});

test('tmux exit zero with stderr is a start failure before pane parsing or identity wait', async t => {
  const f = await fixture(t, { falseSuccessTmuxNewSession: true }), rpc = f.manager(); await rpc.start();
  const before = new Set(f.linux.processes.keys());
  await assert.rejects(rpc.call('thread/start', { cwd: '/a' }), { code: 'runtime_start_failed' });
  assert.equal(f.newCalls(), 1); assert.deepEqual(new Set(f.linux.processes.keys()), before);
  assert.equal((await f.platform.receipts()).length, 0);
  const afterCreation = f.commands.slice(f.commands.findIndex(args => args[0] === 'new-session') + 1);
  assert.deepEqual(afterCreation, []); assert.equal(f.commands.some(args => args[0] === 'kill-pane'), false);
});

test('every phone chat gets one independent default-tmux worker; library remains metadata only', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start();
  const first = await rpc.call('thread/start', { cwd: '/project-a' }), second = await rpc.call('thread/start', { cwd: '/project-b' });
  assert.notEqual(first.thread.id, second.thread.id); assert.equal(f.newCalls(), 2);
  const runs = await rpc.listRuns(); assert.equal(runs.length, 2); assert.equal(new Set(runs.map(run => run.tmux.sessionId)).size, 2);
  assert.ok(runs.every(run => run.tmuxState === 'attached' && run.status === 'idle' && run.managed));
  assert.ok(f.sessions.has('$1')); assert.ok(f.sessions.has('$3'));
  assert.ok(runs.every(run => rpc.ownsPid(run.pid))); assert.ok(rpc.ownsPid(rpc.child.pid));
  assert.equal(rpc.library.calls.length, 0);
  for (const worker of f.workers.values()) assert.equal(worker.rpc.calls[0].params.config.model_reasoning_effort, 'high');
});

test('old thread joins with its original ID; gateway close and restart reconnect without recreating runner', async t => {
  const f = await fixture(t); f.threads.set('old-thread', { id: 'old-thread', cwd: '/old', status: { type: 'idle' }, turns: [] });
  const first = f.manager(); await first.start(); const result = await first.call('thread/resume', { threadId: 'old-thread', cwd: '/old', excludeTurns: true });
  assert.equal(result.thread.id, 'old-thread'); first.close(); await flush();
  assert.equal(f.workers.values().next().value.rpc.ended, undefined);
  const restarted = f.manager(); await restarted.start(); assert.equal((await restarted.listRuns()).length, 1);
  const again = await restarted.call('thread/resume', { threadId: 'old-thread', excludeTurns: true });
  assert.equal(again.thread.id, 'old-thread'); assert.equal(f.newCalls(), 1);
  await restarted.call('turn/start', { threadId: 'old-thread', input: [{ type: 'text', text: 'one message' }], effort: 'low' });
  assert.equal(f.workers.values().next().value.rpc.calls.at(-1).params.effort, 'high');
});

test('approval IDs are runner-specific; wrong-thread RPC never reaches official client', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start();
  const a = await rpc.call('thread/start', { cwd: '/a' }), b = await rpc.call('thread/start', { cwd: '/b' });
  const messages = []; rpc.on('approval', message => messages.push(message));
  const workers = [...f.workers.values()];
  for (const [index, thread] of [a.thread, b.thread].entries()) workers[index].rpc.emit('approval', { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: `turn-${index}`, itemId: 'item-1' } });
  await flush(); assert.equal(messages.length, 2); assert.notEqual(messages[0].id, messages[1].id);
  await rpc.answer(messages[0].id, { decision: 'decline' }); assert.deepEqual(workers[0].rpc.answers, [{ id: 7, result: { decision: 'decline' } }]); assert.equal(workers[1].rpc.answers, undefined);
  const result = await workers[0].instance.request({ op: 'rpc', method: 'turn/start', params: { threadId: b.thread.id } }).catch(error => error);
  assert.equal(result.code, 'runtime_thread_mismatch');
});

test('worker events remain replayable after gateway disconnect; pending approval survives', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); const { thread } = await rpc.call('thread/start', { cwd: '/a' });
  rpc.close(); const worker = [...f.workers.values()][0];
  worker.rpc.emit('notification', { method: 'turn/started', params: { threadId: thread.id, turn: { id: 'turn-persist' } } });
  worker.rpc.emit('approval', { id: 'request-a', method: 'item/fileChange/requestApproval', params: { threadId: thread.id, turnId: 'turn-persist', itemId: 'item-a' } });
  const replay = await worker.instance.request({ op: 'hello', cursor: 0, replay: true }); assert.equal(replay.replay.length, 2);
  const fresh = f.manager(); await fresh.start(); const approvals = []; const notifications = []; fresh.on('approval', message => approvals.push(message)); fresh.on('notification', message => notifications.push(message));
  assert.equal(approvals.length, 0); await fresh.replayThread(thread.id);
  assert.equal(approvals[0].id, approvalId([...f.workers.keys()][0], 'request-a')); assert.equal(notifications[0].params.turn.id, 'turn-persist');
  assert.equal((await fresh.listRuns())[0].status, 'waitingApproval');
});

test('stop requires current revision, affects only owned pane and preserves official history', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); const { thread } = await rpc.call('thread/start', { cwd: '/a' });
  const row = (await rpc.listRuns())[0];
  await assert.rejects(rpc.stopRun(row.id, 'old-revision'), { code: 'runtime_changed' });
  assert.equal(f.commands.filter(args => args[0] === 'kill-pane').length, 0);
  const stopped = await rpc.stopRun(row.id, row.revision); assert.equal(stopped.archived, false);
  assert.ok(f.threads.has(thread.id)); assert.ok(f.sessions.has('$1')); assert.ok(f.sessions.has('$3'));
  assert.equal((await rpc.listRuns()).length, 0); assert.deepEqual(f.commands.filter(args => args[0] === 'kill-pane').map(args => args.at(-1)), [row.tmux.paneId]);
  assert.equal(f.commands.some(args => ['kill-server', 'kill-session', 'set-environment'].includes(args[0])), false);
});

test('already stopped receipts ignore a replacement default server and safely reused PIDs', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); await rpc.call('thread/start', { cwd: '/a' });
  const row = (await rpc.listRuns())[0], receipt = await f.platform.readReceipt(row.id);
  await rpc.stopRun(row.id, row.revision); await flush();
  f.linux.processes.get(40).startTicks = 'replacement-server'; f.linux.entries.get('/tmp/tmux-1000/default').ino = 999;
  for (const old of [receipt.worker, receipt.codex]) f.linux.processes.set(old.pid, { pid: old.pid, ppid: 1, startTicks: old.startTicks + '1', executable: '/unrelated/process', commandline: ['/unrelated/process'] });
  const commandsBefore = f.commands.length, processesBefore = copy([...f.linux.processes]);
  assert.deepEqual(await f.platform.stop(receipt), { alreadyAbsent: true });
  assert.equal(f.commands.length, commandsBefore); assert.deepEqual([...f.linux.processes], processesBefore);
});

test('an original process still alive cannot bypass changed tmux identity during stop', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); await rpc.call('thread/start', { cwd: '/a' });
  const row = (await rpc.listRuns())[0], receipt = await f.platform.readReceipt(row.id);
  f.linux.entries.get('/tmp/tmux-1000/default').ino = 999;
  await assert.rejects(f.platform.stop(receipt), { code: 'runtime_socket_changed' });
  assert.equal(f.commands.some(args => args[0] === 'kill-pane'), false); assert.ok(f.linux.processes.has(receipt.worker.pid)); assert.ok(f.linux.processes.has(receipt.codex.pid));
});

test('process/socket identity changes remove receipts from live rows and forbid stop', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); await rpc.call('thread/start', { cwd: '/a' }); const row = (await rpc.listRuns())[0];
  f.linux.processes.get(row.pid).startTicks = 'reused';
  assert.deepEqual(await rpc.listRuns(), []); await assert.rejects(rpc.stopRun(row.id, row.revision), { code: 'runtime_changed' });
  assert.equal(f.commands.some(args => args[0] === 'kill-pane'), false);
});

test('socket inode changes and unknown same-name sessions never grant control', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); await rpc.call('thread/start', { cwd: '/a' });
  const row = (await rpc.listRuns())[0]; f.linux.entries.get('/tmp/tmux-1000/default').ino = 999;
  assert.deepEqual(await rpc.listRuns(), []); await assert.rejects(rpc.stopRun(row.id, row.revision), { code: 'runtime_changed' });
  f.linux.entries.get('/tmp/tmux-1000/default').ino = 2;
  f.sessions.set('$99', { sessionName: 'codex-chat-aaaaaaaaaaaaaaaa', paneId: '%99', panePid: 999 });
  await assert.rejects(f.platform.launch('aaaaaaaaaaaaaaaa', { method: 'thread/start', params: { cwd: '/a' }, config }), { code: 'runtime_session_exists' });
  assert.equal(f.commands.some(args => args[0] === 'kill-pane'), false); assert.ok(f.sessions.has('$99'));
});

test('closing a runner does not emit the global closed event or archive its durable chat', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start();
  const first = await rpc.call('thread/start', { cwd: '/a' }); await rpc.call('thread/start', { cwd: '/b' });
  let globalClosed = 0; rpc.on('closed', () => globalClosed++); [...f.workers.values()][0].instance.close(); await flush();
  assert.equal(globalClosed, 0); assert.equal(rpc.connected, true); assert.equal((await rpc.listRuns()).length, 1);
  const list = await rpc.call('thread/list', {}); assert.ok(list.data.some(thread => thread.id === first.thread.id));
  const reopened = await rpc.call('thread/resume', { threadId: first.thread.id, cwd: '/a' }); assert.equal(reopened.thread.id, first.thread.id); assert.equal(f.newCalls(), 3);
});

test('RPC timeout is propagated once without replaying the submitted turn', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); const { thread } = await rpc.call('thread/start', { cwd: '/a' });
  const worker = [...f.workers.values()][0], original = worker.rpc.call.bind(worker.rpc); let submitted = 0;
  worker.rpc.call = (method, params) => { if (method === 'turn/start') { submitted++; throw Object.assign(Error('unknown result'), { status: 504, code: 'rpc_timeout' }); } return original(method, params); };
  await assert.rejects(rpc.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'single submission' }] }), { code: 'rpc_timeout' });
  await flush(); assert.equal(submitted, 1);
  assert.equal((await rpc.listRuns())[0].status, 'unknown');
});

test('launch and receipts never duplicate submitted prompts or instruction payloads', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start();
  await assert.rejects(rpc.call('thread/start', { cwd: '/a', baseInstructions: 'private-instructions-must-not-be-copied' }), { code: 'invalid_parameters' });
  assert.equal(f.newCalls(), 0);
  const { thread } = await rpc.call('thread/start', { cwd: '/a' });
  await rpc.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'private-prompt-must-not-be-copied' }] });
  for (const entry of f.linux.entries.values()) if (entry.kind === 'file') assert.doesNotMatch(entry.data, /private-prompt-must-not-be-copied|private-instructions-must-not-be-copied/);
});

test('two gateways racing to join one old thread load it into only one official app-server', async t => {
  const f = await fixture(t); f.threads.set('race-old', { id: 'race-old', cwd: '/a', status: { type: 'idle' }, turns: [] });
  const a = f.manager(), b = f.manager(); await Promise.all([a.start(), b.start()]);
  const results = await Promise.allSettled([a.call('thread/resume', { threadId: 'race-old', cwd: '/a' }), b.call('thread/resume', { threadId: 'race-old', cwd: '/a' })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal([...f.workers.values()].flatMap(worker => worker.rpc.calls).filter(call => call.method === 'thread/resume').length, 1);
});

test('persistent writer admission rejects another live runner and permits only a proven dead owner', async t => {
  const f = await fixture(t); await f.platform.initialize();
  const owner = { runId: 'aaaaaaaaaaaaaaaa', worker: { pid: 700, startTicks: '7000' }, codex: { pid: 701, startTicks: '7010' } }, other = { runId: 'bbbbbbbbbbbbbbbb', worker: { pid: 800, startTicks: '8000' }, codex: null };
  f.linux.processes.set(700, { pid: 700, ppid: 40, startTicks: '7000', executable: process.execPath, commandline: ['node'] });
  f.linux.processes.set(701, { pid: 701, ppid: 700, startTicks: '7010', executable: '/official/codex', commandline: ['/official/codex', 'app-server'] });
  await f.platform.claimThread('same-thread', owner);
  await assert.rejects(f.platform.claimThread('same-thread', other), { code: 'thread_writer_busy' });
  f.linux.processes.delete(700); await assert.rejects(f.platform.claimThread('same-thread', other), { code: 'thread_writer_busy' });
  f.linux.processes.delete(701); await f.platform.claimThread('same-thread', other);
  await assert.rejects(f.platform.admitted('same-thread', owner, () => assert.fail('must not dispatch')), { code: 'thread_writer_changed' });
  assert.equal(await f.platform.admitted('same-thread', other, () => 42), 42);
});

test('freeze markers survive manager restart, block joins/turns, and only owning operation releases', async t => {
  const f = await fixture(t), rpc = f.manager(); await rpc.start(); const { thread } = await rpc.call('thread/start', { cwd: '/a' });
  const freeze = await rpc.freezeThreads([thread.id], 'archive-op-a'); rpc.close();
  const fresh = f.manager(); await fresh.start();
  await assert.rejects(fresh.call('thread/resume', { threadId: thread.id }), { code: 'thread_frozen' });
  await assert.rejects(fresh.call('turn/start', { threadId: thread.id, input: [] }), { code: 'thread_frozen' });
  await assert.rejects(fresh.releaseThreads([thread.id], 'archive-op-b'), { code: 'thread_frozen' });
  await freeze.release(); await fresh.call('turn/start', { threadId: thread.id, input: [] });
  assert.equal([...f.workers.values()][0].rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('concurrent persistent claims have only one winner; abandoned admission guards never disappear by age', async t => {
  const f = await fixture(t); await f.platform.initialize();
  const a = { runId: 'aaaaaaaaaaaaaaaa', worker: { pid: 700, startTicks: '7000' }, codex: null }, b = { runId: 'bbbbbbbbbbbbbbbb', worker: { pid: 800, startTicks: '8000' }, codex: null };
  for (const owner of [a, b]) f.linux.processes.set(owner.worker.pid, { ...owner.worker, ppid: 40, executable: process.execPath, commandline: ['node'] });
  const results = await Promise.allSettled([f.platform.claimThread('race-thread', a), f.platform.claimThread('race-thread', b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await f.linux.mkdir(join(f.root, 'runtime', 'admission.guard'));
  await assert.rejects(f.platform.freezeThreads(['race-thread'], 'archive-recovery'), { code: 'runtime_admission_busy' });
  assert.equal((await f.linux.lstat(join(f.root, 'runtime', 'admission.guard'))).isDirectory(), true);
});

test('admission recovery never steals a live owner, then recovers its proven death', async t => {
  const f = await fixture(t), { guard, record } = await seedGuard(f);
  f.linux.processes.set(700, { pid: 700, ppid: 40, startTicks: '7000', executable: process.execPath, commandline: [process.execPath] });
  const originalInode = (await f.linux.lstat(guard)).ino;
  await assert.rejects(f.platform.admission(() => assert.fail('live lock must not be stolen')), { code: 'runtime_admission_busy' });
  assert.deepEqual(await f.platform.readJSON(join(guard, 'owner.json')), record); assert.equal((await f.linux.lstat(guard)).ino, originalInode);
  f.linux.processes.delete(700);
  assert.equal(await f.platform.admission(() => 42), 42);
  await assert.rejects(f.linux.lstat(guard), { code: 'ENOENT' });
  assert.equal((await f.linux.readdir(join(f.root, 'runtime'))).some(name => name.startsWith('admission.stale-')), false);
});

test('a reused PID permits recovery without touching the new process', async t => {
  const f = await fixture(t); await seedGuard(f);
  const reused = { pid: 700, ppid: 1, startTicks: '7001', executable: '/unrelated/program', commandline: ['/unrelated/program'] };
  f.linux.processes.set(700, reused);
  assert.equal(await f.platform.admission(() => 'recovered'), 'recovered');
  assert.deepEqual(f.linux.processes.get(700), reused);
});

test('killing every tmux owner during admission still allows the original chat to join again', async t => {
  const f = await fixture(t), initial = f.manager(); await initial.start();
  const { thread } = await initial.call('thread/start', { cwd: '/a' }), receipt = await f.platform.readReceipt([...f.workers.keys()][0]);
  await seedGuard(f, { pid: receipt.worker.pid, startTicks: receipt.worker.startTicks });
  initial.close();
  f.linux.processes.delete(40); f.linux.processes.delete(receipt.worker.pid); f.linux.processes.delete(receipt.codex.pid); f.sessions.clear();
  const restarted = f.manager(); await restarted.start();
  const resumed = await restarted.call('thread/resume', { threadId: thread.id, cwd: '/a' });
  assert.equal(resumed.thread.id, thread.id); assert.equal((await restarted.listRuns()).length, 1); assert.equal(f.newCalls(), 2);
});

test('concurrent stale reclaimers cannot rename or delete a newly acquired live guard', async t => {
  const f = await fixture(t), { guard } = await seedGuard(f);
  const rename = f.linux.rename.bind(f.linux), unlink = f.linux.unlink.bind(f.linux), read = f.linux.readFile.bind(f.linux);
  const fresh = { schemaVersion: 1, owner: 'b'.repeat(32), pid: 1111, startTicks: '11110', executable: process.execPath };
  let renamed = 0, manualRelease = false, freshReady, freshObserved;
  const ready = new Promise(done => { freshReady = done; }), observed = new Promise(done => { freshObserved = done; });
  f.linux.rename = async (from, to) => {
    if (from === guard) { renamed++; assert.equal(renamed, 1, 'a late reclaimer must not rename the new guard'); }
    await rename(from, to);
    if (from === guard) { await f.linux.mkdir(guard, { mode: 0o700 }); await f.platform.writeJSON(join(guard, 'owner.json'), fresh, true); freshReady(); }
  };
  f.linux.readFile = async (path, encoding) => { const data = await read(path, encoding); if (path === join(guard, 'owner.json') && String(data).includes(fresh.owner)) freshObserved(); return data; };
  f.linux.unlink = async path => {
    if (path === join(guard, 'owner.json')) { const value = await f.platform.readJSON(path); if (value.owner === fresh.owner) assert.equal(manualRelease, true, 'a reclaimer must not delete a live owner'); }
    return unlink(path);
  };
  const a = f.platform.admission(() => 'a'), b = f.platform.admission(() => 'b');
  await ready; await observed;
  assert.deepEqual(await f.platform.readJSON(join(guard, 'owner.json')), fresh); assert.equal(renamed, 1);
  manualRelease = true; await f.linux.unlink(join(guard, 'owner.json')); await f.linux.rmdir(guard); manualRelease = false;
  assert.deepEqual((await Promise.all([a, b])).sort(), ['a', 'b']); assert.equal(renamed, 1);
});

test('unknown or changed guard identity is retained without any recovery', async t => {
  const f = await fixture(t), { guard } = await seedGuard(f);
  const path = join(guard, 'owner.json');
  await f.platform.writeJSON(path, { owner: 'old-schema', pid: 700 });
  await assert.rejects(f.platform.admission(() => assert.fail('unknown guard')), { code: 'runtime_admission_unknown' });
  assert.deepEqual(await f.platform.readJSON(path), { owner: 'old-schema', pid: 700 });
});

test('replacing even identical owner JSON during death proof prevents stale recovery', async t => {
  const f = await fixture(t), { guard, record } = await seedGuard(f), stat = f.linux.stat.bind(f.linux);
  const path = join(guard, 'owner.json'), previousInode = (await f.linux.lstat(path)).ino;
  let changed = false;
  f.linux.stat = async pathToRead => {
    if (pathToRead === '/proc/700' && !changed) { changed = true; await f.platform.writeJSON(path, record); }
    return stat(pathToRead);
  };
  await assert.rejects(f.platform.admission(() => assert.fail('changed record must not be recovered')), { code: 'runtime_admission_changed' });
  assert.equal((await f.linux.lstat(guard)).isDirectory(), true); assert.notEqual((await f.linux.lstat(path)).ino, previousInode);
  assert.deepEqual(await f.platform.readJSON(path), record);
});

test('freeze publish failure rolls back only markers newly created by this call', async t => {
  const f = await fixture(t); await f.platform.initialize();
  const old = { schemaVersion: 1, threadId: 'old', operationId: 'same-op' }, unrelated = { schemaVersion: 1, threadId: 'unrelated', operationId: 'other-op' };
  const marker = id => join(f.root, 'runtime', 'thread-freezes', `${id}.json`);
  await f.platform.writeJSON(marker('old'), old, true); await f.platform.writeJSON(marker('unrelated'), unrelated, true);
  const oldInode = (await f.linux.lstat(marker('old'))).ino, link = f.linux.link.bind(f.linux);
  f.linux.link = async (from, to) => { if (to === marker('second')) throw errno('ENOSPC'); return link(from, to); };
  await assert.rejects(f.platform.freezeThreads(['old', 'first', 'second'], 'same-op'), { code: 'ENOSPC' });
  await assert.rejects(f.linux.lstat(marker('first')), { code: 'ENOENT' }); await assert.rejects(f.linux.lstat(marker('second')), { code: 'ENOENT' });
  assert.deepEqual(await f.platform.readJSON(marker('old')), old); assert.equal((await f.linux.lstat(marker('old'))).ino, oldInode);
  assert.deepEqual(await f.platform.readJSON(marker('unrelated')), unrelated);
  assert.equal((await f.linux.readdir(dirname(marker('first')))).some(name => name.includes('.new-')), false);
});

test('freeze rollback preserves a marker replaced by another operation', async t => {
  const f = await fixture(t); await f.platform.initialize();
  const marker = id => join(f.root, 'runtime', 'thread-freezes', `${id}.json`), link = f.linux.link.bind(f.linux);
  const replacement = { schemaVersion: 1, threadId: 'first', operationId: 'another-op' };
  f.linux.link = async (from, to) => { if (to === marker('second')) { await f.platform.writeJSON(marker('first'), replacement); throw errno('ENOSPC'); } return link(from, to); };
  await assert.rejects(f.platform.freezeThreads(['first', 'second'], 'same-op'), { code: 'ENOSPC' });
  assert.deepEqual(await f.platform.readJSON(marker('first')), replacement);
});

test('worker and tmux environments exclude gateway secret/provider settings', () => {
  assert.deepEqual(runtimeEnvironment({ HOME: '/home/demo', PATH: '/usr/bin', LANG: 'C', RELAY_ACCESS_SECRET: 'secret', OPENAI_API_KEY: 'secret', HTTP_PROXY: 'proxy', TMUX: 'other', CODEX_HOME: '/unapproved' }), { HOME: '/home/demo', PATH: '/usr/bin', LANG: 'C' });
});

test('mock mode starts no tmux and reuses the ordinary mock RPC', async () => {
  const library = new EventEmitter(); library.start = async () => {}; library.call = async method => ({ method }); library.close = () => {}; library.child = { pid: 1 };
  const rpc = new RuntimeRpc({}, { mock: true, rpcFactory: () => library, platform: new Proxy({}, { get() { throw Error('mock must not touch platform'); } }) });
  await rpc.start(); assert.deepEqual(await rpc.call('thread/start', {}), { method: 'thread/start' }); assert.deepEqual(await rpc.listRuns(), []); rpc.close();
});
