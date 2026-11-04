import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../src/server.mjs';
import { createComposer, readRolloutTokenUsage } from '../src/composer.mjs';
import { safeItem } from '../src/protocol.mjs';

const copy = value => structuredClone(value);
const breakdown = number => ({ totalTokens: number, inputTokens: number - 5, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 });
const usage = number => ({ last: breakdown(number), total: breakdown(1000000), modelContextWindow: 1000 });
const tokenLine = number => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: number, input_tokens: number - 5, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }, total_token_usage: { total_tokens: 1000000, input_tokens: 999995, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 }, model_context_window: 1000 } } });
class ComposerRpc extends EventEmitter {
  connected = false; ended = false; calls = []; currentModel = 'native-b'; currentEffort = 'high'; status = 'idle';
  async start() { this.connected = true; this.ended = false; }
  close() { this.connected = false; this.ended = true; }
  metadata() { return { id: 'one', cwd: this.cwd, name: 'One', source: 'cli', projectId: null, section: null, model: this.currentModel, reasoningEffort: this.currentEffort, status: { type: this.status }, turns: [], ...(this.path ? { path: this.path } : {}) }; }
  async call(method, params = {}) {
    this.calls.push({ method, params: copy(params) });
    if (method === 'thread/loaded/list') return { data: ['one'], nextCursor: null };
    if (method === 'project/list' || method === 'threadSection/list') return { data: [], nextCursor: null };
    if (method === 'thread/list') return { data: params.archived ? [] : [this.metadata()], nextCursor: null };
    if (method === 'thread/read') return { thread: { ...this.metadata(), ...(params.threadId === 'outside' ? { id: 'outside', cwd: tmpdir(), path: '/private/outside.jsonl' } : {}) } };
    if (method === 'thread/resume') return { thread: this.metadata(), model: this.currentModel, reasoningEffort: this.currentEffort, approvalPolicy: { granular: { custom: true } }, activePermissionProfile: { id: ':custom' } };
    if (method === 'thread/start') return { thread: { ...this.metadata(), id: 'new-thread' }, model: this.currentModel, reasoningEffort: this.currentEffort };
    if (method === 'thread/turns/list') return { data: this.status === 'active' ? [{ id: 'live-turn', status: 'inProgress', items: [] }] : [], nextCursor: null };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'config/read') return { config: { model: 'native-b', model_reasoning_effort: 'high', instructions: 'PRIVATE_CONFIG' }, origins: { private: 'PRIVATE_CONFIG' } };
    if (method === 'model/list') return { data: ['native-a', 'native-b'].map((model, i) => ({ id: `picker-${i}`, model, displayName: `Model ${i}`, description: 'Native choice', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), isDefault: i === 0, hidden: false, inputModalities: i === 0 ? ['text'] : ['text', 'image'] })), nextCursor: null };
    if (method === 'permissionProfile/list') return { data: [{ id: ':workspace', allowed: true, description: 'Native workspace' }, { id: ':denied', allowed: false, description: 'Unavailable' }], nextCursor: null };
    if (method === 'turn/start') {
      if (params.model) this.currentModel = params.model; if (params.effort) this.currentEffort = params.effort;
      this.status = 'active'; const turn = { id: 'live-turn', status: 'inProgress', items: [{ id: 'user-1', type: 'userMessage', content: params.input }] };
      this.emit('notification', { method: 'turn/started', params: { threadId: 'one', turn } }); return { turn };
    }
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    assert.fail(`Unexpected composer RPC ${method}`);
  }
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'relay-composer-'))), rpc = new ComposerRpc(); rpc.cwd = root;
  const relay = await createRelay({ mock: true, port: 0, rpc, config: { transport: 'local', sharedDaemonSocket: join(root, 'daemon.sock'), workspace: { roots: [root], defaultCwd: root }, projects: [{ id: 'seed', name: 'Seed', cwd: root }] }, attachmentStoreDir: join(root, 'attachments'), archiveStoreFile: null });
  t.after(async () => { await relay.close(); await fs.rm(root, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '', csrf = '';
    return async (path, body, headers = {}) => {
      const response = await fetch(relay.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: relay.origin, 'X-CSRF-Token': csrf, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]; const data = await response.json(); if (data.csrf) csrf = data.csrf; return { status: response.status, data };
    };
  };
  const request = client(), session = await request('/api/session'); assert.equal(session.status, 200);
  return { root, rpc, relay, request, client, session };
}
const input = (extra = {}) => ({ threadId: 'one', submissionId: 'submit-1', text: 'Task', ...extra });
const starts = rpc => rpc.calls.filter(call => call.method === 'turn/start');

test('composer lists real account models/defaults and current native thread values without leaking config', async t => {
  const f = await fixture(t), models = await f.request('/api/models'); assert.equal(models.status, 200); assert.deepEqual(models.data.defaults, { model: 'native-b', reasoningEffort: 'high' }); assert.equal(models.data.catalogDefault.model, 'native-a'); assert.equal(models.data.models[0].model, 'native-a'); assert.doesNotMatch(JSON.stringify(models.data), /PRIVATE_CONFIG/);
  const context = await f.request('/api/thread-context?thread=one'); assert.equal(context.status, 200); assert.equal(context.data.model, 'native-b'); assert.equal(context.data.reasoningEffort, 'high'); assert.equal(context.data.tokenUsage, null); assert.equal(context.data.context, null);
  const profiles = await f.request('/api/permission-profiles?thread=one'); assert.deepEqual(profiles.data.profiles.map(profile => [profile.id, profile.allowed]), [[':workspace', true], [':denied', false]]);
  for (const path of ['/api/thread-context', '/api/models', '/api/permission-profiles']) assert.equal((await f.request(`${path}?thread=outside`)).status, 403);
  assert.equal(starts(f.rpc).length, 0); assert.ok(f.rpc.calls.every(call => !call.method.includes('/write') && call.method !== 'thread/settings/update'));
});

test('selected model/effort/native permission profile affect only turn parameters and bind submission idempotency', async t => {
  const f = await fixture(t), body = input({ model: 'native-a', reasoningEffort: 'low', permissions: ':workspace' });
  const [one, duplicate] = await Promise.all([f.request('/api/turns', body), f.request('/api/turns', body)]); assert.equal(one.status, 200); assert.equal(duplicate.status, 200); assert.equal(starts(f.rpc).length, 1);
  const params = starts(f.rpc)[0].params; assert.equal(params.model, 'native-a'); assert.equal(params.effort, 'low'); assert.equal(params.permissions, ':workspace'); assert.equal(params.approvalPolicy, undefined); assert.equal(params.sandboxPolicy, undefined);
  assert.equal(one.data.thread.model, 'native-a'); assert.equal(one.data.thread.reasoningEffort, 'low');
  assert.equal((await f.request('/api/turns', { ...body, reasoningEffort: 'high' })).status, 409); assert.equal(starts(f.rpc).length, 1);
  for (const call of f.rpc.calls.filter(call => call.method === 'thread/resume')) { assert.equal(call.params.approvalPolicy, undefined); assert.equal(call.params.sandbox, undefined); }
});

test('inherit preserves native custom defaults; rejected selections and steer settings never send an execution request', async t => {
  const f = await fixture(t);
  for (const fields of [{ model: 'made-up' }, { reasoningEffort: 'made-up' }, { permissions: ':denied' }]) { const result = await f.request('/api/turns', input({ ...fields, submissionId: JSON.stringify(fields).replace(/[^A-Za-z]/g, '') })); assert.ok([400, 403].includes(result.status)); }
  assert.equal(starts(f.rpc).length, 0);
  assert.equal((await f.request('/api/turns', input())).status, 200);
  const params = starts(f.rpc)[0].params; for (const key of ['model', 'effort', 'permissions', 'approvalPolicy', 'sandboxPolicy']) assert.equal(params[key], undefined);
  const steer = { threadId: 'one', turnId: 'live-turn', text: 'Extra', submissionId: 'extra' };
  assert.equal((await f.request('/api/steer', { ...steer, model: 'native-a' })).status, 400); assert.equal((await f.request('/api/steer', { ...steer, permissions: ':workspace' })).status, 400);
  assert.equal((await f.request('/api/steer', steer)).status, 200); assert.equal(f.rpc.calls.filter(call => call.method === 'turn/steer').length, 1);
  const fresh = await fixture(t); assert.equal((await fresh.request('/api/threads', {})).status, 200); const start = fresh.rpc.calls.find(call => call.method === 'thread/start'); assert.equal(start.params.approvalPolicy, undefined); assert.equal(start.params.sandbox, undefined);
});

test('real last token usage drives context; malformed values do not replace it and disconnect invalidates live cache', async t => {
  const f = await fixture(t); f.rpc.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: 'one', turnId: 'live-turn', tokenUsage: usage(120) } }); await delay(5);
  const context = await f.request('/api/thread-context?thread=one'); assert.deepEqual(context.data.context, { used: 120, max: 1000 }); assert.equal(context.data.tokenUsage.total.totalTokens, 1000000);
  f.rpc.emit('notification', { method: 'thread/tokenUsage/updated', params: { threadId: 'one', turnId: 'live-turn', tokenUsage: usage(-5) } }); await delay(5); assert.equal((await f.request('/api/thread-context?thread=one')).data.context.used, 120);
  f.rpc.connected = false; f.rpc.ended = true; f.rpc.emit('closed'); assert.equal((await f.request('/api/connect', {})).status, 200); assert.equal((await f.request('/api/thread-context?thread=one')).data.tokenUsage, null);
});

test('binary attachment uploads are owner scoped and attachment-only turns preserve names while hiding native paths', async t => {
  const f = await fixture(t), upload = await f.request('/api/attachments', Buffer.from('research data'), { 'X-Attachment-Name': encodeURIComponent('研究.csv'), 'X-Attachment-Type': 'text/csv' }); assert.equal(upload.status, 201); assert.equal(upload.data.attachment.name, '研究.csv'); assert.doesNotMatch(JSON.stringify(upload.data), /attachment\.csv|sessionId|rootDir/);
  const peer = f.client(); await peer('/api/session'); const stolen = await peer('/api/turns', input({ submissionId: 'peer-submit', text: '', attachmentIds: [upload.data.attachment.id] })); assert.equal(stolen.status, 404); assert.equal(starts(f.rpc).length, 0);
  const body = input({ text: '', attachmentIds: [upload.data.attachment.id] }), result = await f.request('/api/turns', body); assert.equal(result.status, 200); assert.equal(starts(f.rpc).length, 1); assert.equal(starts(f.rpc)[0].params.input[0].type, 'text'); assert.match(starts(f.rpc)[0].params.input[0].text, /研究.csv/);
  assert.deepEqual(result.data.turn.items[0].attachments, [{ name: '研究.csv', mimeType: 'text/plain', size: 13 }]); assert.doesNotMatch(JSON.stringify(result.data), /attachment\.csv|rootDir/);
  assert.equal((await f.request('/api/turns', body)).data.duplicate, true); assert.equal(starts(f.rpc).length, 1); assert.equal((await f.request('/api/attachments/cancel', { attachmentId: upload.data.attachment.id })).status, 409);
  assert.equal((await peer('/api/turns', body)).status, 404, 'a duplicate lookup cannot bypass attachment ownership'); assert.equal(starts(f.rpc).length, 1);
});

test('unsupported image model fails before retaining the file, so it remains cancellable', async t => {
  const f = await fixture(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const upload = await f.request('/api/attachments', png, { 'X-Attachment-Name': 'image.png', 'X-Attachment-Type': 'image/png' }); assert.equal(upload.status, 201);
  const result = await f.request('/api/turns', input({ text: '', model: 'native-a', attachmentIds: [upload.data.attachment.id] })); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'model_image_unsupported'); assert.equal(starts(f.rpc).length, 0); assert.equal((await f.request('/api/attachments/cancel', { attachmentId: upload.data.attachment.id })).status, 200);
});

test('rollout context fallback is tail bounded, rejects unsafe paths and yields to fresh native events', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'composer-rollout-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = join(root, 'sessions', '2026', '11', '04'); await fs.mkdir(folder, { recursive: true }); const path = join(folder, 'rollout.jsonl'); await fs.writeFile(path, `${'x'.repeat(1024 * 1024 + 100)}\n${tokenLine(200)}\n`); const owner = (await fs.stat(path)).uid;
  let bytesRequested = 0;
  const filesystem = { ...fs, async open(...args) { const handle = await fs.open(...args); return { stat: () => handle.stat(), close: () => handle.close(), read: (buffer, offset, length, position) => { bytesRequested += length; return handle.read(buffer, offset, length, position); } }; } };
  const options = { codexHome: root, filesystem, uid: () => owner }, first = await readRolloutTokenUsage({ path, ...options }); assert.equal(first.last.totalTokens, 200); assert.ok(bytesRequested <= 1024 * 1024);
  assert.equal(await readRolloutTokenUsage({ path, ...options, uid: () => owner + 1 }), null); assert.equal(await readRolloutTokenUsage({ path: join(root, 'private.jsonl'), ...options }), null);
  const symlinkFS = { ...filesystem, async lstat(target) { const info = await fs.lstat(target); if (target === folder) return { ...info, isSymbolicLink: () => true }; return info; } }; assert.equal(await readRolloutTokenUsage({ path, ...options, filesystem: symlinkFS }), null);
  const composer = createComposer({ rpc: {}, ...options }), thread = { id: 'one', path, model: 'native-b', reasoningEffort: 'high' };
  assert.equal((await composer.readContext(thread)).context.used, 200); composer.tokenUsage('one', usage(100)); await fs.appendFile(path, `${tokenLine(300)}\n`); assert.equal((await composer.readContext(thread)).context.used, 100);
  composer.invalidate(); assert.equal((await composer.readContext(thread)).context.used, 300, 'disconnect/reconnect permits newer persisted B after live A');
  const normal = safeItem({ type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'Keep this ordinary text 用户上传的附件；bad JSON' }] }); assert.equal(normal.content[0].text, 'Keep this ordinary text 用户上传的附件；bad JSON');
});

test('metadata without a valid rollout path does not throttle the first raw-thread context read', async t => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'composer-metadata-context-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = join(root, 'sessions', '2026', '11', '04'); await fs.mkdir(folder, { recursive: true });
  const path = join(folder, 'rollout.jsonl'); await fs.writeFile(path, `${tokenLine(217)}\n`); const owner = (await fs.stat(path)).uid;
  let opens = 0;
  const filesystem = { ...fs, open(...args) { opens++; return fs.open(...args); } };
  const composer = createComposer({ rpc: {}, codexHome: root, filesystem, uid: () => owner, clock: () => 1000 });
  for (const path of [undefined, null, '', 'relative.jsonl', join(root, 'private.jsonl')]) assert.equal((await composer.readContext({ id: 'one', model: 'native-b', path })).context, null);
  assert.equal(opens, 0);
  const first = await composer.readContext({ id: 'one', model: 'native-b', path });
  assert.deepEqual(first.context, { used: 217, max: 1000 }); assert.equal(opens, 1, 'the first valid raw path is read immediately at the same clock time');
});
