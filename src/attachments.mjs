import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fail, RelayError } from './protocol.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({ maxFileBytes: 10 * 1024 * 1024, maxFiles: 5, maxPendingBytes: 50 * 1024 * 1024, maxPendingFiles: 100, pendingTtlMs: 24 * 60 * 60 * 1000 });
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const DOCUMENT_TYPES = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const TEXT_EXTENSIONS = ['.txt', '.md', '.rst', '.rtf', '.log', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.ipynb', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.java', '.go', '.rs', '.rb', '.php', '.sql', '.tex', '.bib', '.r', '.m', '.swift', '.kt', '.kts', '.lua', '.vue', '.svelte', '.fasta', '.fa', '.faa', '.fna', '.pdb', '.cif', '.a3m', '.sto', '.aln'];
const TYPES = { ...Object.fromEntries(TEXT_EXTENSIONS.map(ext => [ext, 'text/plain'])), ...DOCUMENT_TYPES, ...IMAGE_TYPES };
export const ATTACHMENT_ACCEPT = Object.keys(TYPES).join(',');
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
const validSession = id => typeof id === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(id);
const validThread = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => new RelayError(404, 'attachment_unavailable', '附件不存在、已取消，或不属于当前登录会话。');
const metadata = record => ({ id: record.id, name: record.name, size: record.size, mimeType: record.mimeType, kind: record.kind, createdAt: record.createdAt });

function fileType(name, suppliedMime = '') {
  if (typeof name !== 'string' || !name || name.length > 200 || Buffer.byteLength(name) > 600 || controls.test(name) || /[\\/:]/.test(name) || basename(name) !== name) fail(400, 'attachment_name', '附件名称无效；不能包含路径或控制字符。');
  const extension = extname(name).toLowerCase(), mimeType = TYPES[extension];
  if (!mimeType) fail(415, 'attachment_type', '此附件类型暂不受支持。');
  if (typeof suppliedMime !== 'string' || suppliedMime.length > 200 || (suppliedMime && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(suppliedMime))) fail(400, 'attachment_type', '附件类型标记无效。');
  const kind = IMAGE_TYPES[extension] ? 'image' : 'file';
  if (suppliedMime.startsWith('image/') && (kind !== 'image' || ![mimeType, ...(mimeType === 'image/jpeg' ? ['image/jpg'] : [])].includes(suppliedMime.toLowerCase()))) fail(415, 'attachment_type', '图片类型与文件扩展名不匹配。');
  return { extension, mimeType, kind };
}

function verifyContent(bytes, extension) {
  let valid = true;
  if (extension === '.png') valid = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  else if (extension === '.jpg' || extension === '.jpeg') valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  else if (extension === '.gif') valid = bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  else if (extension === '.webp') valid = bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  else if (extension === '.pdf') valid = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  else if (DOCUMENT_TYPES[extension]) valid = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
  else {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); valid = !bytes.includes(0); }
    catch { valid = false; }
  }
  if (!valid) fail(415, 'attachment_content', '附件内容与类型不匹配，或文本不是有效的 UTF-8。');
}

// Files stay in this private store, never in a browser-provided or project path.
// resolve() durably claims them before dispatch: uncertain native results must
// not cause deletion while Codex may still read the original input.
export async function createAttachmentStore({ rootDir, authorizeSession = () => false, clock = Date.now, platform = process.platform } = {}) {
  if (typeof rootDir !== 'string' || !isAbsolute(rootDir) || controls.test(rootDir) || typeof authorizeSession !== 'function') fail(500, 'attachment_configuration', '附件存储需要可信的私有绝对目录和会话校验。');
  const root = resolve(rootDir), queues = new Map();
  if (root === dirname(root)) fail(500, 'attachment_configuration', '不能将文件系统根目录用作附件存储。');
  const uid = process.getuid?.();
  const syncDirectory = async path => {
    if (platform === 'win32') return;
    const handle = await fs.open(path, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const privatePath = async (path, directory) => {
    const info = await fs.lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || (uid !== undefined && info.uid !== uid) || (platform !== 'win32' && (info.mode & 0o777) !== (directory ? 0o700 : 0o600)) || await fs.realpath(path) !== path) fail(500, 'attachment_store_unsafe', '附件私有存储状态无效。');
    return info;
  };
  if (await fs.realpath(dirname(root)) !== dirname(root)) fail(500, 'attachment_store_unsafe', '附件目录不能经过符号链接。');
  try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privatePath(root, true);
  const authorized = async sessionId => {
    if (!validSession(sessionId) || await authorizeSession(sessionId) !== true) fail(401, 'session_required', '附件操作需要有效的登录会话。');
    return digest(sessionId);
  };
  const ownerDirectory = async owner => {
    await privatePath(root, true);
    const path = join(root, owner); let created = false;
    try { await fs.mkdir(path, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created) await syncDirectory(root);
    await privatePath(path, true); return path;
  };
  const queueOwner = async (owner, operation) => {
    const prior = queues.get(owner) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => operation(owner));
    queues.set(owner, work);
    try { return await work; } finally { if (queues.get(owner) === work) queues.delete(owner); }
  };
  const serialized = async (sessionId, operation) => queueOwner(await authorized(sessionId), async owner => { await authorized(sessionId); return operation(owner); });
  const readBounded = async (path, maximum) => {
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maximum || (uid !== undefined && info.uid !== uid) || (platform !== 'win32' && (info.mode & 0o777) !== 0o600)) throw unavailable();
      const buffer = Buffer.alloc(Math.min(info.size + 1, maximum + 1)); let size = 0;
      while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null); if (!bytesRead) break; size += bytesRead; }
      if (size > info.size || size > maximum) throw unavailable();
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  };
  const save = async (folder, value) => {
    await privatePath(folder, true);
    const temporary = join(folder, `metadata-${randomBytes(12).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, join(folder, 'metadata.json'));
      await syncDirectory(folder);
    } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  const recordAt = async (owner, id, { content = false } = {}) => {
    if (!validId(id)) fail(400, 'attachment_id', '附件标识无效。');
    const parent = await ownerDirectory(owner), folder = join(parent, id), manifest = join(folder, 'metadata.json');
    try {
      await privatePath(folder, true);
      const info = await privatePath(manifest, false);
      if (info.size > 8192) throw unavailable();
      const value = JSON.parse((await readBounded(manifest, 8192)).toString('utf8')), type = fileType(value.name);
      if (value.schemaVersion !== 1 || value.id !== id || value.owner !== owner || value.kind !== type.kind || value.mimeType !== type.mimeType || value.extension !== type.extension || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > ATTACHMENT_LIMITS.maxFileBytes || !Number.isSafeInteger(value.createdAt) || !/^[a-f0-9]{64}$/.test(value.sha256) || !['pending', 'retained'].includes(value.state) || (value.state === 'retained' && !validThread(value.threadId)) || (value.state === 'pending' && value.threadId !== null)) throw unavailable();
      const path = join(folder, `attachment${type.extension}`), stored = await privatePath(path, false);
      if (stored.size !== value.size) throw unavailable();
      if (content) {
        const bytes = await readBounded(path, ATTACHMENT_LIMITS.maxFileBytes);
        if (bytes.length !== value.size || digest(bytes) !== value.sha256) throw unavailable();
      }
      return { value, folder, path };
    } catch (error) {
      if (error instanceof RelayError && error.code === 'attachment_store_unsafe') throw error;
      throw unavailable();
    }
  };
  const discard = async ({ folder, path }) => {
    // Only known files in an already verified, generated upload directory.
    await privatePath(folder, true);
    if (resolve(folder) !== folder || dirname(dirname(folder)) !== root || !validId(basename(folder))) fail(500, 'attachment_store_unsafe', '附件清理范围无效。');
    for (const file of [path, join(folder, 'metadata.json')]) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder); await syncDirectory(dirname(folder));
  };
  const pending = async owner => {
    const parent = await ownerDirectory(owner), values = [];
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (!validId(entry.name)) continue;
      const record = await recordAt(owner, entry.name);
      if (record.value.state === 'pending') values.push(record);
    }
    return values;
  };
  const cleanOwner = async owner => {
    let removed = 0;
    for (const record of await pending(owner)) if (clock() - record.value.createdAt >= ATTACHMENT_LIMITS.pendingTtlMs) { await discard(record); removed++; }
    return { removed };
  };
  const upload = (sessionId, { name, mimeType = '', body, signal } = {}) => serialized(sessionId, async owner => {
    const type = fileType(name, mimeType);
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array) && typeof body?.[Symbol.asyncIterator] !== 'function') fail(400, 'attachment_body', '附件上传内容无效。');
    await cleanOwner(owner);
    const awaiting = await pending(owner), used = awaiting.reduce((total, record) => total + record.value.size, 0);
    if (awaiting.length >= ATTACHMENT_LIMITS.maxPendingFiles || used >= ATTACHMENT_LIMITS.maxPendingBytes) fail(429, 'attachment_quota', '当前登录会话的待发送附件已达到上限。');
    const parent = await ownerDirectory(owner), id = randomBytes(24).toString('hex'), folder = join(parent, id), path = join(folder, `attachment${type.extension}`);
    let handle, published = false;
    const onAbort = () => body?.destroy?.(new RelayError(400, 'attachment_cancelled', '附件上传已取消。'));
    try {
      if (signal?.aborted) fail(400, 'attachment_cancelled', '附件上传已取消。');
      await fs.mkdir(folder, { mode: 0o700 }); await privatePath(folder, true); await syncDirectory(parent);
      handle = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      const chunks = []; let size = 0;
      const stream = Buffer.isBuffer(body) || body instanceof Uint8Array ? [body] : body;
      signal?.addEventListener('abort', onAbort, { once: true });
      for await (const chunk of stream) {
        if (signal?.aborted) fail(400, 'attachment_cancelled', '附件上传已取消。');
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail(400, 'attachment_body', '附件上传内容无效。');
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > ATTACHMENT_LIMITS.maxFileBytes) fail(413, 'attachment_size', '单个附件不能超过 10 MiB。');
        if (used + size > ATTACHMENT_LIMITS.maxPendingBytes) fail(429, 'attachment_quota', '待发送附件总大小不能超过 50 MiB。');
        chunks.push(bytes); await handle.writeFile(bytes);
      }
      if (!size) fail(400, 'attachment_empty', '不能上传空文件。');
      if (signal?.aborted) fail(400, 'attachment_cancelled', '附件上传已取消。');
      const bytes = Buffer.concat(chunks, size); verifyContent(bytes, type.extension);
      await handle.sync(); await handle.close(); handle = null; await authorized(sessionId);
      const value = { schemaVersion: 1, id, owner, name, size, ...type, createdAt: clock(), state: 'pending', threadId: null, sha256: digest(bytes) };
      await save(folder, value); published = true; return metadata(value);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(400, 'attachment_upload_failed', '附件上传未完成，请重新选择文件。');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await handle?.close();
      if (!published) {
        await fs.unlink(path).catch(() => {}); await fs.unlink(join(folder, 'metadata.json')).catch(() => {}); await fs.rmdir(folder).catch(() => {});
      }
    }
  });
  const resolveAttachments = (ids, { sessionId, threadId, validateInput } = {}) => serialized(sessionId, async owner => {
    if (!Array.isArray(ids) || ids.length > ATTACHMENT_LIMITS.maxFiles || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length || !validThread(threadId)) fail(400, 'attachment_ids', '每条消息最多选择 5 个有效且不重复的附件。');
    const records = [];
    for (const id of ids) {
      const record = await recordAt(owner, id, { content: true });
      if (record.value.state === 'retained' && record.value.threadId !== threadId) fail(409, 'attachment_scope', '附件已经用于其他对话，请重新上传。');
      if (record.value.state === 'pending' && clock() - record.value.createdAt >= ATTACHMENT_LIMITS.pendingTtlMs) throw unavailable();
      records.push(record);
    }
    const input = records.length ? [{ type: 'text', text: '用户上传的附件；可按本次任务需要读取以下本地文件：\n' + records.map(record => JSON.stringify({ name: record.value.name, path: record.path, mimeType: record.value.mimeType, size: record.value.size })).join('\n'), text_elements: [] }, ...records.filter(record => record.value.kind === 'image').map(record => ({ type: 'localImage', path: record.path }))] : [];
    const attachments = records.map(record => metadata(record.value));
    if (validateInput !== undefined) {
      if (typeof validateInput !== 'function') fail(500, 'attachment_configuration', '附件输入校验器无效。');
      await validateInput(structuredClone(input), structuredClone(attachments));
    }
    await authorized(sessionId);
    for (const record of records) if (record.value.state === 'pending') { record.value.state = 'retained'; record.value.threadId = threadId; await save(record.folder, record.value); }
    return { input, attachments };
  });
  const cancel = (id, { sessionId } = {}) => serialized(sessionId, async owner => {
    const record = await recordAt(owner, id);
    if (record.value.state !== 'pending') fail(409, 'attachment_referenced', '附件已被消息引用，不能自动删除。');
    await discard(record); return { cancelled: true };
  });
  // No-session cleanup is an internal maintenance operation, never a browser API.
  // It also expires abandoned uploads whose former login has already ended.
  const cleanup = async ({ sessionId } = {}) => {
    if (sessionId !== undefined) return serialized(sessionId, cleanOwner);
    await privatePath(root, true); let removed = 0;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) if (/^[a-f0-9]{64}$/.test(entry.name)) removed += (await queueOwner(entry.name, cleanOwner)).removed;
    return { removed };
  };
  return { upload, resolve: resolveAttachments, cancel, cleanup, close() {}, limits: ATTACHMENT_LIMITS, accept: ATTACHMENT_ACCEPT };
}
