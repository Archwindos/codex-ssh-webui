import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRelay, validateConfig } from '../src/server.mjs';
import { RpcClient, validateProduction } from '../src/protocol.mjs';

const config = { projects: [{ id: 'home', name: 'Home', cwd: '/workspace' }] };
async function fixture(t, options = {}) {
  const relay = await createRelay({ port: 0, ...options }); t.after(() => relay.close());
  let cookie = '', csrf = '';
  const request = async (path, body, headers = {}) => {
    const options = { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(relay.publicOrigin).host, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers } };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    // Model the trusted reverse proxy's preserved Host without fetch rewriting it.
    const response = relay.publicOrigin === relay.origin ? await fetch(relay.origin + path, { ...options, body: encoded }) : await new Promise((resolve, reject) => {
      const req = http.request(relay.origin + path, options, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers), json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      }); req.on('error', reject); req.end(encoded);
    });
    const data = await response.json();
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    if (data.csrf) csrf = data.csrf;
    return { status: response.status, data, response };
  };
  const session = () => request('/api/session');
  const create = async () => (await request('/api/threads', { projectId: 'home' })).data.thread;
  return { relay, request, session, create, cookie: () => cookie };
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 150; n++) { if (fn()) return; await delay(10); } assert.fail('Timed out waiting for fixture'); }

test('mock starts only local fixture, HTTP session and security headers', async t => {
  const f = await fixture(t);
  assert.equal(f.relay.server.address().address, '127.0.0.1');
  assert.equal(f.relay.rpc.child, undefined);
  assert.equal((await f.request('/api/threads?project=home')).status, 401);
  const s = await f.session(); assert.equal(s.data.mode, 'mock'); assert.equal(s.data.authenticated, true); assert.ok(s.data.csrf);
  assert.match(s.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(s.response.headers.get('cache-control'), 'no-store'); assert.match(s.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('Origin, CSRF, query-token, extra parameters and unknown RPC are rejected', async t => {
  const f = await fixture(t); await f.session();
  assert.equal((await f.request('/api/threads', { projectId: 'home' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/threads', { projectId: 'home' }, { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await f.request('/api/threads', { projectId: 'home' }, { Origin: '' })).status, 403);
  assert.equal((await f.request('/api/threads', { projectId: 'home', cwd: '/etc', model: 'anything' })).status, 400);
  assert.equal((await f.request('/api/threads', { projectId: 'foreign' })).status, 400);
  assert.equal((await f.request('/api/session?token=secret')).status, 400);
  assert.equal((await f.request('/api/rpc', { method: 'shell', params: {} })).status, 404);
  assert.equal(f.relay.rpc.child, undefined);
});
test('Host rebinding and cross-origin event streams fail', async t => {
  const f = await fixture(t); await f.session();
  const result = await new Promise((resolve, reject) => {
    const req = http.get(f.relay.origin + '/api/session', { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
  });
  assert.equal(result, 403);
  assert.equal((await f.request('/api/events', undefined, { Origin: 'https://evil.example' })).status, 403);
});
test('thread list filters foreign cwd and resume validates history before accepting', async t => {
  const f = await fixture(t); await f.session();
  const thread = await f.create(); assert.equal(thread.cwd, '/workspace');
  const list = await f.request('/api/threads?project=home'); assert.equal(list.status, 200); assert.equal(list.data.data.length, 1); assert.ok(!JSON.stringify(list.data).includes('MUST_NOT_LEAK'));
  assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: 'foreign-thread' })).status, 403);
  assert.equal((await f.request('/api/threads?project=home&cursor=foreign')).status, 400);
  assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: thread.id })).status, 200);
});
test('streaming turn, submission deduplication and interrupted status', async t => {
  const f = await fixture(t); await f.session(); const thread = await f.create();
  const body = { projectId: 'home', threadId: thread.id, text: '模拟流式长消息', submissionId: 'submission-1' };
  const first = await f.request('/api/turns', body); assert.equal(first.status, 200); assert.equal(first.data.duplicate, false);
  const duplicate = await f.request('/api/turns', body); assert.equal(duplicate.data.duplicate, true); assert.equal(duplicate.data.turn.id, first.data.turn.id);
  assert.equal((await f.request('/api/turns', { ...body, text: '不同消息' })).status, 409);
  assert.equal((await f.request('/api/turns', { ...body, submissionId: 'submission-2' })).status, 409);
  assert.equal((await f.request('/api/interrupt', { threadId: thread.id, turnId: first.data.turn.id })).status, 200);
  await until(() => f.relay.state.events.some(e => e.data.method === 'turn/completed'));
  const resumed = await f.request('/api/resume', { projectId: 'home', threadId: thread.id });
  assert.equal(resumed.data.thread.turns.length, 1); assert.equal(resumed.data.thread.turns[0].status, 'interrupted');
});
test('approval remains pending after stream disconnect, answers once, unknown request is safely refused', async t => {
  const f = await fixture(t); await f.session(); const thread = await f.create();
  const abort = new AbortController();
  const stream = await fetch(f.relay.origin + '/api/events', { headers: { Cookie: f.cookie(), Origin: f.relay.origin }, signal: abort.signal }); assert.equal(stream.status, 200); abort.abort();
  await f.request('/api/turns', { projectId: 'home', threadId: thread.id, text: '审批，未知请求', submissionId: 'approval-submission' });
  await until(() => f.relay.state.approvals.size === 1);
  const session = await f.session(); assert.equal(session.data.pendingApprovals.length, 1);
  const requestId = session.data.pendingApprovals[0].id;
  assert.equal((await f.request('/api/approvals', { requestId, decision: 'decline' })).status, 200);
  assert.equal((await f.request('/api/approvals', { requestId, decision: 'accept' })).status, 409);
  await until(() => f.relay.state.events.some(e => e.data.method === 'turn/completed'));
  assert.ok(f.relay.state.events.some(e => e.data.message?.includes('不支持')));
  assert.ok(!JSON.stringify(f.relay.state.events).includes('MUST_NOT_LEAK'));
  const resumed = await f.request('/api/resume', { projectId: 'home', threadId: thread.id });
  assert.match(resumed.data.thread.turns[0].items.at(-1).text, /审批已拒绝/);
});
test('approval accept is simulated and never invokes a command', async t => {
  const f = await fixture(t); await f.session(); const thread = await f.create();
  await f.request('/api/turns', { projectId: 'home', threadId: thread.id, text: '审批', submissionId: 'approval-accept' });
  await until(() => f.relay.state.approvals.size === 1); const requestId = [...f.relay.state.approvals.keys()][0];
  await f.request('/api/approvals', { requestId, decision: 'accept' }); await until(() => f.relay.state.events.some(e => e.data.method === 'turn/completed'));
  const resumed = await f.request('/api/resume', { projectId: 'home', threadId: thread.id }); assert.match(resumed.data.thread.turns[0].items.at(-1).text, /模拟命令/);
});
test('SSE replays bounded event IDs and emits resync when replay unavailable', async t => {
  const f = await fixture(t); await f.session(); const thread = await f.create();
  await f.request('/api/turns', { projectId: 'home', threadId: thread.id, text: '你好', submissionId: 'sse-submission' });
  await until(() => f.relay.state.events.length > 3);
  const abort = new AbortController();
  const response = await fetch(f.relay.origin + '/api/events', { headers: { Cookie: f.cookie(), 'Last-Event-ID': '1' }, signal: abort.signal });
  const reader = response.body.getReader(); const chunk = new TextDecoder().decode((await reader.read()).value); abort.abort();
  assert.match(chunk, /id: 2/); assert.doesNotMatch(chunk, /id: 1\n/); assert.match(chunk, /event: rpc/);
  const abort2 = new AbortController();
  const response2 = await fetch(f.relay.origin + '/api/events', { headers: { Cookie: f.cookie(), 'Last-Event-ID': '999999' }, signal: abort2.signal });
  const chunk2 = new TextDecoder().decode((await response2.body.getReader().read()).value); abort2.abort(); assert.match(chunk2, /resync/);
});
test('mock process exit clears pending, refuses reconnection and never resends', async t => {
  const f = await fixture(t); await f.session(); const thread = await f.create();
  const body = { projectId: 'home', threadId: thread.id, text: '退出', submissionId: 'exit-submission' };
  const first = await f.request('/api/turns', body); const child = f.relay.rpc.child;
  await until(() => f.relay.rpc.ended);
  assert.equal(f.relay.state.approvals.size, 0); assert.equal((await f.session()).data.connected, false);
  const again = await f.request('/api/turns', body); assert.equal(again.data.duplicate, true); assert.equal(again.data.turn.id, first.data.turn.id);
  assert.equal((await f.request('/api/threads', { projectId: 'home' })).status, 503); assert.equal(f.relay.rpc.child, child);
});
test('production fails closed without verified schema and user-provided secret', () => {
  const c = { ...config, sshTarget: 'codex-server', remoteCodex: '/opt/codex/bin/codex', verifiedProtocol: { version: '0.165.0', verified: false, schemaVerified: false } };
  assert.throws(() => validateProduction(c, {}), /协议和 schema/);
  c.verifiedProtocol.verified = true; c.verifiedProtocol.schemaVerified = true;
  assert.throws(() => validateProduction(c, { RELAY_VERIFIED_PROTOCOL: '0.165.0' }), /32 字符/);
  assert.throws(() => validateProduction({ ...c, sshTarget: '--unsafe' }, {}), /SSH 目标/);
  assert.throws(() => validateConfig({ projects: [{ id: 'x', name: 'x', cwd: '/home/../etc' }] }, true), /cwd/);
  assert.throws(() => validateProduction({ ...c, verifiedProtocol: { ...c.verifiedProtocol, version: '0.163.0' } }, {}), /协议和 schema/);
});
class FakeRpc extends EventEmitter {
  connected = false; ended = false; calls = []; mode = 'normal';
  async start() { this.connected = true; }
  close() { this.connected = false; }
  answer(id, result) { this.answerResult = { id, result }; }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: this.mode === 'read-mismatch' ? '/foreign' : '/workspace', turns: [] } };
    if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/foreign', turns: [] } };
    throw Error('unexpected method');
  }
}
test('resume verifies cwd twice and never starts turn on a mismatched history', async t => {
  const rpc = new FakeRpc(); const f = await fixture(t, { rpc }); await f.session();
  rpc.mode = 'read-mismatch'; assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: 'thread-1' })).status, 403); assert.equal(rpc.calls.length, 1);
  rpc.mode = 'normal'; assert.equal((await f.request('/api/resume', { projectId: 'home', threadId: 'thread-1' })).status, 403); assert.equal(f.relay.state.authorizedThreads.size, 0);
  assert.equal((await f.request('/api/turns', { projectId: 'home', threadId: 'thread-1', text: 'hello', submissionId: 'safe-1' })).status, 403);
  assert.ok(!rpc.calls.some(c => c.method === 'turn/start'));
});
test('unknown JSON-RPC request returns -32601 and raw params are not forwarded', () => {
  const rpc = new RpcClient(config); let written, unsupported = false;
  rpc.write = message => { written = message; }; rpc.on('unsupported', () => { unsupported = true; });
  rpc.receive({ id: 7, method: 'unknown/secret', params: { token: 'private' } });
  assert.equal(written.error.code, -32601); assert.equal(written.id, 7); assert.equal(unsupported, true); assert.ok(!JSON.stringify(written).includes('private'));
});
test('foreign approvals declined, process close clears pending approval without accept', async t => {
  const rpc = new FakeRpc(); const f = await fixture(t, { rpc }); await f.session();
  rpc.emit('approval', { id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign', cwd: '/foreign' } });
  assert.equal(rpc.answerResult.result.decision, 'decline'); assert.equal(f.relay.state.approvals.size, 0);
  f.relay.state.authorizedThreads.set('thread-1', '/workspace'); f.relay.state.activeTurns.set('thread-1', 'turn-1');
  rpc.emit('approval', { id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', cwd: '/workspace' } }); assert.equal(f.relay.state.approvals.size, 1);
  rpc.emit('closed'); assert.equal(f.relay.state.approvals.size, 0); assert.equal(rpc.answerResult.id, 1);
});
test('logout destroys session and prior cookie cannot call API', async t => {
  const f = await fixture(t); await f.session();
  assert.equal((await f.request('/api/logout', {})).status, 200);
  assert.equal((await f.request('/api/threads?project=home')).status, 401);
});

test('UTF-8 split across every byte survives protocol decoding; ChatGPT auth flag does not mean logged out', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  child.stdin.on('data', chunk => {
    const m = JSON.parse(chunk.toString()); if (!m.id) return;
    const result = m.method === 'initialize' ? { userAgent: 'codex_cli_rs/0.165.0' } : { account: { type: 'chatgpt', email: 'fixture@example.invalid' }, requiresOpenaiAuth: true };
    for (const byte of Buffer.from(JSON.stringify({ id: m.id, result }) + '\n')) child.stdout.write(Buffer.from([byte]));
  });
  let spawnArgs;
  const rpc = new RpcClient({ ...config, sshTarget: 'codex-server', remoteCodex: '/opt/codex/bin/codex', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } }, { mock: false, spawnProcess: (...args) => { spawnArgs = args; return child; } });
  await rpc.start(); assert.equal(rpc.connected, true); assert.equal(spawnArgs[0], 'ssh'); assert.ok(!Object.hasOwn(spawnArgs[2].env, 'RELAY_ACCESS_SECRET')); assert.equal(spawnArgs[2].windowsHide, true);
  if (process.platform === 'win32') assert.equal(spawnArgs[2].env.ProgramData, process.env.ProgramData);
  let received; rpc.on('notification', m => received = m);
  for (const byte of Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '中文消息🙂' } }) + '\n')) child.stdout.write(Buffer.from([byte]));
  assert.equal(received.params.delta, '中文消息🙂'); rpc.close();
});

test('paginated history uses metadata ownership, exposes scoped older-history cursor, and rejects foreign threads', async t => {
  class HistoryRpc extends FakeRpc {
    async call(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: params.threadId, cwd: params.threadId === 'foreign' ? '/other' : '/workspace', turns: [] } }; }
      if (method === 'thread/resume') { assert.equal(params.excludeTurns, true); return { thread: { id: params.threadId, cwd: '/workspace', turns: [] } }; }
      if (method === 'thread/turns/list') { assert.equal(params.itemsView, 'full'); return { data: [{ id: params.cursor ? 'older' : 'latest', status: 'completed', items: [{ id: params.cursor ? 'old-answer' : 'new-answer', type: 'agentMessage', text: params.cursor ? '早期记录' : '最近记录' }] }], nextCursor: params.cursor ? null : 'remote-history-cursor' }; }
      throw Error('unexpected call');
    }
  }
  const rpc = new HistoryRpc(), f = await fixture(t, { rpc }); await f.session();
  const first = await f.request('/api/resume', { projectId: 'home', threadId: 'thread-1' }); assert.equal(first.status, 200); assert.equal(first.data.thread.turns[0].items[0].text, '最近记录'); assert.ok(first.data.nextCursor); assert.notEqual(first.data.nextCursor, 'remote-history-cursor');
  const next = await f.request(`/api/history?project=home&thread=thread-1&cursor=${first.data.nextCursor}`); assert.equal(next.status, 200); assert.equal(next.data.turns[0].items[0].text, '早期记录'); assert.equal(next.data.nextCursor, null);
  assert.equal((await f.request(`/api/history?project=home&thread=foreign&cursor=${first.data.nextCursor}`)).status, 403);
});

test('server-resolved and stale-turn approvals cannot later be approved', async t => {
  const rpc = new FakeRpc(), f = await fixture(t, { rpc }); await f.session();
  f.relay.state.authorizedThreads.set('thread-1', '/workspace'); f.relay.state.activeTurns.set('thread-1', 'turn-1');
  const params = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', cwd: '/workspace' };
  rpc.emit('approval', { id: 10, method: 'item/commandExecution/requestApproval', params }); assert.equal(f.relay.state.approvals.size, 1);
  rpc.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 10 } });
  assert.equal(f.relay.state.approvals.size, 0); assert.equal((await f.request('/api/approvals', { requestId: '10', decision: 'accept' })).status, 409);
  rpc.emit('approval', { id: 11, method: 'item/commandExecution/requestApproval', params: { ...params, turnId: 'stale-turn' } }); assert.equal(rpc.answerResult.result.decision, 'decline'); assert.equal(f.relay.state.approvals.size, 0);
});

const productionConfig = { ...config, sshTarget: 'codex-server', remoteCodex: '/opt/codex/bin/codex', publicOrigin: 'https://fixture.example.invalid', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
const fixtureEnv = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };

test('production validates HTTPS origin and Secure cookie, login limit survives anonymous session replacement', async t => {
  const c = { ...productionConfig, publicOrigin: 'https://relay.test.example' };
  const f = await fixture(t, { mock: false, config: c, env: fixtureEnv, rpc: new FakeRpc() });
  const session = await f.session(); assert.equal(session.status, 200, JSON.stringify(session.data)); assert.match(session.response.headers.get('set-cookie'), /; Secure/); assert.equal(session.data.authenticated, false);
  for (let i = 0; i < 5; i++) { await f.request('/api/session', undefined, { Cookie: '' }); assert.equal((await f.request('/api/login', { secret: 'incorrect' })).status, 401); }
  await f.request('/api/session', undefined, { Cookie: '' }); assert.equal((await f.request('/api/login', { secret: fixtureEnv.RELAY_ACCESS_SECRET })).status, 429);
  assert.throws(() => validateProduction({ ...c, publicOrigin: 'http://relay.test.example' }, fixtureEnv), /HTTPS/);
});

test('expired sessions free capacity and active streams close at absolute expiry', async t => {
  let now = 1000;
  const f = await fixture(t, { clock: () => now, sessionTtlMs: 50, idleTtlMs: 1000, maintenanceMs: 5 }); await f.session();
  const oldCookie = f.cookie(), abort = new AbortController();
  const stream = await fetch(f.relay.origin + '/api/events', { headers: { Cookie: oldCookie }, signal: abort.signal }); const reader = stream.body.getReader(); await reader.read();
  now = 1051; await until(() => f.relay.state.sessions.size === 0);
  let done = false; for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done; assert.equal(done, true); abort.abort();
  const next = await f.session(); assert.equal(next.status, 200); assert.notEqual(f.cookie(), oldCookie); assert.equal(f.relay.state.sessions.size, 1);
});
