import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeCleanup } from '../src/runtime-cleanup.mjs';

test('cleanup ignores external, unknown, active, approval, unsaved and pinned runtimes', async () => {
  const ready = { id: 'one', managed: true, status: 'idle', revision: 'rev', lifecycle: { version: 2, idleSince: 0, terminalSavedAt: 0, lastOutputAt: 0, reason: null } };
  const runs = [
    { ...ready, managed: false }, { ...ready, keepRunning: true }, { ...ready, webConnected: true }, { ...ready, status: 'working' },
    { ...ready, activeTurnId: 'turn' }, { ...ready, pendingApprovals: [{}] },
    { ...ready, lifecycle: { ...ready.lifecycle, version: null } },
    { ...ready, lifecycle: { ...ready.lifecycle, terminalSavedAt: null } },
    { ...ready, lifecycle: { ...ready.lifecycle, reason: 'unknown' } },
    { ...ready, lifecycle: { ...ready.lifecycle, lastOutputAt: 1 } },
    { ...ready, lifecycle: { ...ready.lifecycle, version: 1 } },
    { ...ready, lifecycle: { ...ready.lifecycle, lastOutputAt: null } }
  ];
  let calls = 0; const cleaner = createRuntimeCleanup({ rpc: { listRuns: async () => runs, reapRun: async () => { calls++; } }, clock: () => 2 * 60 * 60 * 1000 });
  assert.deepEqual(await cleaner.maintenance(), []); assert.equal(calls, 0);
});

test('maintenance coalesces concurrent sweeps and a recheck refusal does not stop later candidates', async () => {
  let release, lists = 0; const barrier = new Promise(done => { release = done; });
  const run = id => ({ id, managed: true, status: 'idle', revision: id, lifecycle: { version: 2, idleSince: 0, terminalSavedAt: 0, lastOutputAt: 0 } });
  const cleaner = createRuntimeCleanup({ rpc: { listRuns: async () => { lists++; await barrier; return [run('changed'), run('safe')]; }, reapRun: async id => { if (id === 'changed') throw Object.assign(Error('changed'), { code: 'runtime_changed' }); return { id, stopped: true }; } }, clock: () => 2 * 60 * 60 * 1000 });
  const one = cleaner.maintenance(), two = cleaner.maintenance(); assert.equal(one, two); release();
  assert.deepEqual(await one, [{ id: 'changed', stopped: false, reason: 'runtime_changed' }, { id: 'safe', stopped: true }]); assert.equal(lists, 1);
});
