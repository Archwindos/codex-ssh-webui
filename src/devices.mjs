import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fail, RelayError } from './protocol.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const nonce = bytes => randomBytes(bytes).toString('base64url');
const idValid = value => typeof value === 'string' && /^device-[a-f0-9]{32}$/.test(value);
const text = value => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fields = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail(400, 'invalid_device_parameters', '设备认证参数无效。');
};
const b64 = (value, max) => {
  if (typeof value !== 'string' || !value || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'invalid_device_parameters', '设备认证编码无效。');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail(400, 'invalid_device_parameters', '设备认证编码无效。');
  return bytes;
};
const publicKey = value => {
  try {
    const bytes = b64(value, 1024), key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = key.export({ type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !bytes.equals(canonical)) throw Error('unsupported key');
    return { key, encoded: canonical.toString('base64url'), keyHash: hash(canonical) };
  } catch { fail(400, 'invalid_device_key', '只接受 P-256 SPKI 公钥。'); }
};
const validLabel = value => text(value) && value.trim().length > 0 && value.length <= 100;
const state = (device, now) => device.revokedAt !== null ? 'revoked' : device.expiresAt <= now ? 'expired' : 'active';
const metadata = (device, now) => ({ id: device.id, label: device.label, status: state(device, now), createdAt: device.createdAt, lastUsedAt: device.lastUsedAt, expiresAt: device.expiresAt, ...(device.revokedAt !== null ? { revokedAt: device.revokedAt } : {}) });

// The browser proves possession of its P-256 key; only public keys are persisted here.
export async function createDeviceAuth({ storeFile = null, pairingsDir = null, authorizeSession = null, clock = Date.now, challengeTtlMs = 60000, trustTtlMs = 90 * 24 * 60 * 60 * 1000, filesystem = fs, uid = process.getuid?.() ?? null } = {}) {
  const pathValid = value => value === null || (text(value) && value.length <= 4096 && isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value));
  if (!pathValid(storeFile) || !pathValid(pairingsDir) || (authorizeSession !== null && typeof authorizeSession !== 'function') || !Number.isSafeInteger(challengeTtlMs) || challengeTtlMs <= 0 || !Number.isSafeInteger(trustTtlMs) || trustTtlMs <= 0 || (uid !== null && (!Number.isSafeInteger(uid) || uid < 0))) fail(500, 'device_configuration', '设备认证存储、授权或有效期配置无效。');
  const devices = new Map(), challenges = new Map();
  let pending = Promise.resolve(), storageFailed = false;
  // Called inside the mutation queue: public status() would wait on that same queue.
  const isActiveDevice = id => { const device = devices.get(id); return !storageFailed && Boolean(device) && state(device, clock()) === 'active'; };
  const privateStat = (stat, directory) => {
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (uid !== null && (stat.uid !== uid || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)))) fail(500, 'device_storage_unsafe', '设备认证存储的所有者、权限或文件类型不安全。');
  };
  const noLinks = async value => {
    const paths = []; let current = resolve(value);
    while (true) { paths.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
    for (const path of paths.reverse()) {
      try { if ((await filesystem.lstat(path)).isSymbolicLink()) fail(500, 'device_storage_unsafe', '设备认证存储不能使用符号链接。'); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
  };
  const privateDirectory = async (path, create = false) => {
    await noLinks(path);
    try { privateStat(await filesystem.lstat(path), true); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await filesystem.mkdir(path, { recursive: true, mode: 0o700 });
      privateStat(await filesystem.lstat(path), true);
    }
  };
  const readPrivate = async (path, limit) => {
    await privateDirectory(dirname(path));
    const before = await filesystem.lstat(path); privateStat(before, false);
    let handle;
    try {
      handle = await filesystem.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const actual = await handle.stat(); privateStat(actual, false);
      if (actual.ino !== before.ino || actual.dev !== before.dev || actual.size > limit) fail(500, 'device_storage_unsafe', '设备认证文件在读取时发生变化或超出上限。');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle?.close(); }
  };
  const safeError = (error, code = 'device_storage_unavailable') => {
    if (error instanceof RelayError) throw error;
    fail(500, code, '设备认证存储暂时不可用。');
  };
  const ready = (async () => {
    try {
      if (pairingsDir) await privateDirectory(pairingsDir, true);
      if (!storeFile) return;
      await privateDirectory(dirname(storeFile), true);
      let data;
      try { data = await readPrivate(storeFile, 128 * 1024); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!exact(data, ['schemaVersion', 'devices']) || data.schemaVersion !== 1 || !Array.isArray(data.devices) || data.devices.length > 100) throw Error('invalid schema');
      for (const value of data.devices) {
        if (!exact(value, ['id', 'label', 'publicKey', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt']) || !idValid(value.id) || devices.has(value.id) || !validLabel(value.label) || ![value.createdAt, value.lastUsedAt, value.expiresAt].every(Number.isSafeInteger) || value.createdAt < 0 || value.lastUsedAt < value.createdAt || value.expiresAt <= value.lastUsedAt || (value.revokedAt !== null && (!Number.isSafeInteger(value.revokedAt) || value.revokedAt < value.createdAt))) throw Error('invalid device');
        publicKey(value.publicKey); devices.set(value.id, { ...value });
      }
      if ([...devices.values()].filter(device => state(device, clock()) === 'active').length > 10) throw Error('too many active devices');
    } catch (error) {
      devices.clear(); safeError(error, 'device_store_invalid');
    }
  })();
  const save = async candidate => {
    if (!storeFile) { devices.clear(); for (const [id, device] of candidate) devices.set(id, device); return; }
    const temporary = `${storeFile}.${nonce(12)}.tmp`; let handle;
    try {
      await privateDirectory(dirname(storeFile));
      try { privateStat(await filesystem.lstat(storeFile), false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      handle = await filesystem.open(temporary, 'wx', 0o600);
      privateStat(await handle.stat(), false);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, devices: [...candidate.values()] }, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await filesystem.rename(temporary, storeFile);
      devices.clear(); for (const [id, device] of candidate) devices.set(id, device);
      storageFailed = false;
    } catch (error) { storageFailed = true; safeError(error); }
    finally { await handle?.close(); await filesystem.rm(temporary, { force: true }).catch(() => {}); }
  };
  const serialized = action => { const result = pending.then(action); pending = result.catch(() => {}); return result; };
  const usable = () => { if (storageFailed) fail(503, 'device_storage_unavailable', '设备认证保存尚未完成，暂不接受设备登录。'); };
  const binding = input => {
    if (!text(input.sessionId) || !input.sessionId || input.sessionId.length > 256 || typeof input.authenticated !== 'boolean' || !text(input.origin) || input.origin.length > 2048) fail(400, 'invalid_device_parameters', '设备认证会话或来源无效。');
    try { const origin = new URL(input.origin); if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== input.origin) throw Error('bad origin'); }
    catch { fail(400, 'invalid_device_parameters', '设备认证来源必须为当前完整 Origin。'); }
  };
  const validPairing = (value, tokenHash) => exact(value, ['schemaVersion', 'tokenHash', 'createdAt', 'expiresAt']) && value.schemaVersion === 1 && value.tokenHash === tokenHash && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.expiresAt) && value.createdAt >= 0 && value.createdAt <= clock() && value.expiresAt > value.createdAt && clock() < value.expiresAt;
  const pairing = async tokenHash => {
    if (!pairingsDir) fail(401, 'device_enrollment_required', '请先登录工作台或使用有效的一次性手机配对。');
    let value;
    try { value = await readPrivate(join(pairingsDir, `${tokenHash}.json`), 4096); }
    catch (error) { if (error.code === 'ENOENT') fail(401, 'device_pairing_invalid', '手机配对已失效，请重新发起配对。'); safeError(error); }
    if (!validPairing(value, tokenHash)) fail(401, 'device_pairing_invalid', '手机配对已失效，请重新发起配对。');
    return value;
  };
  const challenge = async input => {
    await ready; await pending; usable();
    fields(input, ['sessionId', 'origin', 'authenticated'], ['deviceId', 'publicKey', 'label', 'pairingToken']); binding(input);
    let selected, key, authorization, pairingHash;
    if (Object.hasOwn(input, 'deviceId')) {
      if (Object.keys(input).some(name => ['publicKey', 'label', 'pairingToken'].includes(name)) || !idValid(input.deviceId)) fail(400, 'invalid_device_parameters', '设备登录参数无效。');
      selected = devices.get(input.deviceId);
      if (!selected || state(selected, clock()) !== 'active') fail(401, 'device_untrusted', '此浏览器尚未受信任、已过期或已撤销。');
      key = publicKey(selected.publicKey); authorization = 'login';
    } else {
      key = publicKey(input.publicKey);
      if (input.label !== undefined && !validLabel(input.label)) fail(400, 'invalid_device_parameters', '设备名称需要 1–100 个可显示字符。');
      if (input.pairingToken !== undefined) {
        if (typeof input.pairingToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.pairingToken)) fail(401, 'device_pairing_invalid', '手机配对已失效，请重新发起配对。');
        pairingHash = hash(input.pairingToken); await pairing(pairingHash); authorization = 'pairing';
      } else if (input.authenticated === true) authorization = 'session';
      else fail(401, 'device_enrollment_required', '请先登录工作台或使用有效的一次性手机配对。');
      selected = { id: `device-${randomBytes(16).toString('hex')}`, label: input.label?.trim() || '受信任的浏览器' };
    }
    const now = clock();
    for (const [id, entry] of challenges) if (now >= entry.expiresAt) challenges.delete(id);
    if (challenges.size >= 200) fail(429, 'device_challenge_limit', '设备认证请求过多，请稍后再试。');
    const challengeId = nonce(24), expiresAt = now + challengeTtlMs;
    const message = JSON.stringify({ version: 1, purpose: authorization === 'login' ? 'device-login' : 'device-enroll', challengeId, origin: input.origin, sessionHash: hash(input.sessionId), keyHash: key.keyHash, deviceId: selected.id, nonce: nonce(32), createdAt: now, expiresAt });
    challenges.set(challengeId, { message, expiresAt, sessionHash: hash(input.sessionId), origin: input.origin, deviceId: selected.id, label: selected.label, publicKey: key.encoded, authorization, pairingHash });
    return { challengeId, message };
  };
  const verify = input => serialized(async () => {
    await ready; usable();
    fields(input, ['sessionId', 'origin', 'authenticated', 'challengeId', 'signature']); binding(input);
    if (typeof input.challengeId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.challengeId)) fail(400, 'invalid_device_parameters', '设备认证挑战无效。');
    const entry = challenges.get(input.challengeId); challenges.delete(input.challengeId);
    if (!entry || clock() >= entry.expiresAt || entry.sessionHash !== hash(input.sessionId) || entry.origin !== input.origin) fail(401, 'device_challenge_invalid', '设备认证已失效，请重新认证。');
    if (entry.authorization === 'session') {
      let authorized = input.authenticated === true;
      if (authorized && authorizeSession) {
        try { authorized = await authorizeSession({ sessionId: input.sessionId, origin: input.origin }, isActiveDevice) === true; }
        catch { authorized = false; }
      }
      if (!authorized) fail(401, 'device_enrollment_required', '工作台登录已失效，请重新配对。');
    }
    let signature;
    try { signature = b64(input.signature, 86); if (signature.length !== 64) throw Error('bad signature'); }
    catch { fail(401, 'device_signature_invalid', '设备签名无效。'); }
    const key = publicKey(entry.publicKey);
    if (!verifySignature('sha256', Buffer.from(entry.message, 'utf8'), { key: key.key, dsaEncoding: 'ieee-p1363' }, signature)) fail(401, 'device_signature_invalid', '设备签名无效。');
    const now = clock(), candidate = new Map(devices); let device;
    if (entry.authorization === 'login') {
      device = devices.get(entry.deviceId);
      if (!device || state(device, now) !== 'active' || device.publicKey !== entry.publicKey) fail(401, 'device_untrusted', '此浏览器尚未受信任、已过期或已撤销。');
      device = { ...device, lastUsedAt: now, expiresAt: now + trustTtlMs };
    } else {
      if ([...devices.values()].filter(device => state(device, now) === 'active').length >= 10 || devices.size >= 100) fail(429, 'device_limit', '受信任浏览器或历史登记数量达到上限。');
      if ([...devices.values()].some(device => device.publicKey === entry.publicKey && state(device, now) === 'active')) fail(409, 'device_exists', '此公钥已有有效设备登记，请使用已有设备认证。');
      if (entry.authorization === 'pairing') {
        await pairing(entry.pairingHash);
        const source = join(pairingsDir, `${entry.pairingHash}.json`), used = `${source}.used-${nonce(12)}`;
        try {
          await filesystem.rename(source, used);
          const consumed = await readPrivate(used, 4096);
          if (!validPairing(consumed, entry.pairingHash)) fail(401, 'device_pairing_invalid', '手机配对已失效，请重新发起配对。');
        } catch (error) { if (error.code === 'ENOENT') fail(401, 'device_pairing_invalid', '手机配对已失效，请重新发起配对。'); safeError(error); }
      }
      device = { id: entry.deviceId, label: entry.label, publicKey: entry.publicKey, createdAt: now, lastUsedAt: now, expiresAt: now + trustTtlMs, revokedAt: null };
    }
    candidate.set(device.id, device); await save(candidate);
    return { device: metadata(device, clock()), enrolled: entry.authorization !== 'login' };
  });
  const list = async () => { await ready; await pending; return [...devices.values()].map(device => metadata(device, clock())); };
  const status = async id => { await ready; await pending; const device = devices.get(id); return !storageFailed && device && state(device, clock()) === 'active' ? metadata(device, clock()) : null; };
  const revoke = id => serialized(async () => {
    await ready;
    if (!idValid(id)) fail(400, 'invalid_device_parameters', '设备标识无效。');
    const previous = devices.get(id); if (!previous) fail(404, 'device_missing', '没有找到该设备登记。');
    const device = { ...previous, revokedAt: previous.revokedAt ?? clock() }, candidate = new Map(devices);
    candidate.set(id, device); await save(candidate);
    return { device: metadata(device, clock()) };
  });
  await ready;
  return { ready, challenge, verify, list, revoke, status };
}
