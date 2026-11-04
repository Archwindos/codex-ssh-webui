import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRelay, validateConfig } from '../src/server.mjs';

const config = { accessMode: 'ssh-loopback-http', transport: 'local', temporaryTerminal: true, remoteCodex: '/opt/codex/bin/codex', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true }, projects: [{ id: 'acceptance', name: 'Acceptance', cwd: '/isolated/acceptance' }] };
const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_DEPLOY_12345678901234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
const localOrigin = 'http://127.0.0.1:59119';
const encode = value => Buffer.from(value).toString('base64');
const flush = () => new Promise(resolve => setImmediate(resolve));
const fakeId = 'A'.repeat(32);

class FixtureRpc extends EventEmitter {
  connected = false; ended = false; calls = []; starts = 0; answers = [];
  async start() { this.starts++; throw new Error('Terminal HTTP must not start the Codex app-server'); }
  async call(method, params) { this.calls.push({ method, params }); throw new Error('Terminal HTTP must not call Codex RPC'); }
  answer(id, result) { this.answers.push({ id, result }); }
  close() {}
}

async function fixture(t, { backendReady = Promise.resolve(), ...options } = {}) {
  let now = 1000, session;
  const rpc = new FixtureRpc(), backends = [], backendCreated = Promise.withResolvers(), observed = [];
  const relay = await createRelay({ mock: false, port: 0, config, env, rpc, maintenanceMs: 60000, clock: () => now,
    terminalBackendFactory: callbacks => {
      const backend = { ...callbacks, ready: backendReady, writes: [], sizes: [], closed: 0,
        write(bytes) { this.writes.push(Buffer.from(bytes)); }, resize(size) { this.sizes.push(size); },
        close() { this.closed++; this.onExit(null, 'closed'); } };
      backends.push(backend); backendCreated.resolve(backend); return backend;
    }, ...options });
  relay.server.on('request', req => {
    const index = observed.findIndex(entry => entry.path === req.url && entry.method === req.method);
    if (index !== -1) observed.splice(index, 1)[0].resolve();
  });
  t.after(async () => {
    await relay.close();
    assert.equal(rpc.starts, 0); assert.deepEqual(rpc.calls, []); assert.deepEqual(rpc.answers, []);
  });
  const request = (path, body, overrides = {}, method = body === undefined ? 'GET' : 'POST') => {
    const started = Promise.withResolvers(); observed.push({ path, method, resolve: started.resolve });
    const result = new Promise((resolve, reject) => {
      const headers = Object.fromEntries(Object.entries({ Host: new URL(localOrigin).host, 'X-Relay-Origin': localOrigin,
        ...(session ? { Authorization: `Bearer ${session.sessionToken}` } : {}),
        ...(body === undefined ? {} : { Origin: localOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }), ...overrides }).filter(([, value]) => value !== undefined));
      const req = http.request(relay.origin, { path, method, headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => {
          const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
          try { resolve({ status: res.statusCode, headers: res.headers, bytes, text, data: text && /^application\/json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : null }); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return Object.assign(result, { started: started.promise });
  };
  const bootstrap = async () => { const result = await request('/api/session'); session = result.data; return result; };
  const login = async () => { if (!session) await bootstrap(); const result = await request('/api/login', { secret: env.RELAY_ACCESS_SECRET }); session = result.data; return result; };
  return { relay, rpc, backends, backendCreated: backendCreated.promise, request, bootstrap, login, advance: ms => { now += ms; }, session: () => session, useSession: value => { session = value; } };
}

test('temporary terminals are opt-in, local-only and unavailable when the configuration omits or disables them', async t => {
  assert.equal(validateConfig(config, false, env), config);
  for (const changes of [{ temporaryTerminal: null }, { temporaryTerminal: 'true' }, { temporaryTerminal: 1 }, { transport: 'ssh', sshTarget: 'codex-server' }, { transport: undefined }, { accessMode: 'https', publicOrigin: 'https://relay.test.example' }]) {
    assert.throws(() => validateConfig({ ...config, ...changes }, false, env), { code: 'terminal_configuration' });
  }
  for (const temporaryTerminal of [undefined, false]) {
    const f = await fixture(t, { config: { ...config, temporaryTerminal } }); await f.login();
    assert.equal(f.session().capabilities.terminal, false);
    for (const [path, body] of [['/api/terminal', {}], [`/api/terminal/${fakeId}`, undefined], [`/api/terminal/${fakeId}/input`, { data: encode('x') }]]) {
      const denied = await f.request(path, body); assert.equal(denied.status, 503); assert.equal(denied.data.error.code, 'terminal_unavailable');
    }
    assert.equal(f.backends.length, 0);
  }
});

test('anonymous requests cannot create, read or control terminals or advertise terminal access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/terminal', {})).status, 401);
  await f.bootstrap(); assert.equal(f.session().authenticated, false); assert.equal(f.session().capabilities.terminal, false);
  for (const [path, body] of [['/api/terminal', {}], [`/api/terminal/${fakeId}`, undefined], [`/api/terminal/${fakeId}/input`, { data: encode('x') }], [`/api/terminal/${fakeId}/resize`, { cols: 80, rows: 24 }], [`/api/terminal/${fakeId}/heartbeat`, {}], [`/api/terminal/${fakeId}/close`, {}]]) {
    assert.equal((await f.request(path, body)).status, 401, path);
  }
  assert.equal(f.backends.length, 0);
});

test('every terminal mutation retains Origin and CSRF checks and reads require the exact relay origin', async t => {
  const f = await fixture(t); await f.login();
  assert.equal(f.session().capabilities.terminal, true);
  const created = await f.request('/api/terminal', {}); assert.equal(created.status, 201); const id = created.data.id;
  for (const [path, body] of [['/api/terminal', {}], [`/api/terminal/${id}/input`, { data: encode('x') }], [`/api/terminal/${id}/resize`, { cols: 100, rows: 30 }], [`/api/terminal/${id}/heartbeat`, {}], [`/api/terminal/${id}/close`, {}]]) {
    for (const overrides of [{ Origin: undefined }, { Origin: 'https://attacker.example' }, { 'X-CSRF-Token': undefined }, { 'X-CSRF-Token': 'wrong' }, { 'X-Relay-Origin': undefined }]) {
      assert.equal((await f.request(path, body, overrides)).status, 403, `${path} ${JSON.stringify(overrides)}`);
    }
  }
  for (const overrides of [{ 'X-Relay-Origin': undefined }, { Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'localhost:59119' }]) {
    assert.equal((await f.request(`/api/terminal/${id}`, undefined, overrides)).status, 403);
  }
  assert.equal(f.backends.length, 1); assert.deepEqual(f.backends[0].writes, []); assert.deepEqual(f.backends[0].sizes, []); assert.equal(f.backends[0].closed, 0);
});

test('terminal identities are bound to the authenticated browser session for every operation', async t => {
  const f = await fixture(t); await f.login(); const firstSession = f.session();
  const first = (await f.request('/api/terminal', {})).data;
  f.useSession(null); await f.login(); const secondSession = f.session();
  assert.notEqual(secondSession.sessionToken, firstSession.sessionToken);
  for (const [path, body] of [[`/api/terminal/${first.id}`, undefined], [`/api/terminal/${first.id}/input`, { data: encode('x') }], [`/api/terminal/${first.id}/resize`, { cols: 100, rows: 30 }], [`/api/terminal/${first.id}/heartbeat`, {}], [`/api/terminal/${first.id}/close`, {}]]) {
    const denied = await f.request(path, body); assert.equal(denied.status, 404, path); assert.equal(denied.data.error.code, 'terminal_missing');
  }
  assert.deepEqual(f.backends[0].writes, []); assert.deepEqual(f.backends[0].sizes, []); assert.equal(f.backends[0].closed, 0);
  const second = await f.request('/api/terminal', {}); assert.equal(second.status, 201); assert.notEqual(second.data.id, first.id);
  assert.equal((await f.request(`/api/terminal/${second.data.id}/input`, { data: encode('own input') })).status, 200);
  assert.deepEqual(f.backends[1].writes, [Buffer.from('own input')]); assert.deepEqual(f.backends[0].writes, []);
  f.useSession(firstSession); assert.equal((await f.request(`/api/terminal/${first.id}/heartbeat`, {})).status, 200);
});

test('terminal HTTP creates at root, preserves input/output bytes, resizes and closes without any Codex calls', async t => {
  const f = await fixture(t); await f.login();
  const created = await f.request('/api/terminal', { cols: 100, rows: 30 }); assert.equal(created.status, 201);
  const terminal = created.data, backend = f.backends[0];
  assert.match(terminal.id, /^[A-Za-z0-9_-]{32}$/); assert.equal(terminal.cwd, '/'); assert.equal(terminal.cols, 100); assert.equal(terminal.rows, 30); assert.equal(terminal.cursor, 0); assert.equal(terminal.closed, false);
  assert.equal(backend.cols, 100); assert.equal(backend.rows, 30);
  assert.equal((await f.request('/api/terminal', {})).status, 409); assert.equal(f.backends.length, 1);
  const input = Buffer.from([3, 9, 27, 91, 65, 0xff]);
  assert.deepEqual((await f.request(`/api/terminal/${terminal.id}/input`, { data: encode(input) })).data, { accepted: true }); assert.deepEqual(backend.writes, [input]);
  assert.deepEqual((await f.request(`/api/terminal/${terminal.id}/resize`, { cols: 132, rows: 40 })).data, { cols: 132, rows: 40 }); assert.deepEqual(backend.sizes, [{ cols: 132, rows: 40 }]);
  assert.deepEqual((await f.request(`/api/terminal/${terminal.id}/heartbeat`, {})).data, { closed: false });
  const output = Buffer.from('\x1b[31mhello 🙂\x1b[0m\r\n'); backend.onOutput(output);
  const page = await f.request(`/api/terminal/${terminal.id}?cursor=0`); assert.equal(page.status, 200); assert.deepEqual(Buffer.from(page.data.data, 'base64'), output); assert.equal(page.data.cursor, output.length); assert.equal(page.data.closed, false); assert.equal(page.data.hasMore, false);
  const replay = await f.request(`/api/terminal/${terminal.id}?cursor=0`); assert.deepEqual(replay.data, page.data); assert.equal(backend.writes.length, 1, 'polling does not replay input');
  for (const [path, body] of [['/api/terminal', { cwd: '/tmp' }], ['/api/terminal', { command: 'must not execute' }], ['/api/terminal', { env: { SECRET: 'must not execute' } }], [`/api/terminal/${terminal.id}/input`, { data: 'Zh==' }], [`/api/terminal/${terminal.id}/input`, { data: encode('x'), command: 'must not execute' }], [`/api/terminal/${terminal.id}/resize`, { cols: 0, rows: 24 }], [`/api/terminal/${terminal.id}/resize`, { cols: 80, rows: 24, cwd: '/tmp' }], [`/api/terminal/${terminal.id}/close`, { id: terminal.id }]]) {
    assert.equal((await f.request(path, body)).status, 400, path);
  }
  for (const path of [`/api/terminal/${terminal.id}?cursor=-1`, `/api/terminal/${terminal.id}?cursor=${output.length + 1}`, `/api/terminal/${terminal.id}?cursor=0&cursor=0`, `/api/terminal/${terminal.id}?wait=0`, `/api/terminal/${terminal.id}/input?cursor=0`]) assert.equal((await f.request(path)).status, 400, path);
  assert.equal(backend.writes.length, 1); assert.equal(backend.sizes.length, 1); assert.equal(backend.closed, 0);
  assert.deepEqual((await f.request(`/api/terminal/${terminal.id}/close`, {})).data, { closed: true }); assert.equal(backend.closed, 1);
  assert.equal((await f.request(`/api/terminal/${terminal.id}/close`, {})).status, 200); assert.equal(backend.closed, 1);
  const closed = await f.request(`/api/terminal/${terminal.id}?cursor=${page.data.cursor}`); assert.equal(closed.status, 200); assert.equal(closed.data.closed, true); assert.equal(closed.data.data, '');
  assert.equal((await f.request(`/api/terminal/${terminal.id}/input`, { data: encode('late') })).status, 409); assert.equal(backend.writes.length, 1);
  const reopened = await f.request('/api/terminal', {}); assert.equal(reopened.status, 201); assert.notEqual(reopened.data.id, terminal.id); assert.equal(f.backends.length, 2);
});

for (const invalidation of ['logout', 'expiry']) {
  test(`${invalidation} while terminal startup is pending closes the eventual helper and refuses its identity`, { timeout: 3000 }, async t => {
    const ready = Promise.withResolvers(); t.after(() => ready.resolve());
    const f = await fixture(t, { backendReady: ready.promise, sessionTtlMs: 50, idleTtlMs: 1000 }); await f.login();
    const pending = f.request('/api/terminal', { cols: 100, rows: 30 }); const backend = await f.backendCreated;
    if (invalidation === 'logout') { assert.equal((await f.request('/api/logout', {})).status, 200); assert.equal(backend.closed, 1); }
    else f.advance(51);
    ready.resolve(); const denied = await pending;
    assert.equal(denied.status, 401); assert.equal(denied.data.error.code, 'session_required'); assert.equal(denied.data.id, undefined); assert.equal(backend.closed, 1);
    assert.equal((await f.request('/api/terminal', {})).status, 401); assert.equal(f.backends.length, 1); assert.deepEqual(backend.writes, []);
  });

  test(`${invalidation} during terminal long polling returns no buffered shell output and closes only that session's helper`, { timeout: 3000 }, async t => {
    const f = await fixture(t, { sessionTtlMs: 50, idleTtlMs: 1000 }); await f.login(); const owner = f.session();
    const terminal = (await f.request('/api/terminal', {})).data, backend = f.backends[0];
    f.advance(25); f.useSession(null); await f.login(); const otherOwner = f.session(), other = (await f.request('/api/terminal', {})).data;
    f.useSession(owner);
    const pending = f.request(`/api/terminal/${terminal.id}?cursor=0`); await pending.started; await flush();
    const duplicate = await f.request(`/api/terminal/${terminal.id}?cursor=0`); assert.equal(duplicate.status, 429); assert.equal(duplicate.data.error.code, 'terminal_poll_busy');
    if (invalidation === 'logout') assert.equal((await f.request('/api/logout', {})).status, 200);
    else f.advance(26);
    backend.onOutput(Buffer.from('PRIVATE_SHELL_OUTPUT_AFTER_AUTHORIZATION_LOSS'));
    const denied = await pending; assert.equal(denied.status, 401); assert.equal(denied.data.error.code, 'session_required'); assert.equal(denied.data.data, undefined); assert.doesNotMatch(denied.text, /PRIVATE_SHELL_OUTPUT/); assert.equal(backend.closed, 1);
    assert.equal(f.backends[1].closed, 0, 'another session is not closed by invalidating this request');
    if (invalidation === 'logout') assert.equal(f.relay.state.sessions.has(owner.sessionToken), false);
    f.useSession(otherOwner); assert.equal((await f.request(`/api/terminal/${other.id}/heartbeat`, {})).status, 200);
    assert.notEqual(other.id, terminal.id);
  });
}

test('terminal assets use an exact static whitelist and each index response binds a fresh style nonce in CSP and meta', async t => {
  const f = await fixture(t);
  const nonces = [];
  for (const path of ['/', '/index.html']) {
    const page = await f.request(path); assert.equal(page.status, 200); assert.match(page.headers['content-type'], /^text\/html/);
    const match = /<meta name="terminal-style-nonce" content="([A-Za-z0-9_-]{43})">/.exec(page.text); assert.ok(match); const nonce = match[1]; nonces.push(nonce);
    assert.ok(page.headers['content-security-policy'].includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.match(page.headers['content-security-policy'], /script-src 'self';/); assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline|unsafe-eval/); assert.equal(page.headers['cache-control'], 'no-store'); assert.equal(page.headers['set-cookie'], undefined);
  }
  assert.notEqual(nonces[0], nonces[1]);
  for (const path of ['/app.js', '/style.css', '/terminal.js', '/terminal.css', '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/xterm-addon-fit.js']) {
    const asset = await f.request(path); assert.equal(asset.status, 200, path); assert.deepEqual(asset.bytes, await readFile(new URL(`../public${path}`, import.meta.url)));
    assert.match(asset.headers['content-type'], path.endsWith('.css') ? /^text\/css/ : /^text\/javascript/); assert.equal(asset.headers['x-content-type-options'], 'nosniff'); assert.equal(asset.headers['cache-control'], 'no-store'); assert.doesNotMatch(asset.headers['content-security-policy'], /nonce-|unsafe-inline|unsafe-eval/);
  }
  const head = await f.request('/vendor/xterm.js', undefined, {}, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.text, '');
  for (const path of ['/src/server.mjs', '/scripts/terminal-pty.py', '/vendor/xterm-LICENSE.txt', '/vendor/xterm-vendor.json', '/vendor/xterm.js.map', '/vendor/xterm-addon-fit.js.map', '/terminal.js.map', '/vendor/xterm.js/extra', '/vendor/%78term.js', '/vendor/../vendor/xterm-vendor.json']) assert.equal((await f.request(path)).status, 404, path);
  assert.equal(f.relay.state.sessions.size, 0); assert.equal(f.backends.length, 0);
});
