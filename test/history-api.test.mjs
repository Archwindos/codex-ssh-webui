import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../src/server.mjs';
import { safeTurn, MAX_SAFE_TURN_ITEMS } from '../src/protocol.mjs';

const copy = value => structuredClone(value);
const message = index => ({ id: `item-${index}`, type: 'agentMessage', text: `message-${index}`, phase: 'commentary' });
class HistoryRpc extends EventEmitter {
  connected = false; ended = false; calls = []; cap = 100; turns = []; source = 'cli';
  async start() { this.connected = true; this.ended = false; }
  close() { this.connected = false; this.ended = true; }
  async call(method, params = {}) {
    this.calls.push({ method, params: copy(params) });
    if (method === 'project/list' || method === 'threadSection/list') return { data: [], nextCursor: null };
    if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
    const thread = { id: 'long-thread', cwd: this.cwd, name: 'Long history', source: this.source, projectId: null, section: null, status: { type: 'notLoaded' }, turns: [] };
    if (method === 'thread/list') return { data: params.archived ? [] : [thread], nextCursor: null };
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread }; }
    if (method === 'thread/turns/list') { assert.equal(params.itemsView, 'summary'); return { data: [...this.turns].reverse().slice(0, params.limit).map(turn => ({ id: turn.id, status: turn.status, items: [], itemsView: 'summary' })), nextCursor: null }; }
    if (method === 'thread/items/list') {
      assert.equal(params.sortDirection, 'desc'); assert.equal(params.turnId, undefined);
      this.beforeItems?.(params);
      if (this.itemPage) return this.itemPage(params);
      const entries = this.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse(), from = params.cursor ? Number(params.cursor.slice('native:'.length)) : 0;
      const size = Math.min(params.limit, this.cap), data = entries.slice(from, from + size);
      return { data: copy(data), nextCursor: from + size < entries.length ? `native:${from + size}` : null };
    }
    assert.fail(`Read-only history must not invoke ${method}`);
  }
}
async function fixture(t, configure = () => {}) {
  const folder = await mkdtemp(join(tmpdir(), 'relay-history-api-')), cwd = await realpath(folder), rpc = new HistoryRpc(); rpc.cwd = cwd; configure(rpc);
  const relay = await createRelay({ mock: true, port: 0, rpc, config: { transport: 'local', sharedDaemonSocket: '/test/native.sock', projects: [{ id: 'seed', name: 'Seed', cwd }], workspace: { roots: [cwd], defaultCwd: cwd } }, archiveStoreFile: null, overviewCollector: async () => ({ agents: [], metrics: {} }) });
  t.after(async () => { await relay.close(); await rm(folder, { recursive: true, force: true }); });
  let cookie = '';
  const request = async path => {
    const response = await fetch(relay.origin + path, { headers: cookie ? { Cookie: cookie } : {} });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request('/api/session')).status, 200);
  return { relay, rpc, request };
}

test('a single turn with over 1000 items preserves middle and tail messages across bounded latest-200 web pages', async t => {
  const f = await fixture(t, rpc => { rpc.turns = [{ id: 'long-turn', status: 'completed', items: Array.from({ length: 1205 }, (_, i) => message(i)) }]; });
  let page = await f.request('/api/history?thread=long-thread'); assert.equal(page.status, 200); assert.equal(page.data.pagingMode, 'items'); assert.equal(page.data.itemCount, 200);
  assert.equal(page.data.turns[0].items[0].id, 'item-1005'); assert.equal(page.data.turns[0].items.at(-1).text, 'message-1204');
  assert.equal(f.rpc.calls.filter(call => call.method === 'thread/items/list').length, 2, 'native cap 100 requires exactly two bounded reads');
  const all = [...page.data.turns[0].items], cursorTokens = new Set();
  while (page.data.nextCursor) {
    assert.ok(!page.data.nextCursor.startsWith('native:')); assert.ok(!cursorTokens.has(page.data.nextCursor)); cursorTokens.add(page.data.nextCursor);
    const before = f.rpc.calls.length;
    page = await f.request(`/api/history?thread=long-thread&cursor=${page.data.nextCursor}`); assert.equal(page.status, 200); assert.ok(page.data.itemCount <= 200);
    assert.equal(f.rpc.calls.slice(before).some(call => call.method === 'thread/list'), false, 'continuations do not rescan the conversation library');
    all.unshift(...page.data.turns.flatMap(turn => turn.items));
  }
  assert.equal(all.length, 1205); assert.equal(new Set(all.map(item => item.id)).size, 1205);
  for (const index of [0, 499, 500, 700, 1000, 1204]) assert.equal(all[index].text, `message-${index}`);
  for (const call of f.rpc.calls.filter(call => call.method === 'thread/items/list')) assert.ok(call.params.limit >= 1 && call.params.limit <= 200);
});

test('old turns outside the recent summary retain unknown status and item cursors cannot cross threads or cursor kinds', async t => {
  const f = await fixture(t, rpc => { rpc.turns = Array.from({ length: 25 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: Array.from({ length: 10 }, (_, j) => message(i * 10 + j)) })); });
  const first = await f.request('/api/history?thread=long-thread'); assert.equal(first.status, 200); assert.equal(first.data.itemCount, 200);
  const older = await f.request(`/api/history?thread=long-thread&cursor=${first.data.nextCursor}`); assert.equal(older.status, 200); assert.equal(older.data.itemCount, 50); assert.ok(older.data.turns.every(turn => turn.status === 'unknown'));
  assert.equal((await f.request(`/api/history?thread=other-thread&cursor=${first.data.nextCursor}`)).status, 400);
  assert.equal((await f.request('/api/history?thread=long-thread&cursor=native:200')).status, 400);
});

test('request-start and response-end event watermarks expose events arriving during item reads', async t => {
  const f = await fixture(t, rpc => { rpc.turns = [{ id: 'long-turn', status: 'inProgress', items: [message(0)] }]; });
  f.relay.state.authorizedThreads.set('long-thread', f.rpc.cwd);
  const before = f.relay.state.events.at(-1)?.id || 0;
  f.rpc.beforeItems = () => {
    f.rpc.beforeItems = null;
    f.rpc.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'long-thread', turnId: 'long-turn', itemId: 'item-0', delta: 'new text' } });
  };
  const page = await f.request('/api/history?thread=long-thread'); assert.equal(page.status, 200); assert.equal(page.data.eventCursor, before);
  assert.ok(page.data.eventCursorEnd > page.data.eventCursor);
  const replay = await f.request(`/api/poll?cursor=${page.data.eventCursor}&wait=0`); assert.ok(replay.data.events.some(event => event.data.params?.delta === 'new text'));
});

test('malformed item pages, repeated cursors, overlapping identities and native read-budget exhaustion fail explicitly', async t => {
  const cases = [
    () => ({ data: Array.from({ length: 201 }, (_, i) => ({ turnId: 'long-turn', item: message(i) })), nextCursor: null }),
    () => ({ data: [{ turnId: 'long-turn', item: null }], nextCursor: null }),
    () => ({ data: [{ turnId: 'long-turn', item: message(1) }, { turnId: 'long-turn', item: message(1) }], nextCursor: null }),
    params => ({ data: Array.from({ length: 100 }, (_, i) => ({ turnId: 'long-turn', item: message(i + (params.cursor ? 99 : 0)) })), nextCursor: params.cursor ? null : 'native:100' }),
    () => ({ data: [{ turnId: 'long-turn', item: message(1) }], nextCursor: 'loop' }),
    (() => { let n = 0; return () => ({ data: [{ turnId: 'long-turn', item: message(++n) }], nextCursor: n % 2 ? 'cycle-a' : 'cycle-b' }); })(),
    (() => { let n = 0; return () => ({ data: [{ turnId: 'long-turn', item: message(++n) }], nextCursor: `native:${n}` }); })()
  ];
  for (const itemPage of cases) {
    const f = await fixture(t, rpc => { rpc.turns = [{ id: 'long-turn', status: 'completed', items: [] }]; rpc.itemPage = itemPage; });
    const page = await f.request('/api/history?thread=long-thread'); assert.equal(page.status, 502); assert.ok(['protocol_mismatch', 'history_pagination_incomplete'].includes(page.data.error.code));
    assert.ok(f.rpc.calls.filter(call => call.method === 'thread/items/list').length <= 4); assert.equal(f.rpc.connected, true);
  }
});

test('safeTurn never silently drops the 501st item and reports explicit count, shape and byte limits', () => {
  const items = Array.from({ length: 1205 }, (_, i) => message(i)), turn = safeTurn({ id: 'long-turn', status: 'completed', items });
  assert.equal(turn.items.length, 1205); assert.equal(turn.items[700].text, 'message-700'); assert.equal(turn.items.at(-1).text, 'message-1204');
  assert.throws(() => safeTurn({ items: Array.from({ length: MAX_SAFE_TURN_ITEMS + 1 }, (_, i) => message(i)) }), { code: 'history_limit' });
  assert.throws(() => safeTurn({ items: {} }), { code: 'protocol_mismatch' });
  assert.throws(() => safeTurn({ items: Array.from({ length: 900 }, (_, i) => ({ ...message(i), text: 'x'.repeat(20000) })) }), { code: 'history_limit' });
});

test('oversized sanitized item pages and huge lifecycle payloads remain bounded without discarding task state', async t => {
  const f = await fixture(t, rpc => {
    rpc.turns = [{ id: 'long-turn', status: 'completed', items: [] }];
    rpc.itemPage = () => ({ data: Array.from({ length: 10 }, (_, i) => ({ turnId: 'long-turn', item: { id: `file-${i}`, type: 'fileChange', changes: Array.from({ length: 100 }, () => ({ path: '/x', kind: 'update', diff: 'x'.repeat(20000) })) } })), nextCursor: null });
  });
  const page = await f.request('/api/history?thread=long-thread'); assert.equal(page.status, 413); assert.equal(page.data.error.code, 'history_limit');
  f.relay.state.authorizedThreads.set('long-thread', f.rpc.cwd); f.relay.state.activeTurns.set('long-thread', 'long-turn');
  f.rpc.emit('notification', { method: 'turn/completed', params: { threadId: 'long-thread', turn: { id: 'long-turn', status: 'completed', items: Array.from({ length: 12000 }, (_, i) => message(i)) } } }); await delay(5);
  const event = f.relay.state.events.find(event => event.data.method === 'turn/completed'); assert.ok(event); assert.deepEqual(event.data.params.turn.items, []); assert.equal(event.data.params.turn.itemsView, 'notLoaded'); assert.equal(f.relay.state.activeTurns.has('long-thread'), false); assert.equal(f.rpc.connected, true);
});
