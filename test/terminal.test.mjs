import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createTerminalManager, terminalEnvironment } from '../src/terminal.mjs';

const encode = value => Buffer.from(value).toString('base64');
const text = page => Buffer.from(page.data, 'base64').toString('utf8');
function fixture(t, options = {}) {
  let now = 1000;
  const active = new Set(['owner-a', 'owner-b', 'owner-c']), backends = [];
  const manager = createTerminalManager({ platform: 'linux', authorizeOwner: owner => active.has(owner), maintenanceMs: 0, clock: () => now,
    backendFactory: callbacks => {
      const backend = { ...callbacks, ready: Promise.resolve(), writes: [], sizes: [], closed: 0,
        write(bytes) { this.writes.push(Buffer.from(bytes)); }, resize(size) { this.sizes.push(size); }, close() { this.closed++; this.onExit(null, 'closed'); } };
      backends.push(backend); return backend;
    }, ...options });
  t.after(() => manager.closeAll());
  return { manager, active, backends, advance: ms => { now += ms; } };
}

test('PTY environment excludes relay secrets, dynamic loaders and inherited shell hooks', () => {
  const env = terminalEnvironment({ RELAY_ACCESS_SECRET: 'secret', SSH_AUTH_SOCK: '/agent', BASH_ENV: '/unsafe', ENV: '/unsafe', PYTHONPATH: '/unsafe', LD_PRELOAD: '/unsafe', PATH: '/unsafe', LANG: 'en_US.UTF-8' });
  assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'HISTFILE', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'].sort());
  assert.equal(env.PATH.includes('/unsafe'), false); assert.equal(env.LANG, 'en_US.UTF-8'); assert.equal(env.HISTFILE, '/dev/null');
  assert.equal(env.PATH.startsWith(`${env.HOME}/.local/bin:`), true);
});
test('production backend fails closed outside Linux and unauthenticated owners cannot create', async t => {
  const windows = fixture(t, { platform: 'win32' }); assert.equal(windows.manager.capability(), false);
  await assert.rejects(windows.manager.create('owner-a'), { code: 'terminal_unavailable' }); assert.equal(windows.backends.length, 0);
  const secure = createTerminalManager({ maintenanceMs: 0 }); t.after(() => secure.closeAll());
  await assert.rejects(secure.create('unrecognized'), { code: 'session_required' });
});
test('one terminal per authenticated owner; other owners cannot poll, control or close it', async t => {
  const f = fixture(t), a = await f.manager.create('owner-a', { cols: 100, rows: 30 });
  assert.match(a.id, /^[A-Za-z0-9_-]{32}$/); assert.equal(a.cwd, '/'); assert.equal(a.cursor, 0);
  await assert.rejects(f.manager.create('owner-a'), { code: 'terminal_exists' });
  await assert.rejects(f.manager.poll('owner-b', a.id, 0, { waitMs: 0 }), { code: 'terminal_missing' });
  for (const operation of [() => f.manager.input('owner-b', a.id, encode('pwd\r')), () => f.manager.resize('owner-b', a.id, { cols: 80, rows: 24 }), () => f.manager.heartbeat('owner-b', a.id), () => f.manager.close('owner-b', a.id)]) assert.throws(operation, { code: 'terminal_missing' });
  assert.equal(f.backends[0].writes.length, 0); assert.equal(f.backends[0].closed, 0);
});
test('total resources include helpers that are still shutting down', async t => {
  const f = fixture(t, { maxTotal: 1 }); const a = await f.manager.create('owner-a');
  f.backends[0].close = function () { this.closed++; };
  f.manager.close('owner-a', a.id);
  await assert.rejects(f.manager.create('owner-b'), { code: 'terminal_limit' });
  f.backends[0].onExit(null, 'closed');
  assert.ok((await f.manager.create('owner-b')).id);
});
test('bounded byte replay returns recoverable cursors without replaying input', async t => {
  const f = fixture(t, { outputLimit: 10, pageLimit: 4 }), a = await f.manager.create('owner-a');
  f.backends[0].onOutput(Buffer.from('1234567890abcdef'));
  const first = await f.manager.poll('owner-a', a.id, 0, { waitMs: 0 });
  assert.equal(first.reset, true); assert.equal(text(first), '7890'); assert.equal(first.cursor, 10);
  const second = await f.manager.poll('owner-a', a.id, first.cursor, { waitMs: 0 }); assert.equal(second.reset, false); assert.equal(text(second), 'abcd');
  const replay = await f.manager.poll('owner-a', a.id, first.cursor, { waitMs: 0 }); assert.deepEqual(replay, second); assert.equal(f.backends[0].writes.length, 0);
});
test('input preserves bytes and Ctrl keys; rejects oversized or noncanonical encodings and dimensions', async t => {
  const f = fixture(t), a = await f.manager.create('owner-a'); const bytes = Buffer.from([3, 9, 27, 91, 65, 0xff]);
  assert.equal(f.manager.input('owner-a', a.id, bytes.toString('base64')).accepted, true); assert.deepEqual(f.backends[0].writes[0], bytes);
  for (const bad of ['', 'not-base64!', 'Zh==', encode(Buffer.alloc(16385)), null]) assert.throws(() => f.manager.input('owner-a', a.id, bad), { code: 'terminal_input' });
  assert.deepEqual(f.manager.resize('owner-a', a.id, { cols: 132, rows: 40 }), { cols: 132, rows: 40 });
  for (const size of [null, [], {}, { cols: 0, rows: 24 }, { cols: 80.5, rows: 24 }, { cols: 80, rows: 201 }, { cols: '80', rows: 24 }, { cols: 80, rows: 24, cwd: '/tmp' }]) assert.throws(() => f.manager.resize('owner-a', a.id, size), { code: 'terminal_size' });
  await assert.rejects(f.manager.poll('owner-a', a.id, 1, { waitMs: 0 }), { code: 'terminal_cursor' });
  await assert.rejects(f.manager.poll('owner-a', '../other', 0, { waitMs: 0 }), { code: 'terminal_id' });
});
test('closed output drains across bounded pages before the browser ends the reader', async t => {
  const f = fixture(t, { pageLimit: 4 }), a = await f.manager.create('owner-a');
  f.backends[0].onOutput(Buffer.from('abcdefgh')); f.backends[0].onExit(0, 'exited');
  const first = await f.manager.poll('owner-a', a.id, 0, { waitMs: 0 }); assert.equal(first.closed, true); assert.equal(first.hasMore, true); assert.equal(text(first), 'abcd');
  const last = await f.manager.poll('owner-a', a.id, first.cursor, { waitMs: 0 }); assert.equal(last.closed, true); assert.equal(last.hasMore, false); assert.equal(text(last), 'efgh');
});
test('long poll permits one reader, resolves on output and rejects if auth was revoked while waiting', async t => {
  const f = fixture(t), a = await f.manager.create('owner-a');
  const first = f.manager.poll('owner-a', a.id, 0);
  await assert.rejects(f.manager.poll('owner-a', a.id, 0), { code: 'terminal_poll_busy' });
  f.backends[0].onOutput(Buffer.from('ready')); assert.equal(text(await first), 'ready');
  const pending = f.manager.poll('owner-a', a.id, 5);
  f.active.delete('owner-a'); f.manager.maintenance();
  await assert.rejects(pending, { code: 'session_required' }); assert.equal(f.backends[0].closed, 1);
  assert.throws(() => f.manager.input('owner-a', a.id, encode('anything')), { code: 'session_required' });
});
test('pending creation is reserved and logout destroys the eventual helper', async t => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { backendFactory: callbacks => { const backend = { ...callbacks, ready, closed: 0, close() { this.closed++; this.onExit(null, 'closed'); } }; f.backends.push(backend); return backend; } });
  const creation = f.manager.create('owner-a');
  await assert.rejects(f.manager.create('owner-a'), { code: 'terminal_exists' });
  f.active.delete('owner-a'); f.manager.closeOwner('owner-a'); release();
  await assert.rejects(creation, { code: 'session_required' }); assert.equal(f.backends[0].closed, 1);
});
test('heartbeats renew only their owner lease; expiry, explicit close and shutdown are idempotent', async t => {
  const f = fixture(t, { leaseMs: 60000, retentionMs: 10000 }), a = await f.manager.create('owner-a');
  f.advance(55000); f.manager.heartbeat('owner-a', a.id); f.advance(55000); f.manager.maintenance(); assert.equal(f.backends[0].closed, 0);
  f.advance(5000); f.manager.maintenance(); assert.equal(f.backends[0].closed, 1);
  const expired = await f.manager.poll('owner-a', a.id, 0, { waitMs: 0 }); assert.equal(expired.closed, true); assert.equal(expired.reason, 'lease_expired');
  assert.throws(() => f.manager.input('owner-a', a.id, encode('x')), { code: 'terminal_closed' });
  f.manager.close('owner-a', a.id); assert.equal(f.backends[0].closed, 1);
  f.advance(10000); f.manager.maintenance(); await assert.rejects(f.manager.poll('owner-a', a.id, 0, { waitMs: 0 }), { code: 'terminal_missing' });
  f.manager.closeAll(); assert.equal(f.manager.capability(), false); await assert.rejects(f.manager.create('owner-a'), { code: 'terminal_unavailable' });
});
test('aborted long poll cleans its reader slot', async t => {
  const f = fixture(t), a = await f.manager.create('owner-a'), abort = new AbortController();
  const pending = f.manager.poll('owner-a', a.id, 0, { signal: abort.signal }); abort.abort(); await pending;
  assert.equal((await f.manager.poll('owner-a', a.id, 0, { waitMs: 0 })).cursor, 0);
});

test('Linux real PTY starts at /, supports resize and Ctrl-C, closes its jobs while preserving unrelated processes', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const manager = createTerminalManager({ authorizeOwner: owner => owner === 'real-test' }); t.after(() => manager.closeAll());
  const unrelated = spawn('/bin/sleep', ['30']); t.after(() => unrelated.kill());
  const terminal = await manager.create('real-test', { cols: 90, rows: 25 }); let cursor = 0, output = '';
  async function until(pattern) {
    const deadline = Date.now() + 5000;
    while (!pattern.test(output) && Date.now() < deadline) { const page = await manager.poll('real-test', terminal.id, cursor, { waitMs: 500 }); cursor = page.cursor; output += text(page); }
    assert.match(output, pattern); return output;
  }
  const input = value => manager.input('real-test', terminal.id, encode(value));
  input("printf '__PWD:%s__\\n' \"$PWD\"; test -t 0 && printf '__TTY__\\n'\r");
  await until(/__PWD:\/__\r?\n/); await until(/__TTY__\r?\n/);
  manager.resize('real-test', terminal.id, { cols: 110, rows: 33 }); input("stty size; printf '__SIZE_DONE__\\n'\r"); await until(/33 110\r?\n/);
  input('sleep 30\r'); await delay(100); input('\x03'); input("printf '__INTERRUPTED__\\n'\r"); await until(/__INTERRUPTED__\r?\n/);
  input("sleep 30 & printf '__CHILD:%s__\\n' \"$!\"\r"); await until(/__CHILD:(\d+)__\r?\n/);
  const pid = Number(output.match(/__CHILD:(\d+)__/)[1]); manager.close('real-test', terminal.id);
  let gone = false;
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) { gone = true; break; } }
    catch { gone = true; break; }
    await delay(50);
  }
  assert.equal(gone, true, 'terminal background job must no longer be running'); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});
