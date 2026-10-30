import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, validateConfig } from '../src/server.mjs';

const exec = promisify(execFile), tempRoot = resolve(tmpdir());
const project = { id: 'home', name: 'Test only', cwd: '/workspace' };
const production = { projects: [project], transport: 'local', remoteCodex: '/home/demo/.local/bin/codex', publicOrigin: 'https://relay.test.example', verifiedProtocol: { version: '0.165.0', verified: true, schemaVerified: true } };
const env = { RELAY_ACCESS_SECRET: 'TEST_ONLY_NEVER_FOR_DEPLOYMENT_1234567890', RELAY_VERIFIED_PROTOCOL: '0.165.0' };
let files;

async function installedOpenSsl() {
  if (spawnSync('openssl', ['version'], { windowsHide: true, stdio: 'ignore' }).status === 0) return 'openssl';
  if (process.platform === 'win32') {
    const gitPaths = spawnSync('where.exe', ['git'], { windowsHide: true, encoding: 'utf8' }).stdout || '';
    for (const gitPath of gitPaths.trim().split(/\r?\n/).filter(Boolean)) {
      const gitRoot = resolve(dirname(gitPath), '..');
      for (const relative of [['usr', 'bin', 'openssl.exe'], ['mingw64', 'bin', 'openssl.exe']]) {
        const candidate = join(gitRoot, ...relative);
        try { await access(candidate); } catch { continue; }
        if (spawnSync(candidate, ['version'], { windowsHide: true, stdio: 'ignore' }).status === 0) return candidate;
      }
    }
  }
  throw new Error('TLS tests require an already installed OpenSSL; no tools were downloaded.');
}
before(async () => {
  const dir = await mkdtemp(join(tempRoot, 'codex-ssh-webui-TEST_ONLY-tls-'));
  files = { dir, keyFile: join(dir, 'TEST_ONLY-key.pem'), certFile: join(dir, 'TEST_ONLY-cert.pem'), invalidFile: join(dir, 'TEST_ONLY-invalid.pem') };
  const openssl = await installedOpenSsl();
  const opensslConfig = join(dir, 'TEST_ONLY-openssl.cnf'); await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\n[dn]\n');
  await exec(openssl, ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=relay.test.example', '-addext', 'subjectAltName=DNS:relay.test.example,IP:127.0.0.1', '-keyout', files.keyFile, '-out', files.certFile], { windowsHide: true });
  files.cert = await readFile(files.certFile);
  await writeFile(files.invalidFile, 'TEST_ONLY_PRIVATE_CONTENT_MUST_NOT_LEAK');
});
after(async () => { if (files) { assert.equal(dirname(files.dir), tempRoot); await rm(files.dir, { recursive: true, force: true }); } });

class FixtureRpc extends EventEmitter {
  connected = false; ended = false; calls = [];
  async start() { this.connected = true; }
  close() { this.connected = false; }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'tls-thread', cwd: project.cwd, turns: [] } };
    throw new Error('Unexpected TLS fixture RPC');
  }
}
const tlsConfig = () => ({ keyFile: files.keyFile, certFile: files.certFile });
async function fixture(t, options = {}) {
  const relay = await createRelay({ mock: false, config: { ...production, tls: tlsConfig() }, env, port: 0, rpc: new FixtureRpc(), ...options }); t.after(() => relay.close());
  let cookie = '', csrf = '';
  const request = (path, body, headers = {}) => new Promise((resolveRequest, reject) => {
    const transport = relay.origin.startsWith('https:') ? https : http;
    const req = transport.request(relay.origin + path, { ...(transport === https ? { ca: files.cert, servername: 'relay.test.example' } : {}), method: body === undefined ? 'GET' : 'POST', headers: { Host: new URL(relay.publicOrigin).host, Cookie: cookie, ...(body === undefined ? {} : { Origin: relay.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...headers } }, res => {
      const encrypted = !!res.socket.encrypted, authorized = res.socket.authorized, chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          if (data.csrf) csrf = data.csrf;
          resolveRequest({ status: res.statusCode, headers: res.headers, data, encrypted, authorized });
        } catch (error) { reject(error); }
      });
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { relay, request };
}

test('native HTTPS performs a verified TLS handshake and preserves production authentication checks', async t => {
  const f = await fixture(t);
  assert.match(f.relay.origin, /^https:\/\/127\.0\.0\.1:/); assert.equal(f.relay.server.address().address, '127.0.0.1');
  const session = await f.request('/api/session'); assert.equal(session.status, 200); assert.equal(session.encrypted, true); assert.equal(session.authorized, true); assert.equal(session.data.authenticated, false);
  assert.match(session.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure$/);
  assert.equal((await f.request('/api/poll?wait=0')).status, 401);
  assert.equal((await f.request('/api/session', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await f.request('/api/session', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET }, { Origin: '' })).status, 403);
  const login = await f.request('/api/login', { secret: env.RELAY_ACCESS_SECRET }); assert.equal(login.status, 200); assert.equal(login.data.authenticated, true); assert.match(login.headers['set-cookie'][0], /; Secure$/);
  for (const extra of [{ tls: tlsConfig() }, { transport: 'ssh' }]) assert.equal((await f.request('/api/threads', { projectId: 'home', ...extra })).status, 400);
  assert.equal((await f.request('/api/session?tls=anything')).status, 400);
  assert.equal((await f.request('/api/session?transport=local')).status, 400);
  assert.equal(f.relay.rpc.calls.length, 0);
  assert.equal((await f.request('/api/threads', { projectId: 'home' })).status, 200); assert.equal(f.relay.rpc.calls.length, 1);
  await assert.rejects(new Promise((resolveRequest, reject) => { const req = https.get(f.relay.origin + '/', { servername: 'relay.test.example', agent: false }, res => { res.resume(); resolveRequest(); }); req.on('error', reject); }), error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
});

test('omitting TLS retains actual loopback HTTP for mock and a trusted HTTPS reverse proxy', async t => {
  const mock = await fixture(t, { mock: true, config: { projects: [project] } });
  assert.match(mock.relay.origin, /^http:\/\/127\.0\.0\.1:/); assert.equal((await mock.request('/api/session')).encrypted, false);
  const proxied = await fixture(t, { config: production });
  assert.match(proxied.relay.origin, /^http:\/\/127\.0\.0\.1:/); assert.equal(proxied.relay.publicOrigin, 'https://relay.test.example');
  const session = await proxied.request('/api/session'); assert.equal(session.encrypted, false); assert.match(session.headers['set-cookie'][0], /; Secure$/);
  assert.throws(() => validateConfig({ ...production, publicOrigin: 'http://relay.test.example' }, false, env), /HTTPS/);
});

test('TLS configuration accepts only two trusted local absolute file paths', () => {
  for (const tls of [null, [], {}, 'anything', { ...tlsConfig(), passphrase: 'forbidden' }, { ...tlsConfig(), keyFile: 'relative.pem' }, { ...tlsConfig(), certFile: 'https://evil.example/cert' }, { ...tlsConfig(), keyFile: '\\\\server\\share\\key.pem' }, { ...tlsConfig(), keyFile: files.keyFile + '\u0000' }]) {
    assert.throws(() => validateConfig({ projects: [project], tls }, true), error => error.code === 'tls_configuration' && !error.message.includes(files.dir));
  }
});

test('unreadable or invalid TLS material fails safely without HTTP fallback or private error details', async () => {
  for (const tls of [{ ...tlsConfig(), keyFile: join(files.dir, 'PRIVATE_PATH_MUST_NOT_LEAK') }, { ...tlsConfig(), keyFile: files.invalidFile }, { ...tlsConfig(), certFile: files.invalidFile }]) {
    const rpc = new FixtureRpc();
    await assert.rejects(createRelay({ mock: false, config: { ...production, tls }, env, port: 0, rpc }), error => {
      assert.equal(error.code, 'tls_configuration'); assert.equal(error.message, 'TLS 证书或私钥无法读取或无效。');
      assert.ok(!String(error).includes(files.dir)); assert.ok(!String(error).includes('TEST_ONLY_PRIVATE_CONTENT')); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(rpc.connected, false); assert.equal(rpc.calls.length, 0);
  }
});

test('CLI startup reports the actual HTTPS listener and rejects invalid TLS without private output', async t => {
  const configPath = join(files.dir, 'TEST_ONLY-config.json'); await writeFile(configPath, JSON.stringify({ ...production, tls: tlsConfig() }));
  const reservation = http.createServer(); await new Promise(resolveListen => reservation.listen(0, '127.0.0.1', resolveListen)); const port = reservation.address().port; await new Promise(resolveClose => reservation.close(resolveClose));
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--config', configPath, '--port', String(port)], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  t.after(async () => { child.kill(); await exited; });
  const output = await new Promise((resolveOutput, reject) => {
    let stdout = '', stderr = ''; const timer = setTimeout(() => reject(new Error('TLS CLI startup timed out')), 5000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes(`https://127.0.0.1:${port}`)) { clearTimeout(timer); resolveOutput(stdout); } });
    child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', () => { clearTimeout(timer); reject(new Error('TLS CLI exited before listening: ' + stderr)); });
  });
  assert.match(output, new RegExp(`https://127\\.0\\.0\\.1:${port}`)); assert.ok(!output.includes('http://')); assert.ok(!output.includes(files.keyFile));
  const status = await new Promise((resolveStatus, reject) => { const req = https.get(`https://127.0.0.1:${port}/api/session`, { ca: files.cert, servername: 'relay.test.example', headers: { Host: 'relay.test.example' }, agent: false }, res => { res.resume(); res.on('end', () => resolveStatus(res.statusCode)); }); req.on('error', reject); }); assert.equal(status, 200);
  await writeFile(configPath, JSON.stringify({ ...production, tls: { ...tlsConfig(), keyFile: join(files.dir, 'PRIVATE_PATH_MUST_NOT_LEAK') } }));
  await assert.rejects(exec(process.execPath, [entry, '--config', configPath, '--port', String(port)], { windowsHide: true, env: { ...process.env, ...env } }), error => { assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.equal(error.stderr.trim(), 'TLS 证书或私钥无法读取或无效。'); assert.ok(!error.stderr.includes(files.dir)); return true; });
});
