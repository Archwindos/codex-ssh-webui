// Gateway maintenance only considers verified WebUI-created workers, with no
// current browser lease and at least two hours since output/task activity.
export function createRuntimeCleanup({ rpc, clock = Date.now, idleMs = 120 * 60 * 1000 } = {}) {
  if (typeof rpc?.listRuns !== 'function' || typeof rpc?.reapRun !== 'function' || !Number.isFinite(idleMs) || idleMs < 0) throw new TypeError('runtime cleanup configuration');
  let pending = null;
  return {
    idleMs,
    maintenance() {
      if (pending) return pending;
      pending = (async () => {
        const results = typeof rpc.cleanupStaleRuns === 'function' ? await rpc.cleanupStaleRuns() : [];
        for (const run of await rpc.listRuns()) {
          const lifecycle = run.lifecycle;
          if (!run.managed || run.keepRunning || run.webConnected || run.status !== 'idle' || run.activeTurnId || run.pendingApprovals?.length || lifecycle?.version !== 2 || lifecycle.reason || !Number.isFinite(lifecycle.idleSince) || !Number.isFinite(lifecycle.terminalSavedAt) || !Number.isFinite(lifecycle.lastOutputAt) || clock() - lifecycle.lastOutputAt < idleMs) continue;
          try { results.push(await rpc.reapRun(run.id, run.revision, { idleMs })); }
          catch (error) { results.push({ id: run.id, stopped: false, reason: error.code || 'runtime_unknown' }); }
        }
        return results;
      })().finally(() => { pending = null; });
      return pending;
    }
  };
}
