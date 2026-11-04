import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createArchiveService } from '../src/library.mjs';
import { RelayError, THREAD_SOURCE_KINDS } from '../src/protocol.mjs';

const owner = 'owner-a';
const thread = (id, extra = {}) => ({ id, name: `Name ${id}`, cwd: '/workspace', source: 'cli', parentThreadId: null, forkedFromId: null, ...extra });
const child = (id, parent) => thread(id, { parentThreadId: parent, source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } });
const holder = (threadId, extra = {}) => ({ threadId, managed: true, runId: `run-${threadId}`, rootThreadId: threadId, pid: 100, status: 'idle', ...extra });
function fixture(initial = [thread('root'), child('child', 'root')], options = {}) {
  const rows = new Map(initial.map(row => [row.id, { ...row, archived: row.archived === true }]));
  const calls = [], phases = [], freezes = new Set();
  let observation = { complete: true, holders: [] }, time = 1000, archiveCount = 0, stoppedCount = 0, releasedCount = 0;
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'thread/list') {
      phases.push('list');
      let data = [...rows.values()].filter(row => (row.archived === true) === params.archived).sort((a, b) => a.id.localeCompare(b.id));
      if (params.ancestorThreadId) {
        const edges = options.spawnEdges || [...rows.values()].map(row => [row.parentThreadId || row.source?.subAgent?.thread_spawn?.parent_thread_id, row.id]);
        const ids = new Set(), queue = [params.ancestorThreadId];
        while (queue.length) { const parent = queue.shift(); for (const [from, id] of edges) if (from === parent && !ids.has(id)) { ids.add(id); queue.push(id); } }
        ids.delete(params.ancestorThreadId); data = data.filter(row => ids.has(row.id));
      }
      const offset = Number(params.cursor || 0), size = options.pageSize || 2;
      const result = { data: data.slice(offset, offset + size).map(row => { const { archived, ...raw } = row; return raw; }), nextCursor: offset + size < data.length ? String(offset + size) : null };
      return options.list ? options.list(params, result, { rows, archiveCount, phases }) : result;
    }
    assert.equal(method, 'thread/archive', 'the library never starts or resumes a conversation or sends a prompt');
    archiveCount++; phases.push('archive');
    if (options.archive) return options.archive(params, rows);
    const ids = new Set([params.threadId]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows.values()) if (!ids.has(row.id) && ids.has(row.parentThreadId || row.source?.subAgent?.thread_spawn?.parent_thread_id)) { ids.add(row.id); changed = true; } }
    for (const id of ids) rows.get(id).archived = true;
    return {};
  } };
  const service = createArchiveService({ rpc, clock: () => time, authoritativeDescendants: options.authoritativeDescendants || false, storeFile: options.storeFile || null, filesystem: options.filesystem, inspectThreadStates: options.inspectThreadStates, atomicity: options.atomicity,
    async releaseFrozenThreads(ids, opId) { phases.push('releaseRestored'); releasedCount++; await options.releaseRestored?.(ids, opId); for (const id of ids) freezes.delete(id); },
    async inspectWriters(ids) { phases.push('inspect'); return options.inspect ? options.inspect(ids, observation) : observation; },
    async freezeThreads(ids, opId) {
      await options.onFreeze?.(ids, opId);
      phases.push('freeze'); for (const id of ids) { assert.ok(!freezes.has(id)); freezes.add(id); }
      return { async release() { phases.push('release'); releasedCount++; await options.release?.(ids, opId); for (const id of ids) freezes.delete(id); } };
    },
    async stopManagedRuns(ids, context) {
      phases.push('stop'); stoppedCount++;
      assert.ok(ids.every(id => freezes.has(id)), 'all confirmed threads freeze before stopping any managed run');
      if (options.stop) return options.stop(ids, context, { rows, setObservation: value => { observation = value; } });
      const receipts = observation.holders.map(h => ({ runId: h.runId, rootThreadId: h.rootThreadId, status: 'stopped' }));
      observation = { complete: true, holders: [] }; return { complete: true, receipts };
    }
  });
  return { service, rows, calls, phases, freezes, setObservation: value => { observation = value; }, advance: ms => { time += ms; }, get archiveCount() { return archiveCount; }, get stoppedCount() { return stoppedCount; }, get releasedCount() { return releasedCount; } };
}

async function store(t) {
  const base = await fs.mkdtemp(join(tmpdir(), 'relay-archive-library-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return join(base, 'private', 'archive-operations.json');
}

test('preview lists the complete spawn cascade across active and archived pages, while forks remain separate', async () => {
  const f = fixture([thread('root'), child('a', 'root'), child('b', 'a'), thread('fork', { forkedFromId: 'root' }), child('old', 'root')]);
  f.rows.get('old').archived = true;
  f.setObservation({ complete: true, holders: [holder('a')] });
  const preview = await f.service.preview('root', owner);
  assert.equal(preview.canArchive, true); assert.equal(preview.requiresConfirmation, true); assert.ok(preview.planId);
  assert.deepEqual(preview.affected.map(row => row.id).sort(), ['a', 'b', 'old', 'root']);
  assert.equal(preview.affected.find(row => row.id === 'old').archived, true);
  assert.equal(preview.affected.find(row => row.id === 'a').writers[0].runId, 'run-a');
  assert.equal(f.archiveCount, 0); assert.equal(f.stoppedCount, 0); assert.equal(f.freezes.size, 0);
  assert.ok(f.calls.length >= 3, 'active and archived pages must both be consumed');
  for (const call of f.calls) { assert.equal(call.method, 'thread/list'); assert.deepEqual(call.params.sourceKinds, THREAD_SOURCE_KINDS); assert.equal('cwd' in call.params, false); assert.equal('useStateDbOnly' in call.params, false); }
});

test('authoritative archive inventory and ancestor queries both use the native state DB without weakening duplicate checks', async () => {
  const f = fixture(undefined, { authoritativeDescendants: true, list(params, result) {
    // Scan-and-repair listing can repeat a row already returned from the DB.
    return params.useStateDbOnly ? result : { ...result, data: [...result.data, result.data[0]].filter(Boolean) };
  } });
  const preview = await f.service.preview('root', owner); assert.equal(preview.canArchive, true);
  assert.ok(f.calls.some(call => call.method === 'thread/list' && !call.params.ancestorThreadId)); assert.ok(f.calls.some(call => call.params.ancestorThreadId === 'root'));
  const result = await f.service.execute(preview.planId, owner); assert.equal(result.status, 'complete');
  for (const call of f.calls.filter(call => call.method === 'thread/list')) assert.equal(call.params.useStateDbOnly, true);
  const conflicting = fixture(undefined, { authoritativeDescendants: true, list(params, result) { return result.data.length ? { ...result, data: [...result.data, result.data[0]] } : result; } });
  const blocked = await conflicting.service.preview('root', owner); assert.equal(blocked.canArchive, false); assert.equal(blocked.blockedReasons[0].code, 'archive_inventory_changed'); assert.equal(conflicting.archiveCount, 0);
});
test('authoritative null parent establishes custom-source roots without inventing unrelated descendants', async () => {
  const f = fixture([thread('root', { source: { custom: 'phone-client' } }), child('child', 'root'), thread('unrelated', { source: 'unknown' })]);
  const preview = await f.service.preview('root', owner);
  assert.equal(preview.canArchive, true); assert.deepEqual(preview.affected.map(row => row.id).sort(), ['child', 'root']);
  const result = await f.service.execute(preview.planId, owner); assert.equal(result.status, 'complete'); assert.equal(f.rows.get('unrelated').archived, false);
});

test('shared unknown receipts restore gateway admission freezes after reconstruction and recheck remains read only', async t => {
  const storeFile = await store(t), inspectThreadStates = async ids => ({ complete: true, states: ids.map(threadId => ({ threadId, status: 'notLoaded', fingerprint: 'a'.repeat(64) })) });
  const options = { storeFile, authoritativeDescendants: true, atomicity: 'gateway-admission-only', inspectThreadStates };
  const first = fixture(undefined, { ...options, archive() { throw new RelayError(504, 'rpc_timeout', 'Unknown archive outcome'); } });
  const preview = await first.service.preview('root', owner), result = await first.service.execute(preview.planId, owner);
  assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true); assert.equal(await first.service.isFrozen('child'), true);
  let dispatched = false;
  await assert.rejects(first.service.admit('child', () => { dispatched = true; }), { code: 'thread_frozen' }); assert.equal(dispatched, false);
  const restored = fixture([...first.rows.values()], options); await restored.service.ready;
  assert.equal(await restored.service.isFrozen('root'), true); assert.equal(await restored.service.isFrozen('child'), true);
  await assert.rejects(restored.service.admit('root', () => { dispatched = true; }), { code: 'thread_frozen' }); assert.equal(dispatched, false); assert.equal(restored.archiveCount, 0);
  for (const row of restored.rows.values()) row.archived = true;
  const checked = await restored.service.recheck(result.operationId, owner);
  assert.equal(checked.status, 'complete'); assert.equal(checked.atomicity, 'gateway-admission-only'); assert.equal(checked.freezeRetained, false); assert.equal(restored.archiveCount, 0);
  assert.equal(await restored.service.isFrozen('root'), false); assert.equal(await restored.service.admit('root', () => 'allowed'), 'allowed');
});

test('execute freezes the confirmed set, stops and verifies managed writers, rechecks the scope, archives once and verifies every ID', async () => {
  const f = fixture([thread('root'), child('child', 'root'), child('old', 'root')]); f.rows.get('old').archived = true;
  f.setObservation({ complete: true, holders: [holder('root'), holder('child', { pid: 101 })] });
  const preview = await f.service.preview('root', owner), start = f.phases.length;
  const [result, duplicate] = await Promise.all([f.service.execute(preview.planId, owner), f.service.execute(preview.planId, owner)]);
  assert.deepEqual(duplicate, result); assert.equal(result.status, 'complete'); assert.equal(result.freezeRetained, false);
  assert.deepEqual(result.affected.map(row => [row.id, row.status]), [['root', 'archived'], ['child', 'archived'], ['old', 'alreadyArchived']]);
  assert.equal(f.archiveCount, 1); assert.equal(f.stoppedCount, 1); assert.equal(f.releasedCount, 1);
  const phases = f.phases.slice(start), frozen = phases.indexOf('freeze'), stopped = phases.indexOf('stop'), archived = phases.indexOf('archive');
  assert.ok(frozen >= 0 && frozen < stopped && stopped < archived);
  assert.ok(phases.slice(stopped + 1, archived).includes('inspect'));
  assert.ok(phases.slice(stopped + 1, archived).includes('list'));
  assert.ok(phases.slice(archived + 1).includes('list'));
  assert.equal((await f.service.execute(preview.planId, owner)).status, 'complete'); assert.equal(f.archiveCount, 1);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/archive')[0].params, { threadId: 'root' });
});

test('archive returning an empty object is partial when a child remains active, with per-ID receipts and safe release', async () => {
  const f = fixture(undefined, { archive(params, rows) { rows.get(params.threadId).archived = true; return {}; } });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'partial'); assert.equal(result.freezeRetained, false);
  assert.deepEqual(result.affected.map(row => [row.id, row.status]), [['root', 'archived'], ['child', 'notArchived']]);
  assert.equal(f.archiveCount, 1); assert.equal(f.releasedCount, 1);
});

test('new descendants, changed identities and new managed run identities invalidate consent before archive', async () => {
  for (const change of [f => f.rows.set('new', child('new', 'child')), f => { f.rows.get('child').cwd = '/changed'; }, f => f.setObservation({ complete: true, holders: [holder('child')] })]) {
    const f = fixture(), p = await f.service.preview('root', owner); change(f);
    await assert.rejects(async () => f.service.execute(p.planId, owner), error => error.status === 409 && error.code === 'archive_plan_changed');
    assert.equal(f.archiveCount, 0); assert.equal(f.stoppedCount, 0); assert.equal(f.freezes.size, 0);
  }
});

test('a child spawned while stopping managed runs requires a new preview and is never silently archived', async () => {
  const f = fixture(undefined, { stop(ids, context, state) { state.rows.set('new-child', child('new-child', 'root')); return { complete: true, receipts: [] }; } });
  const p = await f.service.preview('root', owner);
  await assert.rejects(async () => f.service.execute(p.planId, owner), error => error.code === 'archive_plan_changed');
  assert.equal(f.archiveCount, 0); assert.equal(f.freezes.size, 0);
  assert.ok(!f.rows.get('new-child').archived);
});

test('external, unmapped or incomplete writer observations block preview and execution without stopping them', async () => {
  for (const observation of [{ complete: true, holders: [holder('child', { managed: false })] }, { complete: true, holders: [holder('child', { runId: null })] }, { complete: true, holders: [holder('child', { rootThreadId: null })] }, { complete: false, holders: [] }]) {
    const f = fixture(); f.setObservation(observation);
    const blocked = await f.service.preview('root', owner);
    assert.equal(blocked.canArchive, false); assert.equal(blocked.planId, null); assert.ok(blocked.blockedReasons.length);
    f.setObservation({ complete: true, holders: [] }); const p = await f.service.preview('root', owner); f.setObservation(observation);
    await assert.rejects(async () => f.service.execute(p.planId, owner), error => error.status === 409 && ['archive_external_writer', 'archive_writer_unknown'].includes(error.code));
    assert.equal(f.archiveCount, 0); assert.equal(f.stoppedCount, 0); assert.equal(f.freezes.size, 0);
  }
});

test('archiving a child cannot stop a managed runtime rooted in a parent outside the confirmed cascade', async () => {
  const f = fixture(); f.setObservation({ complete: true, holders: [holder('child', { rootThreadId: 'root' })] });
  const p = await f.service.preview('child', owner);
  assert.equal(p.canArchive, false); assert.equal(p.blockedReasons[0].code, 'archive_run_outside_scope');
  assert.equal(f.stoppedCount, 0); assert.equal(f.archiveCount, 0);
});

test('unknown relations, conflicting parents, missing parents, cycles and ephemeral threads refuse archive', async () => {
  const cases = [
    [thread('root'), thread('unknown', { source: 'unknown', parentThreadId: undefined })],
    [thread('root'), thread('child', { source: { subAgent: 'review' } })],
    [thread('root'), child('other-root', 'missing')],
    [thread('root'), { ...child('child', 'root'), parentThreadId: 'child' }],
    [child('root', 'child'), child('child', 'root')],
    [thread('root', { ephemeral: true })],
    [thread('root', { parentThreadId: '../invalid' })]
  ];
  for (const rows of cases) {
    const f = fixture(rows), p = await f.service.preview('root', owner);
    assert.equal(p.canArchive, false); assert.equal(p.planId, null); assert.ok(p.blockedReasons.length); assert.equal(f.archiveCount, 0);
  }
});

test('cursor loops, duplicate identities and bounded pagination failures do not turn incomplete inventories into archive plans', async () => {
  for (const list of [() => ({ data: [], nextCursor: 'loop' }), params => ({ data: [thread('root')], nextCursor: params.cursor ? null : 'next' }), () => ({ data: null, nextCursor: null })]) {
    const f = fixture(undefined, { list });
    const p = await f.service.preview('root', owner).catch(error => ({ canArchive: false, blockedReasons: [{ code: error.code }] }));
    assert.equal(p.canArchive, false); assert.equal(f.archiveCount, 0);
  }
  let pages = 0;
  const f = fixture(undefined, { list() { return { data: [], nextCursor: `cursor-${++pages}` }; } });
  assert.equal((await f.service.preview('root', owner)).canArchive, false); assert.equal(pages, 100);
});

test('missing verification IDs are unknown, remain frozen and recheck only reads before releasing the same operation', async () => {
  let hidden = true;
  const f = fixture(undefined, { list(params, result, state) { return state.archiveCount && hidden ? { ...result, data: result.data.filter(row => row.id !== 'child') } : result; } });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true);
  assert.equal(result.affected.find(row => row.id === 'child').status, 'unknown'); assert.equal(f.archiveCount, 1);
  const stopCount = f.stoppedCount; hidden = false;
  const checked = await f.service.recheck(result.operationId, owner);
  assert.equal(checked.status, 'complete'); assert.equal(checked.freezeRetained, false);
  assert.equal(f.archiveCount, 1); assert.equal(f.stoppedCount, stopCount); assert.equal(f.releasedCount, 1);
});

test('archive timeouts never retry and keep admission frozen until an exact recheck confirms the eventual archive', async () => {
  const f = fixture(undefined, { archive() { throw new RelayError(504, 'rpc_timeout', 'Timed out'); } });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true); assert.equal(f.archiveCount, 1);
  const stillUnknown = await f.service.recheck(result.operationId, owner);
  assert.equal(stillUnknown.status, 'unknown'); assert.equal(stillUnknown.freezeRetained, true);
  for (const row of f.rows.values()) row.archived = true;
  const checked = await f.service.recheck(result.operationId, owner);
  assert.equal(checked.status, 'complete'); assert.equal(checked.freezeRetained, false); assert.equal(f.archiveCount, 1);
  await f.service.execute(p.planId, owner); assert.equal(f.archiveCount, 1);
});

test('definite archive rejection is verified as failed, and a stopped run alone never counts as archive success', async () => {
  const f = fixture(undefined, { archive() { throw new RelayError(502, 'upstream_error', 'Rejected'); } });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'failed'); assert.ok(result.affected.every(row => row.status === 'notArchived'));
  assert.equal(result.freezeRetained, false); assert.equal(f.stoppedCount, 1); assert.equal(f.archiveCount, 1);
});

test('already archived cascades need no archive RPC, and incomplete post-archive scans cannot prove success', async () => {
  const archived = fixture([thread('root', { archived: true }), { ...child('child', 'root'), archived: true }]);
  const plan = await archived.service.preview('root', owner), result = await archived.service.execute(plan.planId, owner);
  assert.equal(result.status, 'complete'); assert.ok(result.affected.every(row => row.status === 'alreadyArchived')); assert.equal(archived.archiveCount, 0);
  const broken = fixture(undefined, { list(params, value, state) { if (state.archiveCount) throw Error('PRIVATE_METADATA_FAILURE'); return value; } });
  const p = await broken.service.preview('root', owner), unknown = await broken.service.execute(p.planId, owner);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.freezeRetained, true); assert.ok(unknown.affected.every(row => row.status === 'unknown'));
  assert.ok(!JSON.stringify(unknown).includes('PRIVATE_METADATA_FAILURE'));
});

test('writers appearing during the final subtree read prevent archive even after the managed stop completed', async () => {
  let f, stoppingFinished = false;
  f = fixture(undefined, {
    stop() { stoppingFinished = true; return { complete: true, receipts: [] }; },
    list(params, response) { if (stoppingFinished) f.setObservation({ complete: true, holders: [holder('child', { managed: false })] }); return response; }
  });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'unknown'); assert.equal(result.archiveAttempted, false); assert.equal(f.archiveCount, 0);
  assert.equal(result.freezeRetained, true); assert.ok(result.reports.some(report => report.phase === 'finalWriterCheck' && report.status === 'blocked'));
});

test('an unverified managed stop prevents archive, retaining the freeze until writers are proven gone', async () => {
  const f = fixture(undefined, { stop() { return { complete: false, receipts: [{ runId: 'run-root', rootThreadId: 'root', status: 'unknown' }] }; } });
  f.setObservation({ complete: true, holders: [holder('root')] });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'unknown'); assert.equal(result.archiveAttempted, false); assert.equal(result.freezeRetained, true); assert.equal(f.archiveCount, 0);
  f.setObservation({ complete: true, holders: [] }); const checked = await f.service.recheck(result.operationId, owner);
  assert.equal(checked.status, 'failed'); assert.equal(checked.freezeRetained, false); assert.equal(f.archiveCount, 0);
});

test('a failed release preserves only this operation freeze, exposing an owner-bound read-only recheck receipt', async () => {
  let failRelease = true, operationId;
  const f = fixture(undefined, { release(ids, id) { operationId = id; assert.deepEqual(ids, ['root', 'child']); if (failRelease) throw Error('PRIVATE_RELEASE_FAILURE'); } });
  const p = await f.service.preview('root', owner);
  f.setObservation({ complete: true, holders: [holder('child', { managed: false })] });
  await assert.rejects(async () => f.service.execute(p.planId, owner), error => error.code === 'archive_external_writer' && error.operationId === operationId && error.freezeRetained === true);
  assert.equal(f.archiveCount, 0); assert.equal(f.freezes.size, 2);
  failRelease = false; f.setObservation({ complete: true, holders: [] });
  const checked = await f.service.recheck(operationId, owner);
  assert.equal(checked.status, 'failed'); assert.equal(checked.freezeRetained, false); assert.equal(f.freezes.size, 0); assert.equal(f.archiveCount, 0); assert.equal(f.stoppedCount, 0);
  assert.ok(!JSON.stringify(checked).includes('PRIVATE_RELEASE_FAILURE'));
});

test('owners cannot reuse another session consent or receipts, expired plans require confirmation and valid parameters are mandatory', async () => {
  const f = fixture(), p = await f.service.preview('root', owner);
  await assert.rejects(async () => f.service.execute(p.planId, 'other-owner'), error => error.status === 403);
  f.advance(120001);
  await assert.rejects(async () => f.service.execute(p.planId, owner), error => error.code === 'archive_plan_expired');
  assert.equal(f.archiveCount, 0);
  const fresh = await f.service.preview('root', owner), result = await f.service.execute(fresh.planId, owner);
  await assert.rejects(f.service.recheck(result.operationId, 'other-owner'), error => error.status === 403);
  assert.equal(f.archiveCount, 1);
  await assert.rejects(f.service.preview('../root', owner), error => error.status === 400);
  await assert.rejects(f.service.preview('root', ''), error => error.status === 400);
  await assert.rejects(f.service.preview('missing', owner), error => error.status === 404);
});

test('durable unknown receipts survive gateway reconstruction without prompts or tokens and recheck releases only the confirmed scope', async t => {
  const storeFile = await store(t), privateOwner = 'PRIVATE_WORKBENCH_SCOPE_DO_NOT_EXPOSE';
  const rows = [thread('root', { name: null, preview: 'PRIVATE_PROMPT_NOT_ON_DISK' }), child('child', 'root')];
  const f = fixture(rows, { storeFile, archive() { throw new RelayError(504, 'rpc_timeout', 'Timed out'); }, async onFreeze(ids, operationId) {
    const disk = JSON.parse(await fs.readFile(storeFile, 'utf8'));
    assert.equal(disk.operations[0].operationId, operationId); assert.equal(disk.operations[0].phase, 'freezePending');
    assert.deepEqual(disk.operations[0].affected.map(row => row.id), ids); assert.equal(disk.operations[0].freezeRetained, true);
  } });
  const p = await f.service.preview('root', privateOwner), result = await f.service.execute(p.planId, privateOwner);
  assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true);
  const raw = await fs.readFile(storeFile, 'utf8'), disk = JSON.parse(raw);
  assert.equal(disk.schemaVersion, 1); assert.match(disk.operations[0].ownerScope, /^[a-f0-9]{64}$/);
  assert.ok(!raw.includes(privateOwner)); assert.ok(!raw.includes('PRIVATE_PROMPT_NOT_ON_DISK'));
  assert.equal(disk.operations[0].requestUncertain, true);
  if (process.platform !== 'win32') assert.equal((await fs.stat(storeFile)).mode & 0o777, 0o600);
  for (const row of f.rows.values()) row.archived = true;
  const releases = [], restored = fixture([...f.rows.values()], { storeFile, releaseRestored(ids, operationId) { releases.push({ ids, operationId }); } });
  const pending = await restored.service.listOperations(privateOwner);
  assert.equal(pending.length, 1); assert.equal(pending[0].operationId, result.operationId); assert.equal(pending[0].affectedCount, 2);
  assert.deepEqual(await restored.service.listOperations('another-workbench'), []); assert.equal(restored.calls.length, 0);
  await assert.rejects(restored.service.recheck(result.operationId, 'another-workbench'), error => error.status === 403);
  await assert.rejects(restored.service.execute(p.planId, privateOwner), error => error.code === 'archive_plan_forbidden');
  const checked = await restored.service.recheck(result.operationId, privateOwner);
  assert.equal(checked.status, 'complete'); assert.equal(checked.freezeRetained, false);
  assert.deepEqual(releases, [{ ids: ['root', 'child'], operationId: result.operationId }]);
  assert.equal(restored.archiveCount, 0); assert.equal(restored.stoppedCount, 0); assert.ok(!restored.phases.includes('freeze'));
  assert.ok(restored.calls.every(call => call.method === 'thread/list'));
  assert.deepEqual(await restored.service.listOperations(privateOwner), []);
  assert.equal(JSON.parse(await fs.readFile(storeFile, 'utf8')).operations[0].freezeRetained, false);
  assert.deepEqual(await fs.readdir(dirname(storeFile)), ['archive-operations.json']);
});

test('receipt failures before freeze or after freeze refuse archive, and the latter remains recoverable across gateway reconstruction', async t => {
  const storeFile = await store(t);
  const failing = fixture(undefined, { storeFile, filesystem: { ...fs, async rename() { throw Error('PRIVATE_STORAGE_FAILURE'); } } });
  const first = await failing.service.preview('root', owner);
  await assert.rejects(failing.service.execute(first.planId, owner), error => error.code === 'archive_store_unavailable');
  assert.equal(failing.archiveCount, 0); assert.equal(failing.stoppedCount, 0); assert.equal(failing.freezes.size, 0);
  assert.deepEqual(await fs.readdir(dirname(storeFile)), []);
  let writes = 0;
  const frozen = fixture(undefined, { storeFile, filesystem: { ...fs, async rename(from, to) { if (++writes === 2) throw Error('failed after freeze'); return fs.rename(from, to); } } });
  const p = await frozen.service.preview('root', owner); let operationId;
  await assert.rejects(frozen.service.execute(p.planId, owner), error => { operationId = error.operationId; return error.code === 'archive_store_unavailable' && error.freezeRetained === true; });
  assert.ok(operationId); assert.equal(frozen.freezes.size, 2); assert.equal(frozen.archiveCount, 0); assert.equal(frozen.stoppedCount, 0);
  const releases = [], restored = fixture(undefined, { storeFile, releaseRestored(ids, id) { releases.push({ ids, id }); } });
  assert.equal((await restored.service.listOperations(owner))[0].operationId, operationId);
  const checked = await restored.service.recheck(operationId, owner);
  assert.equal(checked.status, 'failed'); assert.equal(checked.freezeRetained, false);
  assert.deepEqual(releases, [{ ids: ['root', 'child'], id: operationId }]);
  assert.equal(restored.archiveCount, 0); assert.equal(restored.stoppedCount, 0);
});

test('receipt writes after official archive cannot claim success and restart rechecks never resend the official request', async t => {
  const storeFile = await store(t); let writes = 0;
  const f = fixture(undefined, { storeFile, filesystem: { ...fs, async rename(from, to) { if (++writes >= 4) throw Error('post-archive write failed'); return fs.rename(from, to); } } });
  const p = await f.service.preview('root', owner), result = await f.service.execute(p.planId, owner);
  assert.equal(f.archiveCount, 1); assert.equal(result.status, 'unknown'); assert.equal(result.freezeRetained, true);
  assert.ok(result.reports.some(row => row.phase === 'receipt' && row.status === 'unknown'));
  const oldDisk = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  assert.equal(oldDisk.operations[0].phase, 'archivePending'); assert.equal(oldDisk.operations[0].requestUncertain, true);
  const restored = fixture([...f.rows.values()], { storeFile });
  const checked = await restored.service.recheck(result.operationId, owner);
  assert.equal(checked.status, 'complete'); assert.equal(checked.freezeRetained, false);
  assert.equal(restored.archiveCount, 0); assert.equal(restored.stoppedCount, 0); assert.equal(restored.releasedCount, 1);
});

test('invalid durable receipt schemas fail closed without querying metadata or touching runtime freezes', async t => {
  const storeFile = await store(t); await fs.mkdir(dirname(storeFile), { recursive: true });
  await fs.writeFile(storeFile, JSON.stringify({ schemaVersion: 2, operations: [] }));
  const f = fixture(undefined, { storeFile });
  await assert.rejects(f.service.listOperations(owner), error => error.code === 'archive_store_invalid');
  await assert.rejects(f.service.preview('root', owner), error => error.code === 'archive_store_invalid');
  assert.equal(f.calls.length, 0); assert.equal(f.freezes.size, 0);
});

test('authoritative empty descendants ignore unrelated orphan metadata and never include the selected root ancestors', async () => {
  for (const root of [thread('root'), child('root', 'missing-ancestor')]) {
    const f = fixture([root, child('unrelated-orphan', 'missing-other-parent')], { authoritativeDescendants: true });
    const p = await f.service.preview('root', owner); assert.equal(p.canArchive, true); assert.deepEqual(p.affected.map(row => row.id), ['root']);
    const result = await f.service.execute(p.planId, owner); assert.equal(result.status, 'complete'); assert.equal(f.rows.get('unrelated-orphan').archived, false);
  }
  const legacy = fixture([thread('root'), child('unrelated-orphan', 'missing-other-parent')]);
  assert.equal((await legacy.service.preview('root', owner)).canArchive, false);
});

test('DB descendants beyond a missing intermediate remain in preview, freeze and per-ID archive verification', async () => {
  const expected = ['root', 'y', 'z'];
  const f = fixture([thread('root'), child('y', 'missing-x'), { ...child('z', 'y'), archived: true }, child('unrelated', 'missing-other')], {
    authoritativeDescendants: true, pageSize: 1, spawnEdges: [['root', 'missing-x'], ['missing-x', 'y'], ['y', 'z'], ['missing-other', 'unrelated']],
    onFreeze(ids) { assert.deepEqual(ids, expected); },
    archive(params, rows) { assert.equal(params.threadId, 'root'); for (const id of expected) rows.get(id).archived = true; return {}; }
  });
  const p = await f.service.preview('root', owner); assert.equal(p.canArchive, true); assert.deepEqual(p.affected.map(row => row.id), expected);
  assert.equal(p.affected[1].parentThreadId, 'missing-x');
  const result = await f.service.execute(p.planId, owner);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.affected.map(row => [row.id, row.status]), [['root', 'archived'], ['y', 'archived'], ['z', 'alreadyArchived']]);
  assert.equal(f.rows.get('unrelated').archived, false); assert.equal(f.archiveCount, 1);
  const queries = f.calls.filter(call => call.params.ancestorThreadId);
  assert.ok(queries.length >= 6, 'preview and both pre-execution scope reads query active and archived DB descendants');
  for (const query of queries) { assert.equal(query.params.ancestorThreadId, 'root'); assert.equal(query.params.useStateDbOnly, true); assert.deepEqual(query.params.sourceKinds, THREAD_SOURCE_KINDS); }
});

test('authoritative descendants added after confirmation or while stopping require a new preview', async () => {
  const initial = fixture(undefined, { authoritativeDescendants: true }), p = await initial.service.preview('root', owner);
  initial.rows.set('new', child('new', 'child'));
  await assert.rejects(initial.service.execute(p.planId, owner), { code: 'archive_plan_changed' });
  assert.equal(initial.stoppedCount, 0); assert.equal(initial.archiveCount, 0); assert.equal(initial.freezes.size, 0);
  const stopping = fixture(undefined, { authoritativeDescendants: true, stop(ids, context, state) { state.rows.set('new', child('new', 'child')); return { complete: true, receipts: [] }; } });
  const confirmed = await stopping.service.preview('root', owner);
  await assert.rejects(stopping.service.execute(confirmed.planId, owner), { code: 'archive_plan_changed' });
  assert.equal(stopping.archiveCount, 0); assert.equal(stopping.freezes.size, 0); assert.equal(stopping.stoppedCount, 1);
});

test('authoritative scope fails closed for incomplete cursors, duplicate, unlisted or mismatched descendants and ignored filters', async () => {
  const cases = [
    () => ({ data: [] }),
    () => ({ data: [], nextCursor: 'loop' }),
    params => ({ data: [child('child', 'root')], nextCursor: params.cursor ? null : 'repeat' }),
    () => ({ data: [child('not-in-inventory', 'root')], nextCursor: null }),
    () => ({ data: [child('child', 'root')].map(row => ({ ...row, cwd: '/changed' })), nextCursor: null }),
    () => ({ data: [thread('root')], nextCursor: null }),
    () => ({ data: [thread('unrelated')], nextCursor: null }),
    () => ({ data: [], nextCursor: null })
  ];
  for (const response of cases) {
    const f = fixture([thread('root'), child('child', 'root'), thread('unrelated')], { authoritativeDescendants: true, list(params, result) { return params.ancestorThreadId && !params.archived ? response(params) : result; } });
    const p = await f.service.preview('root', owner);
    assert.equal(p.canArchive, false); assert.equal(p.planId, null); assert.ok(p.blockedReasons.length); assert.equal(f.archiveCount, 0); assert.equal(f.stoppedCount, 0); assert.equal(f.freezes.size, 0);
  }
});

test('authoritative membership still rejects affected parent conflicts, cycles, ephemeral and known outside-parent records', async () => {
  const cases = [
    { rows: [thread('root'), { ...child('child', 'root'), parentThreadId: 'other' }, thread('other')], edges: [['root', 'child']] },
    { rows: [child('root', 'child'), child('child', 'root')], edges: [['root', 'child'], ['child', 'root']] },
    { rows: [thread('root'), { ...child('child', 'root'), ephemeral: true }], edges: [['root', 'child']] },
    { rows: [thread('root'), child('child', 'other'), thread('other')], edges: [['root', 'child']] }
  ];
  for (const { rows, edges } of cases) {
    const f = fixture(rows, { authoritativeDescendants: true, spawnEdges: edges }), p = await f.service.preview('root', owner);
    assert.equal(p.canArchive, false); assert.equal(p.planId, null); assert.equal(f.archiveCount, 0);
  }
});
