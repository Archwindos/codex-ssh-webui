import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createAttachmentStore, ATTACHMENT_LIMITS, ATTACHMENT_ACCEPT } from '../src/attachments.mjs';
import { RelayError } from '../src/protocol.mjs';

const owner = 'test_session_owner_opaque_1111111111111111111';
const peer = 'test_session_peer_opaque_22222222222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'relay-attachments-'))), rootDir = join(parent, 'attachments');
  let now = 1000000000; const sessions = new Set([owner, peer]);
  const options = { rootDir, authorizeSession: sessionId => sessions.has(sessionId), clock: () => now };
  const store = await createAttachmentStore(options);
  t.after(async () => { store.close(); await fs.rm(parent, { recursive: true, force: true }); });
  return { store, rootDir, parent, sessions, options, advance: ms => { now += ms; }, ownerDir: sessionId => join(rootDir, hash(sessionId)), folder: (id, sessionId = owner) => join(rootDir, hash(sessionId), id) };
}

test('private upload metadata omits paths and session tokens; images and documents use honest native inputs', async t => {
  const f = await fixture(t), image = await f.store.upload(owner, { name: '截图.png', mimeType: 'image/png', body: png });
  const document = await f.store.upload(owner, { name: '说明.pdf', mimeType: 'application/pdf', body: Buffer.from('%PDF-1.7\nfixture') });
  assert.match(image.id, /^[a-f0-9]{48}$/); assert.equal(image.kind, 'image'); assert.equal(document.kind, 'file');
  assert.deepEqual(Object.keys(image).sort(), ['createdAt', 'id', 'kind', 'mimeType', 'name', 'size']); assert.equal(JSON.stringify(image).includes(f.rootDir), false);
  const result = await f.store.resolve([image.id, document.id], { sessionId: owner, threadId: 'thread-1', cwd: '/project' });
  assert.deepEqual(result.attachments, [image, document]); assert.deepEqual(result.input.map(value => value.type), ['text', 'localImage']);
  assert.match(result.input[0].text, /截图\.png/); assert.match(result.input[0].text, /说明\.pdf/);
  const imagePath = result.input[1].path; assert.equal(dirname(imagePath), f.folder(image.id)); assert.equal(await fs.readFile(imagePath).then(value => value.equals(png)), true);
  const stored = await fs.readFile(join(f.folder(image.id), 'metadata.json'), 'utf8'); assert.equal(stored.includes(owner), false); assert.equal(stored.includes(hash(owner)), true);
  if (process.platform !== 'win32') {
    for (const path of [f.rootDir, f.ownerDir(owner), f.folder(image.id)]) assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
    for (const path of [imagePath, join(f.folder(image.id), 'metadata.json')]) assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  }
});

test('ordinary office and UTF-8 code files remain files; extensions and lightweight signatures are verified', async t => {
  const f = await fixture(t);
  for (const name of ['data.docx', 'table.xlsx', 'slides.pptx']) assert.equal((await f.store.upload(owner, { name, body: Buffer.from([80, 75, 3, 4, 0, 0]) })).kind, 'file');
  assert.equal((await f.store.upload(owner, { name: '代码.py', body: Buffer.from('print("你好")\n') })).mimeType, 'text/plain');
  for (const [name, bytes] of [['not-image.png', Buffer.from('%PDF-fixture')], ['not-pdf.pdf', png], ['not-office.docx', Buffer.from('plain')], ['binary.txt', Buffer.from([0, 1, 2])], ['invalid.txt', Buffer.from([0xc3, 0x28])]]) await assert.rejects(f.store.upload(owner, { name, body: bytes }), { code: 'attachment_content' });
  for (const name of ['program.exe', 'archive.zip', 'vector.svg']) await assert.rejects(f.store.upload(owner, { name, body: png }), { code: 'attachment_type' });
  assert.ok(ATTACHMENT_ACCEPT.includes('.pdf')); assert.ok(ATTACHMENT_ACCEPT.includes('.png')); assert.equal(ATTACHMENT_ACCEPT.includes('.exe'), false);
});

test('common research sequence and structure files use the same UTF-8 file contract', async t => {
  const f = await fixture(t);
  for (const extension of ['fasta', 'fa', 'faa', 'fna', 'pdb', 'cif', 'a3m', 'sto', 'aln']) {
    const value = await f.store.upload(owner, { name: `research.${extension}`, body: Buffer.from('>sequence\nACDEFG\n') });
    assert.equal(value.kind, 'file'); assert.equal(value.mimeType, 'text/plain'); assert.ok(ATTACHMENT_ACCEPT.includes(`.${extension}`));
  }
  await assert.rejects(f.store.upload(owner, { name: 'binary.pdb', body: Buffer.from([0, 1, 2]) }), { code: 'attachment_content' });
});

test('browser path traversal, manifest injection, invalid ids and cross-session access cannot select filesystem paths', async t => {
  const f = await fixture(t);
  for (const name of ['../escape.txt', '..\\escape.txt', '/tmp/escape.txt', 'C:escape.txt', 'bad\nname.txt', 'bad\0name.txt']) await assert.rejects(f.store.upload(owner, { name, body: Buffer.from('x') }), { code: 'attachment_name' });
  const uploaded = await f.store.upload(owner, { name: 'quoted"name.txt', body: Buffer.from('context') });
  await assert.rejects(f.store.resolve([uploaded.id], { sessionId: peer, threadId: 'thread-1' }), { code: 'attachment_unavailable' });
  await assert.rejects(f.store.cancel(uploaded.id, { sessionId: peer }), { code: 'attachment_unavailable' });
  await assert.rejects(f.store.resolve(['/etc/passwd'], { sessionId: owner, threadId: 'thread-1' }), { code: 'attachment_ids' });
  const result = await f.store.resolve([uploaded.id], { sessionId: owner, threadId: 'thread-1' });
  const encoded = JSON.parse(result.input[0].text.split('\n')[1]); assert.equal(encoded.name, 'quoted"name.txt'); assert.ok(encoded.path.startsWith(f.rootDir));
});

test('authentication is enforced again after queued work and upload completion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.upload('anonymous', { name: 'x.txt', body: Buffer.from('x') }), { code: 'session_required' });
  const noAuth = await createAttachmentStore({ rootDir: join(f.parent, 'deny-default') });
  await assert.rejects(noAuth.upload(owner, { name: 'x.txt', body: Buffer.from('x') }), { code: 'session_required' });
  async function* revoked() { yield Buffer.from('partial'); f.sessions.delete(owner); yield Buffer.from('body'); }
  await assert.rejects(f.store.upload(owner, { name: 'x.txt', body: revoked() }), { code: 'session_required' });
  assert.deepEqual(await fs.readdir(f.ownerDir(owner)), []);
});

test('empty, oversized, aborted and failed streams remove their partial private files and suppress raw diagnostics', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.upload(owner, { name: 'x.txt', body: Buffer.alloc(0) }), { code: 'attachment_empty' });
  await assert.rejects(f.store.upload(owner, { name: 'x.txt', body: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1, 120) }), { code: 'attachment_size' });
  const abort = new AbortController();
  async function* cancelled() { yield Buffer.from('first'); abort.abort(); yield Buffer.from('second'); }
  await assert.rejects(f.store.upload(owner, { name: 'x.txt', body: cancelled(), signal: abort.signal }), { code: 'attachment_cancelled' });
  async function* failed() { yield Buffer.from('first'); throw Error('PRIVATE_FIXTURE_SECRET /private/user/path'); }
  await assert.rejects(f.store.upload(owner, { name: 'x.txt', body: failed() }), error => error.code === 'attachment_upload_failed' && !JSON.stringify(error).includes('PRIVATE_FIXTURE_SECRET') && !error.message.includes('/private/user/path'));
  assert.deepEqual(await fs.readdir(f.ownerDir(owner)), []);
});

test('an aborted stalled HTTP-style stream is interrupted and cleans its partial upload', async t => {
  const f = await fixture(t), stream = new PassThrough(), abort = new AbortController();
  let reading; const started = new Promise(resolve => { reading = resolve; }), iterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = () => { reading(); return iterator(); };
  const result = f.store.upload(owner, { name: 'stalled.txt', body: stream, signal: abort.signal });
  const failure = assert.rejects(result, { code: 'attachment_cancelled' });
  stream.write('partial'); await started;
  abort.abort(); await failure;
  assert.equal(stream.destroyed, true); assert.deepEqual(await fs.readdir(f.ownerDir(owner)), []);
});

test('cancellation only deletes unused attachments; claimed files remain through close, restart, expiry and uncertain sends', async t => {
  const f = await fixture(t), unused = await f.store.upload(owner, { name: 'unused.txt', body: Buffer.from('unused') });
  assert.deepEqual(await f.store.cancel(unused.id, { sessionId: owner }), { cancelled: true }); await assert.rejects(fs.stat(f.folder(unused.id)), { code: 'ENOENT' });
  const used = await f.store.upload(owner, { name: 'used.txt', body: Buffer.from('used') }), context = { sessionId: owner, threadId: 'thread-1' };
  const first = await f.store.resolve([used.id], context); assert.deepEqual(await f.store.resolve([used.id], context), first);
  await assert.rejects(f.store.cancel(used.id, { sessionId: owner }), { code: 'attachment_referenced' });
  await assert.rejects(f.store.resolve([used.id], { ...context, threadId: 'another-thread' }), { code: 'attachment_scope' });
  f.store.close(); f.advance(ATTACHMENT_LIMITS.pendingTtlMs * 2);
  const reopened = await createAttachmentStore(f.options); assert.deepEqual(await reopened.cleanup(), { removed: 0 }); assert.deepEqual(await reopened.resolve([used.id], context), first);
  assert.equal((await fs.stat(f.folder(used.id))).isDirectory(), true);
});

test('maintenance expires only unreferenced uploads, including uploads whose login no longer exists', async t => {
  const f = await fixture(t), a = await f.store.upload(owner, { name: 'a.txt', body: Buffer.from('a') }), b = await f.store.upload(peer, { name: 'b.txt', body: Buffer.from('b') });
  f.advance(ATTACHMENT_LIMITS.pendingTtlMs + 1); f.sessions.clear();
  assert.deepEqual(await f.store.cleanup(), { removed: 2 });
  await assert.rejects(fs.stat(f.folder(a.id)), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.folder(b.id, peer)), { code: 'ENOENT' });
});

test('resolve validates the whole batch and model input before claiming anything', async t => {
  const f = await fixture(t), image = await f.store.upload(owner, { name: 'a.png', body: png }), context = { sessionId: owner, threadId: 'thread-1' };
  for (const ids of [[image.id, image.id], Array(6).fill(image.id), ['../file']]) await assert.rejects(f.store.resolve(ids, context), { code: 'attachment_ids' });
  await assert.rejects(f.store.resolve([image.id, 'a'.repeat(48)], context), { code: 'attachment_unavailable' });
  await assert.rejects(f.store.resolve([image.id], { ...context, validateInput(input, attachments) { assert.equal(input[1].type, 'localImage'); assert.equal(attachments[0].kind, 'image'); throw new RelayError(400, 'unsupported_modality', 'Selected model does not accept images'); } }), { code: 'unsupported_modality' });
  assert.deepEqual(await f.store.cancel(image.id, { sessionId: owner }), { cancelled: true });
  const text = await f.store.upload(owner, { name: 'a.txt', body: Buffer.from('a') });
  const result = await f.store.resolve([text.id], { ...context, validateInput(input) { input[0].text = '/etc/passwd'; } });
  assert.equal(result.input[0].text.includes('/etc/passwd'), false);
});

test('concurrent uploads cannot exceed the pending 50 MiB session quota', async t => {
  const f = await fixture(t), body = Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes, 120);
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => f.store.upload(owner, { name: `${index}.txt`, body })));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 5);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'attachment_quota');
  assert.equal((await fs.readdir(f.ownerDir(owner))).length, 5);
});

test('changed file content and filesystem links cannot redirect resolution outside the private store', async t => {
  const f = await fixture(t), value = await f.store.upload(owner, { name: 'a.txt', body: Buffer.from('original') }), path = join(f.folder(value.id), 'attachment.txt');
  await fs.writeFile(path, 'modified');
  await assert.rejects(f.store.resolve([value.id], { sessionId: owner, threadId: 'thread-1' }), { code: 'attachment_unavailable' });
  const external = join(f.parent, 'external.txt'); await fs.writeFile(external, 'external', { mode: 0o600 });
  await fs.unlink(path);
  try { await fs.symlink(external, path); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { await fs.link(external, path); } else throw error; }
  await assert.rejects(f.store.resolve([value.id], { sessionId: owner, threadId: 'thread-1' }), { code: 'attachment_store_unsafe' });
  assert.equal(await fs.readFile(external, 'utf8'), 'external');
});

test('a symlinked attachment root is refused without changing its target', async t => {
  const f = await fixture(t), target = join(f.parent, 'target'), link = join(f.parent, 'linked'); await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createAttachmentStore({ rootDir: link, authorizeSession: () => true }), { code: 'attachment_store_unsafe' });
  assert.deepEqual(await fs.readdir(target), []);
});
