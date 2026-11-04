import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import { SharedRpcClient } from '../src/shared-rpc.mjs';

const config = { sharedDaemonSocket: '/fixture-only/app-server-control.sock' };
function serverFrame(opcode, payload, fin = true) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload), extra = bytes.length < 126 ? 0 : bytes.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + extra);
  header[0] = (fin ? 0x80 : 0) | opcode; header[1] = extra === 0 ? bytes.length : extra === 2 ? 126 : 127;
  if (extra === 2) header.writeUInt16BE(bytes.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(bytes.length), 2);
  return Buffer.concat([header, bytes]);
}
const jsonFrame = value => serverFrame(1, JSON.stringify(value));

async function fixture(t, options = {}) {
  const connections = [], requests = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const connection = { socket, messages: [], frames: [], buffer: Buffer.alloc(0) }; connections.push(connection);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      while (connection.buffer.length >= 2) {
        const bytes = connection.buffer, opcode = bytes[0] & 15;
        assert.ok(bytes[0] & 0x80); assert.ok(bytes[1] & 0x80, 'client frames must be masked');
        let length = bytes[1] & 127, offset = 2;
        if (length === 126) { if (bytes.length < 4) return; length = bytes.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (bytes.length < 10) return; length = Number(bytes.readBigUInt64BE(2)); offset = 10; }
        if (bytes.length < offset + 4 + length) return;
        const payload = Buffer.alloc(length), mask = bytes.subarray(offset, offset + 4);
        for (let i = 0; i < length; i++) payload[i] = bytes[offset + 4 + i] ^ mask[i % 4];
        connection.buffer = bytes.subarray(offset + 4 + length); connection.frames.push({ opcode, payload });
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString('utf8')); connection.messages.push(message);
        if (message.method === 'initialize') socket.write(jsonFrame({ id: message.id, result: { userAgent: `Codex Desktop/${options.version || '0.165.0'} (fixture)` } }));
        else if (message.method === 'account/read') socket.write(jsonFrame({ id: message.id, result: { account: { type: options.accountType || 'chatgpt' } } }));
        else options.onMessage?.(message, connection);
      }
    });
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${options.badAccept ? 'not-the-accept' : accept}\r\n${options.extraHeaders || ''}\r\n`);
    if (options.head) socket.write(options.head);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = opts => {
    requests.push(opts);
    assert.equal(opts.socketPath, config.sharedDaemonSocket); assert.equal(opts.path, '/'); assert.equal(opts.headers.Host, 'localhost');
    const { socketPath, ...rest } = opts;
    return httpRequest({ ...rest, hostname: '127.0.0.1', port: server.address().port });
  };
  t.after(async () => { for (const connection of connections) connection.socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const client = extra => {
    const rpc = new SharedRpcClient(config, { request, timeoutMs: 1000, handshakeTimeoutMs: 1000, maxMessageBytes: 2 * 1024 * 1024, ...extra });
    t.after(() => rpc.close()); return rpc;
  };
  return { server, connections, requests, client };
}

test('shared RPC validates a real WebSocket handshake and initializes only its existing ChatGPT connection', async t => {
  const f = await fixture(t, { onMessage(message, { socket }) { if (message.id) socket.write(jsonFrame({ id: message.id, result: { data: [] } })); } });
  const rpc = f.client(); await rpc.start();
  assert.equal(rpc.connected, true); assert.equal(rpc.ended, false);
  assert.equal(f.requests.length, 1); assert.deepEqual(Object.keys(f.requests[0].headers).sort(), ['Connection', 'Host', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Upgrade']);
  assert.deepEqual(f.connections[0].messages.map(message => message.method), ['initialize', 'initialized', 'account/read']);
  assert.deepEqual(f.connections[0].messages[0].params.capabilities, { experimentalApi: true });
  assert.deepEqual(f.connections[0].messages[2].params, { refreshToken: false });
  for (const method of ['thread/loaded/list', 'thread/unsubscribe', 'turn/steer', 'project/list', 'project/read', 'project/create', 'project/update', 'thread/archive']) assert.deepEqual(await rpc.call(method, {}), { data: [] });
  assert.throws(() => rpc.call('process/kill', {}), { code: 'method_forbidden' });
  assert.equal(f.connections[0].messages.some(message => /model|provider/.test(JSON.stringify(message.params))), false);
});

test('fragmented UTF-8, partial headers, coalesced frames, ping, and long frames preserve RPC messages', async t => {
  const f = await fixture(t, { onMessage(message, { socket }) { if (message.id) socket.write(jsonFrame({ id: message.id, result: message.params })); } });
  const rpc = f.client(); await rpc.start();
  const notifications = []; rpc.on('notification', value => notifications.push(value));
  const a = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '中文片段' } }));
  const split = a.indexOf(Buffer.from('中')) + 1;
  const data = Buffer.concat([serverFrame(1, a.subarray(0, split), false), serverFrame(9, 'ping'), serverFrame(0, a.subarray(split)), jsonFrame({ method: 'turn/completed', params: { threadId: 'fixture' } })]);
  const socket = f.connections[0].socket;
  socket.write(data.subarray(0, 1)); socket.write(data.subarray(1, 7)); socket.write(data.subarray(7));
  for (let i = 0; i < 20 && notifications.length < 2; i++) await nextTick();
  assert.equal(notifications.length, 2); assert.equal(notifications[0].params.delta, '中文片段');
  assert.deepEqual(notifications[1], { method: 'turn/completed', params: { threadId: 'fixture' } });
  for (const size of [126, 70000]) assert.deepEqual(await rpc.call('thread/read', { fixtureText: 'x'.repeat(size) }), { fixtureText: 'x'.repeat(size) });
  assert.equal(f.connections[0].frames.some(({ opcode, payload }) => opcode === 10 && payload.toString() === 'ping'), true);
});

test('WebSocket data received with the HTTP upgrade is delivered before initialization completes', async t => {
  const f = await fixture(t, { head: jsonFrame({ method: 'server/ready', params: {} }) }), rpc = f.client();
  const notifications = []; rpc.on('notification', value => notifications.push(value)); await rpc.start();
  assert.deepEqual(notifications, [{ method: 'server/ready', params: {} }]);
  assert.equal(rpc.connected, true);
});

test('disconnect rejects pending writes once; explicit reconnect never replays them or stops other clients', async t => {
  let accepted; const submitted = new Promise(resolve => { accepted = resolve; });
  const f = await fixture(t, { onMessage(message, { socket }) { if (message.method === 'turn/start') accepted(); else if (message.method === 'thread/list') socket.write(jsonFrame({ id: message.id, result: { data: [] } })); } });
  const rpc = f.client(), other = f.client(); await rpc.start(); await other.start();
  let closed = 0; rpc.on('closed', () => closed++);
  const pending = assert.rejects(rpc.call('turn/start', { threadId: 'fixture', input: [] }), { code: 'disconnected' });
  await submitted; f.connections[0].socket.destroy(); await pending;
  assert.equal(rpc.connected, false); assert.equal(rpc.ended, true); assert.equal(closed, 1);
  assert.ok(['disconnected', 'shared_transport_error'].includes(rpc.closeReason.code));
  if (rpc.closeReason.transportCode) assert.equal(rpc.closeReason.transportCode, 'ECONNRESET');
  await assert.rejects(rpc.call('turn/start', {}), { code: 'disconnected' });
  await rpc.start(); assert.equal(rpc.connected, true); assert.equal(f.connections.length, 3);
  assert.equal(f.connections.flatMap(connection => connection.messages).filter(message => message.method === 'turn/start').length, 1);
  rpc.close(); rpc.close(); assert.equal(closed, 2); assert.equal(f.server.listening, true);
  assert.deepEqual(await other.call('thread/list', {}), { data: [] }); assert.equal(other.connected, true);
});

test('approval and resolution ids match within a generation and cannot answer across reconnects', async t => {
  const f = await fixture(t), rpc = f.client(); await rpc.start();
  const native = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture', turnId: 'turn', itemId: 'item' } };
  const approval = once(rpc, 'approval'); f.connections[0].socket.write(jsonFrame(native));
  const [message] = await approval; assert.match(message.id, /^shared-/); assert.notEqual(message.id, '7');
  const resolved = once(rpc, 'notification'); f.connections[0].socket.write(jsonFrame({ method: 'serverRequest/resolved', params: { requestId: 7, threadId: 'fixture' } }));
  assert.equal((await resolved)[0].params.requestId, message.id);
  assert.throws(() => rpc.answer(message.id, { decision: 'accept' }), { code: 'approval_unavailable' });
  rpc.close(); await rpc.start();
  const nextApproval = once(rpc, 'approval'); f.connections[1].socket.write(jsonFrame(native)); const [nextMessage] = await nextApproval;
  assert.notEqual(nextMessage.id, message.id); assert.throws(() => rpc.answer(message.id, { decision: 'accept' }), { code: 'approval_unavailable' });
  rpc.answer(nextMessage.id, { decision: 'decline' });
  for (let i = 0; i < 20 && f.connections[1].messages.length < 4; i++) await nextTick();
  assert.deepEqual(f.connections[1].messages.at(-1), { id: 7, result: { decision: 'decline' } });
  assert.throws(() => rpc.answer(nextMessage.id, { decision: 'accept' }), { code: 'approval_unavailable' });
});

test('unknown server requests remain available to official clients without an automatic answer', async t => {
  const f = await fixture(t), rpc = f.client(); await rpc.start();
  const unsupported = once(rpc, 'unsupported');
  f.connections[0].socket.write(jsonFrame({ id: 'server-request', method: 'future/request', params: { threadId: 'fixture', secret: 'PRIVATE_FIXTURE_PAYLOAD' } }));
  const [event] = await unsupported;
  assert.deepEqual(Object.keys(event).sort(), ['method', 'requestId', 'threadId']); assert.equal(event.method, 'future/request');
  assert.equal(JSON.stringify(event).includes('PRIVATE_FIXTURE_PAYLOAD'), false);
  await nextTick(); assert.deepEqual(f.connections[0].messages.map(message => message.method), ['initialize', 'initialized', 'account/read']); assert.equal(rpc.connected, true);
});

test('native user input keeps its answer schema and uses connection-scoped request ids', async t => {
  const f = await fixture(t), rpc = f.client(); await rpc.start();
  const question = { id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: 'fixture', turnId: 'turn', itemId: 'item', questions: [{ id: 'choice', header: '选择', question: '选哪个？', options: [{ label: 'A', description: 'Option A' }] }] } };
  const input = once(rpc, 'userInput'); f.connections[0].socket.write(jsonFrame(question)); const [event] = await input;
  assert.notEqual(event.id, question.id); assert.deepEqual(event.params, question.params);
  const result = { answers: { choice: { answers: ['A'] } } }; rpc.answer(event.id, result);
  for (let i = 0; i < 20 && f.connections[0].messages.length < 4; i++) await nextTick();
  assert.deepEqual(f.connections[0].messages.at(-1), { id: 'q1', result });
  const resolved = once(rpc, 'notification'); f.connections[0].socket.write(jsonFrame({ method: 'serverRequest/resolved', params: { requestId: 'q1', threadId: 'fixture' } }));
  assert.equal((await resolved)[0].params.requestId, event.id);
});

test('RPC errors retain machine codes but omit upstream text and data', async t => {
  const f = await fixture(t, { onMessage(message, { socket }) { if (message.id) socket.write(jsonFrame({ id: message.id, error: { code: -32001, message: '/private/path TOKEN=PRIVATE_FIXTURE', data: { secret: 'PRIVATE_FIXTURE' } } })); } });
  const rpc = f.client(); await rpc.start();
  await assert.rejects(rpc.call('thread/read', {}), error => { assert.equal(error.code, 'upstream_error'); assert.equal(error.upstreamCode, -32001); assert.equal(error.status, 502); assert.equal(JSON.stringify(error).includes('PRIVATE_FIXTURE'), false); assert.equal(error.message.includes('/private/path'), false); return true; });
  assert.equal(rpc.connected, true);
});

test('timeouts do not resend, and late responses cannot settle a newer call', async t => {
  let first;
  const f = await fixture(t, { onMessage(message, { socket }) { if (message.method === 'turn/steer') first = message.id; else if (message.method === 'thread/read') socket.write(Buffer.concat([jsonFrame({ id: first, result: 'late' }), jsonFrame({ id: message.id, result: 'current' })])); } });
  const rpc = f.client({ timeoutMs: 25 }); await rpc.start();
  await assert.rejects(rpc.call('turn/steer', {}), { code: 'rpc_timeout' });
  assert.equal(await rpc.call('thread/read', {}), 'current');
  assert.equal(f.connections[0].messages.filter(message => message.method === 'turn/steer').length, 1);
});

test('bad accept values and unrequested extensions fail the handshake without leaking response headers', async t => {
  for (const options of [{ badAccept: true }, { extraHeaders: 'Sec-WebSocket-Extensions: permessage-deflate; PRIVATE_FIXTURE\r\n' }]) {
    const f = await fixture(t, options), rpc = f.client();
    await assert.rejects(rpc.start(), error => error.code === 'shared_protocol_error' && !error.message.includes('PRIVATE_FIXTURE'));
    assert.equal(rpc.connected, false); assert.deepEqual(rpc.closeReason, { code: 'shared_protocol_error' }); assert.deepEqual(f.connections[0].messages, []);
  }
});

test('startup version and login gates only disconnect this client', async t => {
  for (const [options, code, methods] of [[{ version: '0.166.0' }, 'protocol_mismatch', ['initialize']], [{ accountType: 'apiKey' }, 'chatgpt_login_required', ['initialize', 'initialized', 'account/read']]]) {
    const f = await fixture(t, options), rpc = f.client();
    await assert.rejects(rpc.start(), { code }); assert.equal(rpc.ended, true); assert.equal(f.server.listening, true); assert.deepEqual(rpc.closeReason, { code });
    assert.deepEqual(f.connections[0].messages.map(message => message.method), methods);
  }
});

test('malformed, masked, binary, fragmented-control, invalid UTF-8, and oversized frames disconnect safely', async t => {
  const oversized = Buffer.alloc(10); oversized[0] = 0x81; oversized[1] = 127; oversized.writeBigUInt64BE(4n * 1024n * 1024n, 2);
  const masked = Buffer.from([0x81, 0x80, 0, 0, 0, 0]);
  const fragmentedOversize = Buffer.concat([serverFrame(1, 'x'.repeat(1100000), false), serverFrame(0, 'x'.repeat(1100000))]);
  const tooManyFragments = Buffer.concat([serverFrame(1, '', false), ...Array.from({ length: 4096 }, () => serverFrame(0, '', false))]);
  for (const bytes of [serverFrame(1, 'not json'), masked, serverFrame(2, 'binary'), serverFrame(9, 'ping', false), serverFrame(0, 'orphan'), serverFrame(1, Buffer.from([0xc3, 0x28])), oversized, fragmentedOversize, tooManyFragments]) {
    const f = await fixture(t), rpc = f.client(); await rpc.start(); const closed = once(rpc, 'closed'); f.connections[0].socket.write(bytes); await closed;
    assert.equal(rpc.ended, true); assert.deepEqual(rpc.closeReason, { code: 'shared_protocol_error' });
  }
});

test('connection errors and handshake cancellation expose only fixed diagnostics', async () => {
  const { EventEmitter } = await import('node:events');
  let requests = 0;
  const request = () => {
    requests++;
    const req = new EventEmitter(); req.end = () => queueMicrotask(() => req.emit('error', Object.assign(Error('PRIVATE_FIXTURE_PATH_TOKEN'), { code: 'EACCES', path: '/private/token' }))); req.destroy = () => {};
    return req;
  };
  const rpc = new SharedRpcClient(config, { request });
  await assert.rejects(rpc.start(), error => error.code === 'shared_transport_error' && !error.message.includes('PRIVATE_FIXTURE'));
  assert.deepEqual(rpc.closeReason, { code: 'shared_transport_error', transportCode: 'EACCES' }); assert.equal(requests, 1);
  for (const path of [undefined, 'relative.sock', '/bad\0socket', '/bad\nsocket']) {
    await assert.rejects(new SharedRpcClient({ sharedDaemonSocket: path }, { request }).start(), { code: 'configuration' });
  }
  assert.equal(requests, 1);
  let destroyed = 0;
  const neverUpgrades = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed++; }; return req; };
  const cancelled = new SharedRpcClient(config, { request: neverUpgrades });
  const starting = assert.rejects(cancelled.start(), { code: 'disconnected' }); cancelled.close(); await starting;
  assert.equal(cancelled.ended, true); assert.equal(destroyed, 1); assert.deepEqual(cancelled.closeReason, { code: 'disconnected' });
});
