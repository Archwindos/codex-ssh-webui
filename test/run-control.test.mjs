import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRunControl, createRunControlPlatform } from '../src/run-control.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const tmux = { sessionId: '$7', sessionName: 'manual | session', windowIndex: 0, paneIndex: 0, paneId: '%2', target: '$7:0.0' };
const run = { id: 'managed', threadId: 'root', pid: 80, cwd: '/project', managed: true, status: 'working', revision: 'rev-1', tmuxState: 'attached', tmux };
const observed = (threadId, pid, status = 'idle') => ({ threadId, pid, status, cwd: '/project', tmuxState: 'attached', tmux: { ...tmux }, name: threadId });
function fixture({ runs = [], agents = [], complete = true, unmappedProcesses = 0, platform } = {}) {
  const stops = []; let time = 1000;
  const rpc = { library: { child: { pid: 900 } }, listRuns: async () => clone(runs), stopRun: async (id, revision) => { stops.push({ id, revision }); const index = runs.findIndex(run => run.id === id); if (index < 0 || runs[index].revision !== revision) throw Object.assign(Error('changed'), { code: 'runtime_changed' }); runs.splice(index, 1); return { stopped: true }; } };
  const control = createRunControl({ rpc, observeProcesses: async () => ({ agents: clone(agents), complete, unmappedProcesses }), clock: () => time, ...(platform ? { platform } : {}) });
  return { control, rpc, stops, runs, agents, advance: ms => { time += ms; } };
}

test('runtime list deduplicates only exact thread/pid and preserves idle, approval and unknown tmux Codex', async () => {
  const f = fixture({ runs: [clone(run)], agents: [observed('root', 80, 'idle'), observed('root', 81, 'idle'), observed('child', 80, 'waitingApproval'), observed('unknown', 82, 'unknown'), { ...observed('outside', 83), tmuxState: 'none' }, { threadId: '', pid: 900 }] });
  const rows = await f.control.list();
  assert.equal(rows.length, 5); assert.equal(rows[0].runtimeId, 'managed'); assert.equal(rows[0].status, 'working');
  assert.equal(rows.find(row => row.threadId === 'child').managed, false);
  assert.deepEqual(rows.map(row => row.status), ['working', 'waitingApproval', 'idle', 'idle', 'unknown']);
  assert.equal(rows.find(row => row.threadId === 'outside').tmuxState, 'none');
  assert.equal(rows.filter(row => row.threadId === 'root').length, 2);
  assert.equal(rows.find(row => row.pid === 81).runtimeId, (await f.control.list()).find(row => row.pid === 81).runtimeId);
});

test('writer inspection associates a same-PID child with its actual managed root and ignores only metadata', async () => {
  const f = fixture({ runs: [clone(run)], agents: [observed('child', 80), observed('external', 81), observed('read-only-metadata', 900), { threadId: '', pid: 900 }], unmappedProcesses: 1 });
  const result = await f.control.inspectWriters(['root', 'child', 'external', 'read-only-metadata', 'unheld']);
  assert.equal(result.complete, true); assert.equal(result.holders.length, 3);
  assert.deepEqual(result.holders.find(row => row.threadId === 'child'), { threadId: 'child', managed: true, runId: 'managed', rootThreadId: 'root', pid: 80, status: 'idle' });
  assert.equal(result.holders.find(row => row.threadId === 'external').managed, false);
  assert.equal(result.holders.some(row => row.threadId === 'read-only-metadata' || row.threadId === 'unheld'), false);
  const noHolder = fixture({ agents: [{ pid: 400, threadId: '' }], unmappedProcesses: 1 });
  assert.deepEqual(await noHolder.control.inspectWriters(['unheld']), { complete: true, holders: [] });
  const incomplete = fixture({ agents: [{ pid: 400, threadId: '' }], complete: false, unmappedProcesses: 1 });
  assert.deepEqual(await incomplete.control.inspectWriters(['unheld']), { complete: false, holders: [] });
});

test('stopManagedRuns stops each confirmed root once with its current revision, never an outside parent', async () => {
  const f = fixture({ runs: [clone(run)], agents: [observed('child', 80)] });
  const { holders } = await f.control.inspectWriters(['root', 'child']);
  await assert.rejects(f.control.stopManagedRuns(['child'], { holders: holders.filter(row => row.threadId === 'child') }), { code: 'archive_run_outside_scope' });
  assert.equal(f.stops.length, 0);
  assert.deepEqual(await f.control.stopManagedRuns(['root', 'child'], { holders }), { complete: true, receipts: [{ runId: 'managed', rootThreadId: 'root', status: 'stopped' }] });
  assert.deepEqual(f.stops, [{ id: 'managed', revision: 'rev-1' }]);
});

test('managed close previews pane-only impact and is idempotent without manual tmux commands or archiving', async () => {
  const f = fixture({ runs: [clone(run)], agents: [observed('child', 80)], platform: new Proxy({}, { get() { throw Error('managed close must not use manual platform'); } }) });
  const preview = await f.control.previewClose('managed');
  assert.equal(preview.scope, 'pane'); assert.equal(preview.otherPanesPreserved, true); assert.deepEqual(preview.pane, { id: '%2', target: '$7:0.0' });
  assert.deepEqual(new Set(preview.affectedThreads.map(row => row.id)), new Set(['root', 'child'])); assert.equal(f.stops.length, 0);
  const result = await f.control.close(preview.planId); assert.equal(result.status, 'closed'); assert.equal(result.archived, false);
  assert.deepEqual(await f.control.close(preview.planId), result); assert.equal(f.stops.length, 1);
});

test('managed revision changes and expired plans cannot send a stop', async () => {
  const f = fixture({ runs: [clone(run)] }), preview = await f.control.previewClose('managed');
  f.runs[0].revision = 'new'; await assert.rejects(f.control.close(preview.planId), { code: 'runtime_changed' }); assert.equal(f.stops.length, 0);
  const next = await f.control.previewClose('managed'); f.advance(120001); await assert.rejects(f.control.close(next.planId), { code: 'runtime_plan_expired' });
});

function linuxFixture({ customSocket = false, retainProcess = false } = {}) {
  const processes = new Map(), sessions = new Map(), commands = [], helperScripts = []; let inode = 2;
  const process = (pid, ppid, executable) => ({ pid, ppid, executable, startTicks: `${pid}00`, commandline: [executable] });
  for (const entry of [process(40, 1, '/usr/bin/tmux'), process(50, 40, '/bin/bash'), process(60, 40, '/bin/bash'), process(70, 40, '/bin/bash'), process(80, 50, '/official/codex')]) processes.set(entry.pid, entry);
  sessions.set('$7', [{ ...tmux, panePid: 50 }, { ...tmux, paneId: '%3', paneIndex: 1, target: '$7:0.1', panePid: 60 }]);
  sessions.set('$9', [{ ...tmux, sessionId: '$9', sessionName: 'unrelated', paneId: '%4', panePid: 70 }]);
  const missing = () => Object.assign(Error('gone'), { code: 'ENOENT' });
  const filesystem = {
    async lstat(path) { if (!['/tmp/tmux-1022', '/tmp/tmux-1022/default'].includes(path)) throw missing(); return { uid: 1022, dev: 1, ino: path.endsWith('/default') ? inode : 1, mode: path.endsWith('/default') ? 0o600 : 0o700, isDirectory: () => !path.endsWith('/default'), isSocket: () => path.endsWith('/default'), isSymbolicLink: () => false }; },
    async realpath(path) { return path; },
    async readdir(path) { assert.equal(path, '/proc'); return [...processes.keys()].map(String); },
    async stat(path) { if (!processes.has(Number(path.split('/')[2]))) throw missing(); return { uid: 1022 }; },
    async readlink(path) { const process = processes.get(Number(path.split('/')[2])); if (!process) throw missing(); return process.executable; },
    async readFile(path) {
      const process = processes.get(Number(path.split('/')[2])); if (!process) throw missing();
      if (path.endsWith('/environ')) return Buffer.from(`TMUX=/tmp/tmux-1022/${customSocket ? 'custom' : 'default'},40,7\0TMUX_PANE=%2\0PRIVATE_SECRET=do-not-return\0`);
      if (path.endsWith('/cmdline')) return Buffer.from(process.commandline.join('\0') + '\0');
      return `${process.pid} (process with spaces) ${['S', process.ppid, process.pid, process.pid, ...Array(15).fill(0), process.startTicks, 0].join(' ')}`;
    }
  };
  const exec = async (command, raw, options) => {
    if (command === '/usr/bin/python3') {
      assert.deepEqual(raw.slice(0, 2), ['-I', '-c']); assert.equal(options.env.PRIVATE_SECRET, undefined);
      assert.match(raw[2], /pidfd_send_signal/); assert.match(raw[2], /pidfd_open/);
      const targets = JSON.parse(raw[3]); commands.push(['signal', ...targets.map(target => target.pid)]);
      helperScripts.push({ script: raw[2], targets });
      for (const expected of targets) for (const [key, value] of Object.entries(processes.get(expected.pid))) assert.deepEqual(expected[key], value);
      if (!retainProcess) for (const expected of targets) processes.delete(expected.pid);
      return { stdout: 'requested\n', stderr: '' };
    }
    assert.fail(`External stop must not invoke tmux: ${command}`);
    const args = raw.slice(2); commands.push(args);
    if (args[0] === 'display-message') return { stdout: '40\n', stderr: '' };
    if (args[0] === 'list-sessions') return { stdout: [...sessions.keys()].join('\n') + '\n', stderr: '' };
    if (args[0] === 'list-panes') { const panes = sessions.get(args[args.indexOf('-t') + 1]); if (!panes) throw Object.assign(Error('gone'), { code: 1, stdout: '', stderr: 'gone' }); return { stdout: panes.map(p => [p.sessionId, p.sessionName, p.windowIndex, p.paneIndex, p.paneId, p.panePid].join('|')).join('\n') + '\n', stderr: '' }; }
    if (args[0] === 'kill-session') { assert.deepEqual(args, ['kill-session', '-t', '$7']); const panes = sessions.get('$7'); sessions.delete('$7'); if (!retainProcess) { for (const pane of panes) processes.delete(pane.panePid); processes.delete(80); } return { stdout: '', stderr: '' }; }
    throw Error(`Forbidden tmux command: ${args[0]}`);
  };
  const platform = createRunControlPlatform({ filesystem, exec, uid: () => 1022, system: 'linux', env: { PATH: '/usr/bin', PRIVATE_SECRET: 'do-not-return' } });
  const f = fixture({ agents: [observed('manual', 80)], platform });
  return { ...f, platform, processes, sessions, commands, helperScripts, changeSocket: () => { inode++; } };
}

test('manual close signals only verified Codex subtree and preserves all tmux panes and other commands', async () => {
  const f = linuxFixture();
  f.processes.set(81, { pid: 81, ppid: 80, executable: '/bin/sleep', startTicks: '8100', commandline: ['/bin/sleep', '99'] });
  const row = (await f.control.list())[0], preview = await f.control.previewClose(row.runtimeId);
  assert.equal(preview.scope, 'process'); assert.equal(preview.tmuxUntouched, true); assert.equal(preview.affectedThreads[0].id, 'manual');
  assert.doesNotMatch(JSON.stringify(preview), /PRIVATE_SECRET|do-not-return|socket|commandline/);
  const result = await f.control.close(preview.planId); assert.equal(result.status, 'closed'); assert.equal(result.archived, false);
  assert.ok(f.sessions.has('$7')); assert.ok(f.sessions.has('$9'));
  for (const pid of [40, 50, 60, 70]) assert.ok(f.processes.has(pid));
  assert.equal(f.processes.has(80), false); assert.equal(f.processes.has(81), false);
  assert.deepEqual(f.commands, [['signal', 80, 81]]);
  assert.deepEqual(await f.control.close(preview.planId), result); assert.equal(f.commands.length, 1);
});

test('external targets work outside tmux and unknown attribution never grants tmux control', async () => {
  for (const tmuxState of ['none', 'unknown']) {
    const f = linuxFixture({ customSocket: true }); f.agents[0].tmuxState = tmuxState; f.agents[0].tmux = null;
    const row = (await f.control.list())[0], preview = await f.control.previewClose(row.runtimeId);
    assert.equal(row.tmuxState, tmuxState); assert.equal(preview.session, null); assert.equal(preview.scope, 'process');
    assert.equal((await f.control.close(preview.planId)).status, 'closed'); assert.deepEqual(f.commands, [['signal', 80]]);
  }
});

test('manual close rejects PID reuse, changed command identity and new descendants before signaling', async t => {
  for (const [name, change] of [
    ['pid', f => { f.processes.get(80).startTicks = '999'; }],
    ['exec', f => { f.processes.get(80).executable = '/bin/bash'; }],
    ['command', f => { f.processes.get(80).commandline.push('--other'); }],
    ['child', f => { f.processes.set(81, { pid: 81, ppid: 80, startTicks: '8100', executable: '/bin/sleep', commandline: ['/bin/sleep'] }); }]
  ]) await t.test(name, async () => {
    const f = linuxFixture(), preview = await f.control.previewClose((await f.control.list())[0].runtimeId); change(f);
    await assert.rejects(f.control.close(preview.planId)); assert.equal(f.commands.length, 0);
  });
});

test('manual close reports partial when a verified process stays alive and never resends', async () => {
  const f = linuxFixture({ retainProcess: true }), preview = await f.control.previewClose((await f.control.list())[0].runtimeId);
  const result = await f.control.close(preview.planId); assert.equal(result.status, 'partial'); assert.equal(result.affected[0].status, 'unknown');
  await f.control.close(preview.planId); assert.deepEqual(f.commands, [['signal', 80]]); assert.ok(f.sessions.has('$7'));
});

test('external preview includes child Codex conversations in its verified process subtree only', async () => {
  const f = linuxFixture(); f.processes.set(81, { pid: 81, ppid: 80, executable: '/official/codex', startTicks: '8100', commandline: ['/official/codex'] });
  f.agents.push(observed('child-codex', 81), observed('other-pane-codex', 70));
  const row = (await f.control.list()).find(row => row.pid === 80), preview = await f.control.previewClose(row.runtimeId);
  assert.deepEqual(new Set(preview.affectedThreads.map(row => row.id)), new Set(['manual', 'child-codex']));
  assert.equal((await f.control.close(preview.planId)).status, 'closed'); assert.ok(f.processes.has(70));
});

test('an unmapped Codex process is visible and stoppable without inventing a conversation', async () => {
  const f = linuxFixture(); f.agents[0].threadId = ''; f.agents[0].tmuxState = 'none'; f.agents[0].tmux = null;
  const row = (await f.control.list())[0]; assert.equal(row.threadId, null); assert.equal(row.canOpen, false); assert.equal(row.lifecycle.reason, 'external_runtime');
  const preview = await f.control.previewClose(row.runtimeId); assert.deepEqual(preview.affectedThreads, []); assert.equal((await f.control.close(preview.planId)).status, 'closed');
});

test('frozen state reads only the exact private thread marker and treats unreadable identity conservatively', async () => {
  const f = fixture(); let failure;
  f.rpc.platform = { root: '/private', readJSON: async path => { assert.equal(path.replaceAll('\\', '/'), '/private/runtime/thread-freezes/root.json'); if (failure) throw Object.assign(Error('unreadable'), { code: failure }); return { threadId: 'root' }; } };
  assert.equal(await f.control.isFrozen('root'), true); failure = 'ENOENT'; assert.equal(await f.control.isFrozen('root'), false); failure = 'EACCES'; assert.equal(await f.control.isFrozen('root'), true);
});

test('Python 3.8 fallback sends SIGTERM through validated pidfds and refuses changed identities or unknown architectures', { skip: process.platform !== 'linux' }, async () => {
  const f = linuxFixture(), row = (await f.control.list())[0], preview = await f.control.previewClose(row.runtimeId); await f.control.close(preview.planId);
  const { script, targets } = f.helperScripts[0];
  const harness = `import os,sys,json,signal,ctypes,platform,builtins,io,types
source,expected_json,variant=sys.argv[1:]; expected=json.loads(expected_json); records={item['pid']:item for item in expected}; calls=[]; closed=[]
for module,name in [(os,'pidfd_open'),(signal,'pidfd_send_signal')]:
 if hasattr(module,name): delattr(module,name)
platform.machine=lambda:'aarch64' if variant=='architecture' else 'x86_64'
class Syscall:
 def __call__(self,number,*args):
  values=[getattr(value,'value',value) for value in args]; calls.append([number.value]+values)
  return 701 if number.value==434 else 0
ctypes.CDLL=lambda *args,**kwargs:types.SimpleNamespace(syscall=Syscall())
os.getuid=lambda:1022; os.stat=lambda path:types.SimpleNamespace(st_uid=1022); os.close=lambda handle:closed.append(handle)
os.readlink=lambda path:records[int(path.split('/')[2])]['executable']
def opened(path,mode='r'):
 item=records[int(path.split('/')[2])]
 if path.endswith('/cmdline'): return io.BytesIO(('\\0'.join(item['commandline'])+'\\0').encode())
 ticks=item['startTicks']+('1' if variant=='identity' else '')
 fields=['S',str(item['ppid']),str(item.get('pgid',0)),str(item.get('sid',0)),str(item.get('tty',0))]+['0']*14+[ticks,'0']
 return io.StringIO(str(item['pid'])+' (fixture) '+' '.join(fields))
builtins.open=opened; sys.argv=['helper',expected_json]; failure=None
try: exec(source,{})
except Exception as error: failure=type(error).__name__
print(json.dumps(dict(calls=calls,closed=closed,error=failure)))
`;
  const run = variant => {
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', harness, script, JSON.stringify(targets), variant], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const safe = run('safe'); assert.equal(safe.error, null); assert.deepEqual(safe.calls, [[434, 80, 0], [424, 701, 15, null, 0]]); assert.deepEqual(safe.closed, [701]);
  const changed = run('identity'); assert.equal(changed.error, 'RuntimeError'); assert.deepEqual(changed.calls, [[434, 80, 0]]); assert.deepEqual(changed.closed, [701]);
  const unsupported = run('architecture'); assert.equal(unsupported.error, 'RuntimeError'); assert.deepEqual(unsupported.calls, []); assert.deepEqual(unsupported.closed, []);
});
