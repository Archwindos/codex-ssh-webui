import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { appFixtureSource } from './ui-source-fixture.mjs';
import { createRelay, validateConfig } from '../src/server.mjs';

const config = { accessMode: 'ssh-loopback-http', transport: 'local', remoteCodex: '/opt/codex/bin/codex', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true }, projects: [{ id: 'acceptance', name: 'Acceptance', cwd: '/isolated/acceptance' }] };
const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_DEPLOY_12345678901234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
const localOrigin = 'http://127.0.0.1:59119';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await delay(5); } assert.fail('Fixture timed out'); }
class FixtureRpc extends EventEmitter {
  connected = false; ended = false; calls = []; answers = [];
  async start() { this.connected = true; }
  close() { this.connected = false; }
  answer(id, result) { this.answers.push({ id, result }); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/list') return { data: [], nextCursor: null };
    throw new Error(`Unexpected fixture method ${method}`);
  }
}
async function fixture(t, options = {}) {
  const rpc = new FixtureRpc();
  const relay = await createRelay({ mock: false, port: 0, config, env, rpc, ...options }); t.after(() => relay.close());
  let session;
  const request = (path, body, overrides = {}, method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(Object.entries({ Host: new URL(localOrigin).host, 'X-Relay-Origin': localOrigin, ...(session ? { Authorization: `Bearer ${session.sessionToken}` } : {}), ...(body === undefined ? {} : { Origin: localOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '' }), ...overrides }).filter(([, value]) => value !== undefined));
    const req = http.request(relay.origin, { path, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const bootstrap = async () => { const result = await request('/api/session'); session = result.data; return result; };
  const login = async () => { if (!session) await bootstrap(); const result = await request('/api/login', { secret: env.RELAY_ACCESS_SECRET }); session = result.data; return result; };
  return { relay, rpc, request, bootstrap, login, session: () => session, useSession: value => { session = value; } };
}

async function browserIdentity() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64url');
  return { publicKey, sign: async message => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(message))).toString('base64url') };
}
const deviceOptions = { deviceAuthentication: true, deviceStoreFile: null, devicePairingsDir: null };
async function proveDevice(f, identity, input) {
  const challenge = await f.request('/api/device/challenge', input); assert.equal(challenge.status, 200);
  const result = await f.request('/api/device/verify', { challengeId: challenge.data.challengeId, signature: await identity.sign(challenge.data.message) });
  if (result.status === 200) f.useSession(result.data);
  return { challenge, result };
}

test('trusted-browser enrollment rotates credentials; a fresh browser session signs in without a password', async t => {
  const f = await fixture(t, deviceOptions); await f.login(); const old = f.session(), identity = await browserIdentity();
  const enrolled = await proveDevice(f, identity, { publicKey: identity.publicKey, label: 'My phone' });
  assert.equal(enrolled.result.status, 200); const trusted = enrolled.result.data;
  assert.equal(trusted.authenticated, true); assert.equal(trusted.capabilities.deviceAuthentication, true); assert.ok(trusted.trustedDevice.id);
  assert.notEqual(trusted.sessionToken, old.sessionToken); assert.notEqual(trusted.csrf, old.csrf);
  assert.equal((await f.request('/api/devices', undefined, { Authorization: `Bearer ${old.sessionToken}` })).status, 401);
  const listed = await f.request('/api/devices'); assert.equal(listed.data.devices.length, 1); assert.equal(listed.data.devices[0].publicKey, undefined);
  await f.request('/api/logout', {}); f.useSession(null); const anonymous = await f.bootstrap(); assert.equal(anonymous.data.authenticated, false);
  const login = await proveDevice(f, identity, { deviceId: trusted.trustedDevice.id });
  assert.equal(login.result.data.authenticated, true); assert.equal(login.result.data.trustedDevice.id, trusted.trustedDevice.id);
  assert.equal((await f.request('/api/threads?project=acceptance')).status, 200);
});
test('an unrecognized browser cannot enroll itself, list trusted devices, or forge authentication flags', async t => {
  const f = await fixture(t, deviceOptions); await f.bootstrap(); const identity = await browserIdentity();
  assert.equal((await f.request('/api/devices')).status, 401);
  assert.equal((await f.request('/api/device/challenge', { publicKey: identity.publicKey, label: 'Other browser' })).status, 401);
  assert.equal((await f.request('/api/device/challenge', { publicKey: identity.publicKey, label: 'Other', authenticated: true })).status, 400);
  assert.equal((await f.request('/api/device/challenge', { deviceId: 'device-missing', publicKey: identity.publicKey })).status, 400);
  assert.equal((await f.request('/api/device/verify', { challengeId: 'missing', signature: 'bad', authenticated: true })).status, 400);
});
test('device challenges and proofs retain exact origin and CSRF checks and cannot be replayed', async t => {
  const f = await fixture(t, deviceOptions); await f.login(); const identity = await browserIdentity();
  const input = { publicKey: identity.publicKey, label: 'Phone' };
  assert.equal((await f.request('/api/device/challenge', input, { Origin: undefined })).status, 403);
  assert.equal((await f.request('/api/device/challenge', input, { 'X-CSRF-Token': 'wrong' })).status, 403);
  const challenge = await f.request('/api/device/challenge', input); const signed = { challengeId: challenge.data.challengeId, signature: await identity.sign(challenge.data.message) };
  assert.equal((await f.request('/api/device/verify', signed, { Origin: 'https://attacker.example' })).status, 403);
  const accepted = await f.request('/api/device/verify', signed); assert.equal(accepted.status, 200); f.useSession(accepted.data);
  assert.notEqual((await f.request('/api/device/verify', signed)).status, 200);
});
test('a private one-time pairing enrolls a browser without the recovery password and is consumed once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-device-pairing-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pairingToken = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(pairingToken).digest('hex'), now = Date.now();
  await writeFile(join(directory, `${tokenHash}.json`), JSON.stringify({ schemaVersion: 1, tokenHash, createdAt: now, expiresAt: now + 600000 }), { flag: 'wx', mode: 0o600 });
  const f = await fixture(t, { ...deviceOptions, devicePairingsDir: directory }); await f.bootstrap(); const identity = await browserIdentity();
  const enrolled = await proveDevice(f, identity, { publicKey: identity.publicKey, label: 'Paired phone', pairingToken });
  assert.equal(enrolled.result.status, 200); assert.equal(enrolled.result.data.authenticated, true);
  await f.request('/api/logout', {}); f.useSession(null); await f.bootstrap();
  assert.equal((await f.request('/api/device/challenge', { publicKey: identity.publicKey, label: 'Repeated', pairingToken })).status, 401);
});
test('revoking a device invalidates all its active sessions and prevents further signature login', async t => {
  const f = await fixture(t, deviceOptions); await f.login(); const identity = await browserIdentity();
  const enrolled = (await proveDevice(f, identity, { publicKey: identity.publicKey, label: 'Phone' })).result.data;
  f.useSession(null); await f.bootstrap(); const second = (await proveDevice(f, identity, { deviceId: enrolled.trustedDevice.id })).result.data;
  f.useSession(enrolled); assert.equal((await f.request('/api/devices/revoke', { deviceId: enrolled.trustedDevice.id })).status, 200);
  assert.equal((await f.request('/api/devices')).status, 401);
  f.useSession(second); assert.equal((await f.request('/api/devices')).status, 401);
  f.useSession(null); await f.bootstrap(); assert.equal((await f.request('/api/device/challenge', { deviceId: enrolled.trustedDevice.id })).status, 401);
});

test('revocation while a verification body is incomplete cannot authorize another trusted browser', async t => {
  const f = await fixture(t, deviceOptions); await f.login(); const first = await browserIdentity();
  const enrolled = (await proveDevice(f, first, { publicKey: first.publicKey, label: 'Source phone' })).result.data;
  const second = await browserIdentity();
  const challenge = await f.request('/api/device/challenge', { publicKey: second.publicKey, label: 'Pending browser' });
  assert.equal(challenge.status, 200);
  const body = JSON.stringify({ challengeId: challenge.data.challengeId, signature: await second.sign(challenge.data.message) });
  let finish;
  const result = new Promise((resolve, reject) => {
    const req = http.request(f.relay.origin, { path: '/api/device/verify', method: 'POST', headers: {
      Host: new URL(localOrigin).host, Origin: localOrigin, 'X-Relay-Origin': localOrigin,
      Authorization: `Bearer ${enrolled.sessionToken}`, 'X-CSRF-Token': enrolled.csrf,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(body.slice(0, -1)); finish = () => req.end(body.slice(-1));
  });
  await delay(20);
  assert.equal((await f.request('/api/devices/revoke', { deviceId: enrolled.trustedDevice.id })).status, 200);
  finish(); assert.equal(await result, 401);
  f.useSession(null); await f.login();
  const devices = (await f.request('/api/devices')).data.devices;
  assert.equal(devices.length, 1); assert.equal(devices[0].status, 'revoked');
});

test('SSH loopback HTTP requires an explicit mode and retains production account/protocol gates', async () => {
  assert.equal(validateConfig(config, false, env), config);
  for (const changes of [{ accessMode: 'unknown' }, { accessMode: null }, { accessMode: undefined }, { publicOrigin: localOrigin }, { publicOrigin: 'https://relay.test.example' }, { tls: {} }, { eventTransport: 'sse' }]) assert.throws(() => validateConfig({ ...config, ...changes }, false, env));
  for (const changes of [{ RELAY_ACCESS_SECRET: '' }, { RELAY_VERIFIED_PROTOCOL: '' }]) assert.throws(() => validateConfig(config, false, { ...env, ...changes }));
  assert.throws(() => validateConfig({ ...config, verifiedProtocol: { ...config.verifiedProtocol, verified: false } }, false, env));
  const httpsConfig = { ...config, accessMode: 'https', publicOrigin: 'https://relay.test.example' };
  assert.equal(validateConfig(httpsConfig, false, env), httpsConfig);
});

test('SSH loopback HTTP accepts only literal IPv4 loopback and canonical nonprivileged ports', async t => {
  const f = await fixture(t);
  for (const host of ['localhost:59119', '127.0.0.2:59119', '[::1]:59119', '127.1:59119', '2130706433:59119', '0x7f000001:59119', '127.0.0.1', '127.0.0.1:80', '127.0.0.1:1023', '127.0.0.1:65536', '127.0.0.1:059119', '127.0.0.1:59119.', '127.0.0.1:59119@evil.example']) assert.equal((await f.request('/api/session', undefined, { Host: host, 'X-Relay-Origin': `http://${host}` })).status, 403, host);
  for (const port of [1024, 59119, 65535]) { const origin = `http://127.0.0.1:${port}`; assert.equal((await f.request('/api/session', undefined, { Host: new URL(origin).host, 'X-Relay-Origin': origin })).status, 200); }
  assert.equal(f.relay.server.address().address, '127.0.0.1'); assert.equal(f.relay.origin.startsWith('http://'), true);
});

test('every HTTP API requires its exact loopback origin header and rejects protocol or origin fallbacks', async t => {
  const f = await fixture(t); await f.login();
  for (const path of ['/api/session', '/api/poll?wait=0', '/api/threads?project=acceptance', '/api/events']) {
    assert.equal((await f.request(path, undefined, { 'X-Relay-Origin': undefined })).status, 403, path);
    for (const origin of ['https://127.0.0.1:59119', 'http://127.0.0.1:59120', 'null', 'http://localhost:59119', `${localOrigin}/`]) {
      assert.equal((await f.request(path, undefined, { 'X-Relay-Origin': origin })).status, 403, origin);
      assert.equal((await f.request(path, undefined, { Origin: origin })).status, 403, origin);
    }
  }
  assert.equal((await f.request('/api/session', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('/api/login', undefined, {}, 'OPTIONS')).status, 405);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' })).status, 200);
});

test('production HTTP bootstraps an anonymous 256 bit bearer session without cookies or account calls', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/poll?wait=0')).status, 401);
  const result = await f.bootstrap();
  assert.equal(result.data.mode, 'production'); assert.equal(result.data.authenticated, false); assert.equal(result.data.authTransport, 'bearer'); assert.equal(result.data.eventTransport, 'poll');
  assert.equal(Buffer.from(result.data.sessionToken, 'base64url').length, 32); assert.equal(Buffer.from(result.data.csrf, 'base64url').length, 32); assert.notEqual(result.data.csrf, result.data.sessionToken);
  assert.deepEqual(result.data.projects, []); assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(f.rpc.calls.length, 0);
  assert.equal((await f.request('/api/poll?wait=0')).status, 401); assert.equal((await f.request('/api/threads?project=acceptance')).status, 401);
});

test('HTTP login rotates both bearer and CSRF and preserves native Origin and CSRF checks', async t => {
  const f = await fixture(t); await f.bootstrap(); const anonymous = f.session();
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET }, { Origin: undefined })).status, 403);
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/login', { secret: 'wrong' })).status, 401);
  const result = await f.login(); assert.equal(result.status, 200); assert.equal(result.data.authenticated, true); assert.equal(result.headers['set-cookie'], undefined);
  assert.notEqual(result.data.sessionToken, anonymous.sessionToken); assert.notEqual(result.data.csrf, anonymous.csrf);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Authorization: `Bearer ${anonymous.sessionToken}` })).status, 401);
  assert.equal((await f.request('/api/logout', {}, { Origin: undefined })).status, 403); assert.equal((await f.request('/api/logout', {}, { 'X-CSRF-Token': anonymous.csrf })).status, 403);
});

test('HTTP APIs never authenticate from cookies or fall back from malformed bearer headers', async t => {
  const f = await fixture(t); await f.login(); const cookie = `relay_session=${f.session().sessionToken}`;
  for (const Authorization of [undefined, 'Bearer bad', `bearer ${f.session().sessionToken}`, `Bearer ${f.session().sessionToken} extra`]) {
    assert.equal((await f.request('/api/poll?wait=0', undefined, { Cookie: cookie, Authorization })).status, 401);
  }
  const anonymous = await f.request('/api/session', undefined, { Cookie: cookie, Authorization: undefined }); assert.equal(anonymous.data.authenticated, false); assert.equal(anonymous.headers['set-cookie'], undefined);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Cookie: 'relay_session=wrong' })).status, 200);
});

test('HTTP sessions cannot be reused at another port on session, poll, login, or logout', async t => {
  const f = await fixture(t); await f.login(); const other = 'http://127.0.0.1:59120';
  for (const [path, body] of [['/api/session', undefined], ['/api/poll?wait=0', undefined], ['/api/threads?project=acceptance', undefined], ['/api/login', { secret: env.RELAY_ACCESS_SECRET }], ['/api/logout', {}]]) {
    const result = await f.request(path, body, { Host: new URL(other).host, 'X-Relay-Origin': other, ...(body === undefined ? {} : { Origin: other }) });
    assert.equal(result.status, 403, path); assert.equal(result.data.error.code, 'session_origin_rejected');
  }
  assert.equal((await f.request('/api/poll?wait=0')).status, 200); assert.equal(f.relay.state.sessions.size, 1);
});

test('HTTP does not accept URL credentials, token queries, absolute URLs, or mode overrides', async t => {
  const f = await fixture(t); await f.login();
  for (const path of ['/api/session?token=anything', '/api/session?accessMode=https', '/api/poll?wait=0&sessionToken=anything', `${localOrigin}/api/session`, 'https://127.0.0.1:59119/api/session', '//127.0.0.1:59119/api/session']) assert.equal((await f.request(path)).status, 400, path);
  const response = await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET, accessMode: 'https' }); assert.equal(response.status, 400);
});

test('HTTP polling uses bearer auth, sanitizes events, and refuses SSE', async t => {
  const f = await fixture(t); await f.login();
  f.relay.state.authorizedThreads.set('thread-1', '/isolated/acceptance');
  const pending = f.request('/api/poll?cursor=0&wait=20000'); await until(() => f.relay.state.polls.size === 1);
  f.rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '模拟🙂', private: 'MUST_NOT_LEAK' } });
  const result = await pending; assert.equal(result.status, 200); assert.equal(result.data.events[0].data.params.delta, '模拟🙂'); assert.equal(JSON.stringify(result.data).includes('MUST_NOT_LEAK'), false); assert.equal(result.headers['set-cookie'], undefined);
  const stream = await f.request('/api/events'); assert.equal(stream.status, 405); assert.equal(stream.data.error.code, 'transport_forbidden'); assert.equal(f.relay.state.streams.size, 0);
});

test('HTTP logout revokes bearer authentication and terminates pending polling without cookies', async t => {
  const f = await fixture(t); await f.login(); const prior = f.session();
  const pending = f.request('/api/poll?cursor=0&wait=20000'); await until(() => f.relay.state.polls.size === 1);
  const logout = await f.request('/api/logout', {}); assert.equal(logout.status, 200); assert.equal(logout.headers['set-cookie'], undefined);
  assert.equal((await pending).status, 401); assert.equal(f.relay.state.sessions.size, 0); assert.equal(f.relay.state.polls.size, 0);
  assert.equal((await f.request('/api/poll?wait=0', undefined, { Authorization: `Bearer ${prior.sessionToken}`, Cookie: `relay_session=${prior.sessionToken}` })).status, 401);
});

test('HTTP bearer expiry remains absolute and a valid token cannot refresh an expired session', async t => {
  let now = 1000;
  const f = await fixture(t, { clock: () => now, sessionTtlMs: 50, idleTtlMs: 1000, maintenanceMs: 5 }); await f.login(); const prior = f.session();
  const pending = f.request('/api/poll?cursor=0&wait=20000'); await until(() => f.relay.state.polls.size === 1); now = 1051;
  assert.equal((await pending).status, 401); assert.equal((await f.request('/api/poll?wait=0')).status, 401);
  const next = await f.bootstrap(); assert.equal(next.data.authenticated, false); assert.notEqual(next.data.sessionToken, prior.sessionToken);
});

async function browserFixture(t, fetcher, storage = new Map(), crypto = webcrypto) {
  const nodes = new Map(), timers = new Map(), sources = []; let timerId = 0;
  const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', children: [], dataset: {}, classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, toggleAttribute() {}, setAttribute() {}, focus() {}, querySelectorAll() { return []; }, append(...values) { this.children.push(...values); }, replaceChildren(...values) { this.children = values; } });
  const document = { visibilityState: 'visible', getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, createDocumentFragment: node, addEventListener() {} };
  const context = vm.createContext({ document, window: { addEventListener() {} }, location: { origin: localOrigin, port: '59119' }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, EventSource: class { constructor(url) { sources.push(url); } }, AbortController, fetch: fetcher, setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); }, crypto, Uint8Array });
  vm.runInContext(appFixtureSource(await readFile(new URL('../public/app.js', import.meta.url), 'utf8')), context);
  t.after(() => vm.runInContext('stopSubscription()', context));
  return { storage, sources, run: code => vm.runInContext(code, context) };
}

test('a rejected pairing keeps the anonymous session usable for recovery-password login', async t => {
  const f = await fixture(t, deviceOptions);
  const browser = await browserFixture(t, async (path, options) => {
    const result = await f.request(path, options.body === undefined ? undefined : JSON.parse(options.body), { Authorization: undefined, ...options.headers });
    return { ok: result.status < 400, status: result.status, json: async () => result.data };
  });
  await browser.run("api('/api/session').then(value => state.session = value)");
  const anonymousToken = browser.storage.get('relay-session-token'), identity = await browserIdentity();
  await assert.rejects(browser.run(`api('/api/device/challenge', ${JSON.stringify({ publicKey: identity.publicKey, label: 'Phone', pairingToken: 'p'.repeat(43) })})`), error => error.status === 401);
  assert.equal(browser.storage.get('relay-session-token'), anonymousToken);
  const logged = await browser.run(`api('/api/login', ${JSON.stringify({ secret: env.RELAY_ACCESS_SECRET })})`);
  assert.equal(logged.authenticated, true); assert.notEqual(logged.sessionToken, anonymousToken);
});

test('an unrecognized stored device and a wrong recovery password do not strand a valid local session', async t => {
  const f = await fixture(t, deviceOptions);
  const browser = await browserFixture(t, async (path, options) => {
    const result = await f.request(path, options.body === undefined ? undefined : JSON.parse(options.body), { Authorization: undefined, ...options.headers });
    return { ok: result.status < 400, status: result.status, json: async () => result.data };
  });
  await browser.run("api('/api/session').then(value => state.session = value)");
  const token = browser.storage.get('relay-session-token');
  await assert.rejects(browser.run(`api('/api/device/challenge', {deviceId:'device-${'0'.repeat(32)}'})`), error => error.code === 'device_untrusted');
  await assert.rejects(browser.run("api('/api/login', {secret:'incorrect'})"), error => error.code === 'login_failed');
  assert.equal(browser.storage.get('relay-session-token'), token);
  assert.equal((await browser.run(`api('/api/login', ${JSON.stringify({ secret: env.RELAY_ACCESS_SECRET })})`)).authenticated, true);
});

test('HTTP browser uses one bearer/header policy for session, login, APIs, polling, reload and logout', async t => {
  const f = await fixture(t), calls = [];
  const browser = await browserFixture(t, async (path, options) => {
    calls.push({ path, options });
    const result = await f.request(path, options.body === undefined ? undefined : JSON.parse(options.body), { Authorization: undefined, ...options.headers });
    return { ok: result.status < 400, status: result.status, json: async () => result.data };
  });
  await browser.run("api('/api/session').then(value => state.session = value)");
  const first = browser.storage.get('relay-session-token'); assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  await browser.run(`api('/api/login', { secret: '${env.RELAY_ACCESS_SECRET}' }).then(value => state.session = value)`);
  const logged = browser.storage.get('relay-session-token'); assert.notEqual(logged, first);
  await browser.run("api('/api/session').then(value => state.session = value)");
  browser.run("state.upstreamStatus = 'connected'; subscribe()"); await until(() => f.relay.state.polls.size === 1);
  assert.equal(browser.sources.length, 0); browser.run('stopSubscription()');
  const reload = await browserFixture(t, async (path, options) => { calls.push({ path, options }); const result = await f.request(path, undefined, options.headers); return { ok: result.status < 400, status: result.status, json: async () => result.data }; }, browser.storage);
  await reload.run("api('/api/session').then(value => state.session = value)"); assert.equal(reload.run('state.session.authenticated'), true);
  await browser.run("api('/api/logout', {})"); assert.equal(browser.storage.has('relay-session-token'), false);
  for (const { path, options } of calls) { assert.equal(options.headers['X-Relay-Origin'], localOrigin); if (path !== '/api/session' || options.headers.Authorization) assert.match(options.headers.Authorization || '', /^Bearer [A-Za-z0-9_-]{43}$/); }
  assert.equal(calls.find(call => call.path.startsWith('/api/poll')).options.credentials, 'omit');
  assert.equal(calls.find(call => call.path === '/api/login').options.credentials, 'omit');
  assert.equal([...browser.storage.values()].some(value => String(value).includes(env.RELAY_ACCESS_SECRET)), false);
});

test('browser submission IDs keep secure randomness when randomUUID is unavailable', async t => {
  let bytes = 0;
  const browser = await browserFixture(t, async () => assert.fail('No request expected'), new Map(), { getRandomValues(array) { bytes += array.length; return webcrypto.getRandomValues(array); } });
  const pageBytes = bytes;
  assert.equal(pageBytes, 16, 'the page presence id consumes one secure 16-byte allocation');
  assert.match(browser.run('runtimePresence.clientId'), /^[a-f0-9]{32}$/);
  const ids = new Set(Array.from({ length: 100 }, () => browser.run('submissionId()')));
  assert.equal(ids.size, 100); assert.equal(bytes - pageBytes, 1600); for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/);
  browser.run('crypto.getRandomValues = undefined');
  assert.throws(() => browser.run('submissionId()'));
  await assert.rejects(browserFixture(t, async () => assert.fail('No request expected'), new Map(), {}), /getRandomValues/);
});
