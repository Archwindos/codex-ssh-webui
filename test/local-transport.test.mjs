import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RpcClient, validateProduction } from '../src/protocol.mjs';
import { createRelay } from '../src/server.mjs';
import { startRuntimeWorker } from '../src/runtime-worker.mjs';

const config = {
  transport: 'local',
  remoteCodex: '/opt/codex/bin/codex',
  publicOrigin: 'https://relay.test.example',
  projects: [{ id: 'home', name: 'Home', cwd: '/workspace' }],
  verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true }
};
const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', 'codex-server', 'exec /opt/codex/bin/codex app-server'];

function upstream(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const calls = [], messages = []; let killed = 0;
  child.kill = () => { killed++; child.emit('exit', 0); };
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString('utf8').trimEnd().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      if (!message.id) continue;
      assert.ok(['initialize', 'account/read'].includes(message.method), 'startup must not submit a model turn');
      const result = message.method === 'initialize' ? { userAgent: `codex_cli_rs/${options.version || '0.165.0'}` }
        : { account: { type: options.accountType || 'chatgpt' }, requiresOpenaiAuth: true };
      child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
    }
  });
  const spawnProcess = (...args) => { calls.push(args); return child; };
  return { child, calls, messages, spawnProcess, killed: () => killed };
}

function setEnv(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('local production launches only the configured official app-server with a minimal environment', async t => {
  setEnv(t, { HOME: 'TEST_ONLY_HOME', RELAY_ACCESS_SECRET: env.RELAY_ACCESS_SECRET, RELAY_VERIFIED_PROTOCOL: '0.165.0', OPENAI_API_KEY: 'TEST_ONLY_API_KEY', OPENAI_BASE_URL: 'https://provider.invalid', CODEX_MODEL_PROVIDER: 'TEST_ONLY_PROVIDER', HTTP_PROXY: 'http://proxy.invalid', HTTPS_PROXY: 'http://proxy.invalid', ALL_PROXY: 'http://proxy.invalid', SSH_AUTH_SOCK: 'TEST_ONLY_SSH_SOCKET' });
  const fixture = upstream(), rpc = new RpcClient(config, { mock: false, spawnProcess: fixture.spawnProcess });
  t.after(() => rpc.close()); validateProduction(config, env); await rpc.start();
  assert.equal(rpc.connected, true); assert.equal(fixture.calls.length, 1);
  const [command, args, options] = fixture.calls[0];
  assert.equal(command, '/opt/codex/bin/codex'); assert.deepEqual(args, ['app-server']);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
  const keys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP'];
  assert.deepEqual(options.env, Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])));
  assert.equal(options.env.HOME, 'TEST_ONLY_HOME');
  for (const key of ['RELAY_ACCESS_SECRET', 'RELAY_VERIFIED_PROTOCOL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_MODEL_PROVIDER', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'SSH_AUTH_SOCK']) assert.equal(Object.hasOwn(options.env, key), false, key);
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'initialized', 'account/read']);
  assert.deepEqual(fixture.messages[2].params, { refreshToken: false });
  assert.ok(!JSON.stringify(fixture.messages).includes('model')); assert.ok(!JSON.stringify(fixture.messages).includes('provider'));
});

test('omitted and explicit ssh transports use the configured SSH alias with strict host checking', async t => {
  for (const transport of [undefined, 'ssh']) {
    const c = { ...config, transport, sshTarget: 'codex-server' }, fixture = upstream();
    const rpc = new RpcClient(c, { mock: false, spawnProcess: fixture.spawnProcess }); t.after(() => rpc.close());
    validateProduction(c, env); await rpc.start();
    assert.equal(rpc.connected, true); assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0], 'ssh'); assert.deepEqual(fixture.calls[0][1], sshArgs);
    if (process.env.ProgramData !== undefined) assert.equal(fixture.calls[0][2].env.ProgramData, process.env.ProgramData);
    assert.equal(Object.hasOwn(fixture.calls[0][2].env, 'RELAY_ACCESS_SECRET'), false);
  }
});

test('unknown transports fail before any process is spawned', async () => {
  for (const transport of ['other', '', null, false, {}]) {
    const c = { ...config, transport }; let calls = 0;
    assert.throws(() => validateProduction(c, env), error => error.code === 'configuration');
    for (const mock of [false, true]) {
      const rpc = new RpcClient(c, { mock, spawnProcess: () => { calls++; throw Error('must not spawn'); } });
      await assert.rejects(rpc.start(), error => error.code === 'configuration');
    }
    assert.equal(calls, 0);
  }
});

test('production retains executable validation, verified protocol, secret and origin configuration gates', () => {
  assert.doesNotThrow(() => validateProduction(config, env));
  for (const remoteCodex of ['relative/codex', undefined]) assert.throws(() => validateProduction({ ...config, remoteCodex }, env), error => error.code === 'configuration');
  assert.throws(() => validateProduction({ ...config, transport: 'ssh', sshTarget: '--unsafe' }, env), error => error.code === 'configuration');
  for (const verifiedProtocol of [{ ...config.verifiedProtocol, version: '0.166.0' }, { ...config.verifiedProtocol, verified: false }, { ...config.verifiedProtocol, schemaVerified: false }]) assert.throws(() => validateProduction({ ...config, verifiedProtocol }, env), error => error.code === 'protocol_unverified');
  assert.throws(() => validateProduction(config, { ...env, RELAY_VERIFIED_PROTOCOL: '0.166.0' }), error => error.code === 'protocol_unverified');
  assert.throws(() => validateProduction(config, { ...env, RELAY_ACCESS_SECRET: '' }), error => error.code === 'secret_required');
  assert.throws(() => validateProduction({ ...config, publicOrigin: 'http://relay.test.example' }, env), error => error.code === 'configuration');
});

test('different trusted executable paths and SSH aliases are the actual fixture spawn arguments', async t => {
  for (const remoteCodex of ['/opt/codex/bin/codex', '/srv/tools/codex', '/tmp/codex']) {
    for (const transport of ['local', 'ssh']) {
      const configured = { ...config, transport, remoteCodex, sshTarget: 'another-server_1.example' }, fixture = upstream();
      validateProduction(configured, env);
      const rpc = new RpcClient(configured, { mock: false, spawnProcess: fixture.spawnProcess }); t.after(() => rpc.close());
      await rpc.start(); const [command, args, options] = fixture.calls[0];
      if (transport === 'local') { assert.equal(command, remoteCodex); assert.deepEqual(args, ['app-server']); }
      else { assert.equal(command, 'ssh'); assert.deepEqual(args, [...sshArgs.slice(0, -2), configured.sshTarget, `exec ${remoteCodex} app-server`]); }
      assert.equal(options.shell, undefined);
      assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'initialized', 'account/read']);
    }
  }
});

test('unsafe executable paths and SSH targets are rejected before spawn even when RpcClient is used directly', async () => {
  const paths = [undefined, '', 'codex', '/', '/bin/../codex', '/bin/./codex', '/bin//codex', '/bin/codex/', '/tmp/a b/codex', '/tmp/;id/codex', '/tmp/$(id)/codex', '/tmp/`id`/codex', '/tmp/"x"/codex', '/tmp/\'x\'/codex', '/tmp/\n/codex', '/tmp/\0/codex', '/tmp/\\/codex', 'C:/bin/codex', '//server/bin/codex'];
  const aliases = [undefined, '', '-oProxyCommand=id', 'user@host', 'host:22', 'host name', 'host;id', 'host\nname', 'host\0name', 'host/other', '$(id)', '`id`', 'x'.repeat(101)];
  for (const configured of [...paths.flatMap(remoteCodex => ['local', 'ssh'].map(transport => ({ ...config, transport, remoteCodex, sshTarget: 'codex-server' }))), ...aliases.map(sshTarget => ({ ...config, transport: 'ssh', sshTarget }))]) {
    assert.throws(() => validateProduction(configured, env), error => error.code === 'configuration');
    let spawned = false;
    const rpc = new RpcClient(configured, { mock: false, spawnProcess: () => { spawned = true; throw Error('unsafe spawn'); } });
    await assert.rejects(rpc.start(), error => error.code === 'configuration'); assert.equal(spawned, false);
  }
});

test('runtime worker rejects the same unsafe path and unverified protocol before creating any RPC', async () => {
  const id = 'a'.repeat(16), root = resolve('fixture-worker-root'), runDir = join(root, 'runtime', 'runs', id);
  for (const configured of [{ ...config, remoteCodex: '/tmp/../codex' }, { ...config, remoteCodex: '/tmp/$(id)/codex' }, { ...config, verifiedProtocol: { ...config.verifiedProtocol, verified: false } }, { ...config, verifiedProtocol: { ...config.verifiedProtocol, schemaVerified: false } }]) {
    const platform = { runDir: value => join(root, 'runtime', 'runs', value), async initialize() {}, async readJSON() { return { schemaVersion: 1, id, method: 'thread/start', params: { cwd: '/workspace' }, config: configured }; }, async readReceipt() { assert.fail('unsafe launch must not reach a receipt or RPC'); } };
    await assert.rejects(startRuntimeWorker({ runDir, platform, rpcFactory: () => assert.fail('unsafe launch must not start an RPC') }), error => error.code === 'runtime_launch');
  }
});

test('public configuration examples retain false verification flags and fail closed before execution', async () => {
  for (const name of ['workspace', 'ssh-loopback-http', 'shared-daemon']) {
    const example = JSON.parse(await readFile(new URL(`../config/${name}.example.json`, import.meta.url), 'utf8'));
    assert.equal(example.verifiedProtocol.verified, false); assert.equal(example.verifiedProtocol.schemaVerified, false);
    assert.equal(example.projects[0].cwd, '/workspace');
    assert.throws(() => validateProduction(example, env), error => error.code === 'protocol_unverified');
    let spawned = false;
    const rpc = new RpcClient(example, { mock: false, spawnProcess: () => { spawned = true; throw Error('must not spawn an example'); } });
    await assert.rejects(rpc.start(), error => error.code === 'protocol_unverified'); assert.equal(spawned, false);
  }
});

test('local startup refuses an unverified runtime version before account access', async () => {
  const fixture = upstream({ version: '0.166.0' }), rpc = new RpcClient(config, { mock: false, spawnProcess: fixture.spawnProcess });
  await assert.rejects(rpc.start(), error => error.code === 'protocol_mismatch');
  assert.equal(rpc.connected, false); assert.equal(fixture.killed(), 1);
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize']);
});

test('local startup requires the existing ChatGPT account', async () => {
  const fixture = upstream({ accountType: 'apiKey' }), rpc = new RpcClient(config, { mock: false, spawnProcess: fixture.spawnProcess });
  await assert.rejects(rpc.start(), error => error.code === 'chatgpt_login_required');
  assert.equal(rpc.connected, false); assert.equal(fixture.killed(), 1);
  assert.deepEqual(fixture.messages.map(message => message.method), ['initialize', 'initialized', 'account/read']);
});

test('browser requests cannot set transport, command or executable path', async t => {
  const fixture = upstream(), rpc = new RpcClient(config, { mock: false, spawnProcess: fixture.spawnProcess });
  const relay = await createRelay({ mock: false, config, env, port: 0, rpc }); t.after(() => relay.close());
  let cookie = '', csrf = '';
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(relay.publicOrigin).host, Cookie: cookie, ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        if (data.csrf) csrf = data.csrf;
        resolve({ status: res.statusCode, data });
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request('/api/session')).status, 200);
  assert.equal((await request('/api/login', { secret: env.RELAY_ACCESS_SECRET })).status, 200);
  for (const [key, value] of Object.entries({ transport: 'ssh', command: 'ssh attacker', remoteCodex: '/opt/bin/codex' })) {
    assert.equal((await request(`/api/session?${key}=${encodeURIComponent(value)}`)).status, 400);
    for (const [path, body] of [['/api/threads', { projectId: 'home' }], ['/api/resume', { projectId: 'home', threadId: 'thread-1' }], ['/api/turns', { projectId: 'home', threadId: 'thread-1', text: 'must not run', submissionId: 'TEST_ONLY' }]]) assert.equal((await request(path, { ...body, [key]: value })).status, 400);
  }
  assert.equal(fixture.calls.length, 0); assert.deepEqual(fixture.messages, []);
});
