import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createDeviceAuth } from '../src/devices.mjs';

const base = { sessionId: 'session-one', origin: 'https://relay.example', authenticated: true };
const keypair = () => { const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); return { ...pair, encoded: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }; };
const signature = (pair, message) => sign('sha256', Buffer.from(message), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const signed = (pair, challenge, overrides = {}) => ({ ...base, challengeId: challenge.challengeId, signature: signature(pair, challenge.message), ...overrides });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'relay-device-auth-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1800000000000;
  const config = { storeFile: options.persist ? join(root, 'private', 'devices.json') : null, pairingsDir: options.pairing ? join(root, 'private', 'pairings') : null, clock: () => now, ...options.config };
  const auth = await createDeviceAuth(config);
  const enroll = async (pair = keypair(), extra = {}) => {
    const challenge = await auth.challenge({ ...base, publicKey: pair.encoded, ...extra });
    return { pair, challenge, ...(await auth.verify(signed(pair, challenge))) };
  };
  const pairing = async (expiresIn = 60000) => {
    const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
    const path = join(config.pairingsDir, `${tokenHash}.json`);
    await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, tokenHash, createdAt: now, expiresAt: now + expiresIn }), { mode: 0o600 });
    return { token, path, tokenHash };
  };
  return { auth, config, root, enroll, pairing, advance: value => { now += value; }, now: () => now, reopen: overrides => createDeviceAuth({ ...config, ...overrides }) };
}

test('a nonextractable browser-compatible P-256 key signs exact bound messages and only public key metadata persists', async t => {
  const f = await fixture(t, { persist: true });
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await assert.rejects(webcrypto.subtle.exportKey('pkcs8', key.privateKey));
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', key.publicKey));
  const challenge = await f.auth.challenge({ ...base, publicKey: spki.toString('base64url'), label: 'My phone' }), message = JSON.parse(challenge.message);
  assert.equal(message.challengeId, challenge.challengeId); assert.equal(message.origin, base.origin); assert.equal(message.purpose, 'device-enroll');
  assert.equal(message.keyHash, createHash('sha256').update(spki).digest('hex')); assert.equal(message.expiresAt - message.createdAt, 60000);
  assert.ok(!challenge.message.includes(base.sessionId)); assert.match(message.nonce, /^[A-Za-z0-9_-]{43}$/);
  const proof = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(challenge.message)));
  assert.equal(proof.length, 64);
  const result = await f.auth.verify({ ...base, challengeId: challenge.challengeId, signature: proof.toString('base64url') });
  assert.equal(result.enrolled, true); assert.equal(result.device.id, message.deviceId); assert.equal(result.device.status, 'active');
  assert.equal(result.device.expiresAt, f.now() + 90 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await f.auth.list(), [result.device]); assert.deepEqual(await f.auth.status(result.device.id), result.device);
  assert.ok(!JSON.stringify(result).includes('publicKey')); assert.ok(!JSON.stringify(result).includes('sessionHash'));
  const disk = JSON.parse(await fs.readFile(f.config.storeFile, 'utf8'));
  assert.equal(disk.schemaVersion, 1); assert.equal(disk.devices[0].publicKey, spki.toString('base64url'));
  assert.ok(!JSON.stringify(disk).includes(base.sessionId)); assert.ok(!JSON.stringify(disk).includes(message.nonce));
  assert.deepEqual(await fs.readdir(dirname(f.config.storeFile)), ['devices.json']);
});

test('valid login renews idle trust while invalid signatures, altered nonces and replay never authenticate', async t => {
  const f = await fixture(t), saved = await f.enroll(); f.advance(1000);
  const login = await f.auth.challenge({ ...base, authenticated: false, deviceId: saved.device.id });
  assert.equal(JSON.parse(login.message).purpose, 'device-login');
  const logged = await f.auth.verify(signed(saved.pair, login, { authenticated: false }));
  assert.equal(logged.enrolled, false); assert.equal(logged.device.lastUsedAt, f.now()); assert.equal(logged.device.expiresAt, saved.device.expiresAt + 1000);
  await assert.rejects(f.auth.verify(signed(saved.pair, login)), error => error.code === 'device_challenge_invalid');
  const changed = await f.auth.challenge({ ...base, deviceId: saved.device.id });
  const altered = JSON.stringify({ ...JSON.parse(changed.message), nonce: randomBytes(32).toString('base64url') });
  await assert.rejects(f.auth.verify({ ...signed(saved.pair, changed), signature: signature(saved.pair, altered) }), error => error.code === 'device_signature_invalid');
  await assert.rejects(f.auth.verify(signed(saved.pair, changed)), error => error.code === 'device_challenge_invalid');
  const second = await f.auth.challenge({ ...base, deviceId: saved.device.id });
  await assert.rejects(f.auth.verify({ ...signed(saved.pair, second), signature: signature(saved.pair, login.message) }), error => error.code === 'device_signature_invalid');
  assert.equal((await f.auth.status(saved.device.id)).expiresAt, logged.device.expiresAt);
});

test('challenges bind session and origin, expire once, and enrollment authorization must still hold at verification', async t => {
  const f = await fixture(t), pair = keypair();
  for (const overrides of [{ sessionId: 'session-two' }, { origin: 'https://other.example' }, { authenticated: false }]) {
    const c = await f.auth.challenge({ ...base, publicKey: pair.encoded });
    await assert.rejects(f.auth.verify(signed(pair, c, overrides)), error => error.status === 401);
  }
  const expired = await f.auth.challenge({ ...base, publicKey: pair.encoded }); f.advance(60000);
  await assert.rejects(f.auth.verify(signed(pair, expired)), error => error.code === 'device_challenge_invalid');
  assert.deepEqual(await f.auth.list(), []);
  await assert.rejects(f.auth.challenge({ ...base, authenticated: false, publicKey: pair.encoded }), error => error.code === 'device_enrollment_required');
});

test('session enrollment rechecks the live source device after an earlier queued revoke without waiting on its own queue', { timeout: 2000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), checks = [];
  let holdRevoke = false;
  const liveSession = { authenticated: true, deviceId: null, origin: base.origin };
  const f = await fixture(t, { persist: true, config: {
    authorizeSession(context, isActiveDevice) {
      assert.deepEqual(context, { sessionId: base.sessionId, origin: base.origin });
      if (!liveSession.authenticated || liveSession.origin !== context.origin) return false;
      if (!liveSession.deviceId) return true;
      const active = isActiveDevice(liveSession.deviceId);
      assert.equal(typeof active, 'boolean', 'the internal device check must be synchronous'); checks.push(active); return active;
    },
    filesystem: { ...fs, async rename(from, to) {
      if (holdRevoke) { holdRevoke = false; entered.resolve(); await release.promise; }
      return fs.rename(from, to);
    } }
  } });
  t.after(() => release.resolve());
  const source = await f.enroll(); liveSession.deviceId = source.device.id;
  const pair = keypair(), challenge = await f.auth.challenge({ ...base, publicKey: pair.encoded });
  holdRevoke = true;
  const revoked = f.auth.revoke(source.device.id); await entered.promise;
  const denied = assert.rejects(f.auth.verify(signed(pair, challenge)), error => error.status === 401 && error.code === 'device_enrollment_required');
  await new Promise(setImmediate); assert.deepEqual(checks, [], 'the enrollment authorization waits behind the queued revoke');
  release.resolve(); await revoked; await denied;
  assert.deepEqual(checks, [false]);
  assert.equal(liveSession.authenticated, true, 'the caller can still hold the stale authentication snapshot');
  assert.equal(await f.auth.status(JSON.parse(challenge.message).deviceId), null);
  const devices = await f.auth.list(); assert.equal(devices.length, 1); assert.equal(devices[0].status, 'revoked');
  assert.equal(JSON.parse(await fs.readFile(f.config.storeFile, 'utf8')).devices.length, 1);
});

test('live session authorization must return strict true and failures never leak callback details or create a device', async t => {
  for (const result of [false, 'true', { authenticated: true }, new Error('PRIVATE_AUTHORIZATION_DETAILS')]) {
    const f = await fixture(t, { config: { async authorizeSession(context, isActiveDevice) {
      assert.deepEqual(context, { sessionId: base.sessionId, origin: base.origin });
      assert.equal(isActiveDevice(`device-${'0'.repeat(32)}`), false);
      if (result instanceof Error) throw result; return result;
    } } });
    const pair = keypair(), challenge = await f.auth.challenge({ ...base, publicKey: pair.encoded });
    await assert.rejects(f.auth.verify(signed(pair, challenge)), error => error.code === 'device_enrollment_required' && !error.message.includes('PRIVATE_'));
    assert.deepEqual(await f.auth.list(), []);
  }
});

test('pairing enrollment and device login use their own proof rather than the session-enrollment callback', async t => {
  let checks = 0;
  const f = await fixture(t, { pairing: true, config: { authorizeSession() { checks++; throw Error('must not be used'); } } });
  const pair = keypair(), token = await f.pairing();
  const paired = await f.auth.challenge({ ...base, authenticated: false, publicKey: pair.encoded, pairingToken: token.token });
  const saved = await f.auth.verify(signed(pair, paired, { authenticated: false }));
  const login = await f.auth.challenge({ ...base, authenticated: false, deviceId: saved.device.id });
  assert.equal((await f.auth.verify(signed(pair, login, { authenticated: false }))).device.id, saved.device.id);
  assert.equal(checks, 0);
});

test('revoked and expired devices fail both login creation and an outstanding proof and stay in audit metadata', async t => {
  const f = await fixture(t, { config: { trustTtlMs: 1000 } }), saved = await f.enroll();
  const outstanding = await f.auth.challenge({ ...base, deviceId: saved.device.id });
  const revoked = await f.auth.revoke(saved.device.id);
  assert.equal(revoked.device.status, 'revoked'); assert.equal(await f.auth.status(saved.device.id), null);
  await assert.rejects(f.auth.verify(signed(saved.pair, outstanding)), error => error.code === 'device_untrusted');
  await assert.rejects(f.auth.challenge({ ...base, deviceId: saved.device.id }), error => error.code === 'device_untrusted');
  assert.equal((await f.auth.list())[0].status, 'revoked');
  const next = await f.enroll(); const expires = await f.auth.challenge({ ...base, deviceId: next.device.id }); f.advance(1000);
  assert.equal(await f.auth.status(next.device.id), null); assert.equal((await f.auth.list())[1].status, 'expired');
  await assert.rejects(f.auth.verify(signed(next.pair, expires)), error => error.code === 'device_untrusted');
  await assert.rejects(f.auth.revoke(`device-${'0'.repeat(32)}`), error => error.status === 404);
});

test('one-time pairing is read at challenge, consumed only by a valid signature, and cannot enroll a second key', async t => {
  const f = await fixture(t, { persist: true, pairing: true }), token = await f.pairing(), first = keypair(), second = keypair();
  const input = { ...base, authenticated: false, pairingToken: token.token };
  const a = await f.auth.challenge({ ...input, publicKey: first.encoded }), b = await f.auth.challenge({ ...input, publicKey: second.encoded });
  assert.ok(await fs.stat(token.path));
  const bad = await f.auth.challenge({ ...input, publicKey: second.encoded });
  await assert.rejects(f.auth.verify(signed(first, bad, { authenticated: false })), error => error.code === 'device_signature_invalid');
  assert.ok(await fs.stat(token.path), 'bad signatures do not consume a valid pairing token');
  const accepted = await f.auth.verify(signed(first, a, { authenticated: false })); assert.equal(accepted.enrolled, true);
  await assert.rejects(f.auth.verify(signed(second, b, { authenticated: false })), error => error.code === 'device_pairing_invalid');
  await assert.rejects(fs.stat(token.path), error => error.code === 'ENOENT');
  const used = await fs.readdir(f.config.pairingsDir); assert.equal(used.length, 1); assert.ok(used[0].startsWith(`${token.tokenHash}.json.used-`));
  assert.equal((await f.auth.list()).length, 1); assert.ok(!(await fs.readFile(f.config.storeFile, 'utf8')).includes(token.token));
});

test('pairing expires between challenge and proof and is rechecked immediately during consumption', async t => {
  const f = await fixture(t, { pairing: true }), pair = keypair(), token = await f.pairing(1000);
  const c = await f.auth.challenge({ ...base, authenticated: false, pairingToken: token.token, publicKey: pair.encoded }); f.advance(1000);
  await assert.rejects(f.auth.verify(signed(pair, c, { authenticated: false })), error => error.code === 'device_pairing_invalid');
  assert.deepEqual(await f.auth.list(), []); assert.ok(await fs.stat(token.path));
  const fresh = await f.pairing(1000);
  const raced = await f.reopen({ filesystem: { ...fs, async rename(from, to) { await fs.rename(from, to); if (from === fresh.path) f.advance(1000); } } });
  const proof = await raced.challenge({ ...base, authenticated: false, pairingToken: fresh.token, publicKey: pair.encoded });
  await assert.rejects(raced.verify(signed(pair, proof, { authenticated: false })), error => error.code === 'device_pairing_invalid');
  assert.deepEqual(await raced.list(), []);
});

test('public keys survive restart, outstanding nonce state does not, and private keys are never part of the store', async t => {
  const f = await fixture(t, { persist: true }), saved = await f.enroll();
  const old = await f.auth.challenge({ ...base, deviceId: saved.device.id }), restored = await f.reopen();
  assert.deepEqual(await restored.list(), [saved.device]);
  await assert.rejects(restored.verify(signed(saved.pair, old)), error => error.code === 'device_challenge_invalid');
  const c = await restored.challenge({ ...base, deviceId: saved.device.id });
  assert.equal((await restored.verify(signed(saved.pair, c))).enrolled, false);
  const file = await fs.readFile(f.config.storeFile, 'utf8');
  assert.ok(!file.includes(saved.pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')));
});

test('non-P256, private, malformed and noncanonical key encodings and non-P1363 signatures are refused', async t => {
  const f = await fixture(t), pair = keypair();
  const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');
  for (const publicKey of [ed, p384, pkcs8, '', 'invalid!', `${pair.encoded}=`, Buffer.concat([Buffer.from(pair.encoded, 'base64url'), Buffer.from([0])]).toString('base64url')]) await assert.rejects(f.auth.challenge({ ...base, publicKey }), error => error.code === 'invalid_device_key');
  for (const proof of ['', 'invalid!', Buffer.alloc(63).toString('base64url'), sign('sha256', Buffer.from('data'), pair.privateKey).toString('base64url')]) {
    const c = await f.auth.challenge({ ...base, publicKey: pair.encoded });
    await assert.rejects(f.auth.verify({ ...signed(pair, c), signature: proof }), error => error.code === 'device_signature_invalid');
  }
  assert.deepEqual(await f.auth.list(), []);
});

test('bounded devices, audit history and pending challenges reject additions without silently deleting records', async t => {
  const f = await fixture(t);
  const ids = []; for (let i = 0; i < 10; i++) ids.push((await f.enroll()).device.id);
  await assert.rejects(f.enroll(), error => error.code === 'device_limit');
  await f.auth.revoke(ids[0]); await f.enroll();
  assert.equal((await f.auth.list()).length, 11); assert.equal((await f.auth.list()).filter(row => row.status === 'active').length, 10);
  const history = await fixture(t, { config: { trustTtlMs: 1 } });
  for (let i = 0; i < 100; i++) { await history.enroll(); history.advance(2); }
  await assert.rejects(history.enroll(), error => error.code === 'device_limit'); assert.equal((await history.auth.list()).length, 100);
  const bounded = await fixture(t), pair = keypair();
  for (let i = 0; i < 200; i++) await bounded.auth.challenge({ ...base, publicKey: pair.encoded });
  await assert.rejects(bounded.auth.challenge({ ...base, publicKey: pair.encoded }), error => error.code === 'device_challenge_limit');
  bounded.advance(60000); assert.ok((await bounded.auth.challenge({ ...base, publicKey: pair.encoded })).challengeId);
});

test('partial store IO failures grant no credential, consume a pairing at most once, and disable cached trust', async t => {
  const f = await fixture(t, { persist: true, pairing: true }), pair = keypair(), token = await f.pairing();
  const failing = await f.reopen({ filesystem: { ...fs, async rename(from, to) { if (to === f.config.storeFile) throw Error(`PRIVATE_IO_${token.token}`); return fs.rename(from, to); } } });
  const c = await failing.challenge({ ...base, authenticated: false, publicKey: pair.encoded, pairingToken: token.token });
  await assert.rejects(failing.verify(signed(pair, c, { authenticated: false })), error => error.code === 'device_storage_unavailable' && !error.message.includes(token.token));
  assert.deepEqual(await failing.list(), []); assert.equal(await failing.status(JSON.parse(c.message).deviceId), null);
  await assert.rejects(failing.challenge({ ...base, publicKey: pair.encoded }), error => error.status === 503);
  await assert.rejects(fs.stat(token.path), error => error.code === 'ENOENT');
  const restored = await f.reopen(); assert.deepEqual(await restored.list(), []);
  await assert.rejects(restored.challenge({ ...base, authenticated: false, publicKey: pair.encoded, pairingToken: token.token }), error => error.code === 'device_pairing_invalid');
  assert.ok(!(await fs.readdir(dirname(f.config.storeFile))).some(name => name.endsWith('.tmp')));
  const saved = await f.enroll();
  const failedRevoke = await f.reopen({ filesystem: { ...fs, async rename() { throw Error('PRIVATE_REVOKE_IO'); } } });
  await assert.rejects(failedRevoke.revoke(saved.device.id), error => error.code === 'device_storage_unavailable');
  assert.equal(await failedRevoke.status(saved.device.id), null);
  await assert.rejects(failedRevoke.challenge({ ...base, deviceId: saved.device.id }), error => error.status === 503);
});

test('private storage rejects symlink paths and mismatched UID, and Linux modes are checked without repairing them', async t => {
  const f = await fixture(t, { persist: true, pairing: true }); await f.enroll();
  const alias = join(f.root, 'alias'); await fs.symlink(dirname(f.config.storeFile), alias, 'junction');
  await assert.rejects(f.reopen({ storeFile: join(alias, 'devices.json') }), error => error.code === 'device_storage_unsafe');
  await assert.rejects(f.reopen({ uid: (process.getuid?.() ?? 0) + 1 }), error => error.code === 'device_storage_unsafe');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.config.storeFile)).mode & 0o777, 0o600); assert.equal((await fs.stat(dirname(f.config.storeFile))).mode & 0o777, 0o700);
    await fs.chmod(f.config.storeFile, 0o644);
    await assert.rejects(f.reopen(), error => error.code === 'device_storage_unsafe'); assert.equal((await fs.stat(f.config.storeFile)).mode & 0o777, 0o644);
  }
});
