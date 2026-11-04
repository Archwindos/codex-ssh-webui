import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fail, RelayError, THREAD_SOURCE_KINDS } from './protocol.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const validOwner = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const token = () => randomBytes(24).toString('base64url');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reason = (code, message, threadIds = []) => ({ code, message, ...(threadIds.length ? { threadIds } : {}) });
const problem = error => ({ code: error instanceof RelayError ? error.code : 'archive_check_failed', message: error instanceof RelayError ? error.message : '无法核对归档状态。' });
const limits = { pages: 100, records: 5000, affected: 1000, plans: 100, ttl: 120000 };

function metadata(thread, archived) {
  if (!validId(thread?.id) || typeof thread.cwd !== 'string' || !thread.cwd || thread.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(thread.cwd)) fail(502, 'archive_metadata_invalid', '对话元数据不完整，不能确定归档范围。');
  const direct = thread.parentThreadId, spawned = thread.source?.subAgent?.thread_spawn?.parent_thread_id;
  const badParent = [direct, spawned].some(value => value != null && !validId(value));
  const conflicting = direct != null && spawned != null && direct !== spawned;
  const parentThreadId = validId(direct) ? direct : validId(spawned) ? spawned : null;
  const explicitRoot = Object.hasOwn(thread, 'parentThreadId') && direct === null && !thread.source?.subAgent && spawned == null;
  const knownRoot = explicitRoot || (typeof thread.source === 'string' && ['cli', 'vscode', 'exec', 'appServer'].includes(thread.source));
  const relationshipUnknown = badParent || conflicting || (!parentThreadId && !knownRoot);
  return {
    id: thread.id, name: String(thread.name || thread.agentNickname || thread.preview || thread.id).slice(0, 200), cwd: thread.cwd,
    archived, parentThreadId, forkedFromId: validId(thread.forkedFromId) ? thread.forkedFromId : null,
    relationshipUnknown, relationshipConflict: conflicting, relationshipInvalid: badParent,
    ...(typeof thread.ephemeral === 'boolean' ? { ephemeral: thread.ephemeral } : {})
  };
}

const identity = rows => digest(rows.map(p => [p.id, p.cwd, p.parentThreadId, p.forkedFromId, p.archived, p.ephemeral === true]).sort((a, b) => a[0].localeCompare(b[0])));
const writerIdentity = holders => digest(holders.map(p => [p.threadId, p.managed, p.runId || null, p.pid || null, p.rootThreadId || null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

// Only official metadata and archive RPCs touch the conversation library.
// The freeze applies to managed admission; manual CLI writers are observed, not locked.
export function createArchiveService({ rpc, inspectWriters, stopManagedRuns, freezeThreads, releaseFrozenThreads, inspectThreadStates, atomicity = 'managed-admission-only', authoritativeDescendants = false, storeFile = null, filesystem = fs, clock = Date.now } = {}) {
  if (!rpc?.call || ![inspectWriters, stopManagedRuns, freezeThreads].every(fn => typeof fn === 'function')) fail(500, 'archive_configuration', '归档需要完整的写入者核验、运行停止和准入冻结接口。');
  if (storeFile !== null && (typeof storeFile !== 'string' || !isAbsolute(storeFile) || typeof releaseFrozenThreads !== 'function')) fail(500, 'archive_configuration', '持久归档回执需要本机绝对路径和精确解除冻结接口。');
  if (typeof authoritativeDescendants !== 'boolean') fail(500, 'archive_configuration', '权威后代查询设置必须为布尔值。');
  if ((inspectThreadStates !== undefined && typeof inspectThreadStates !== 'function') || !['managed-admission-only', 'gateway-admission-only'].includes(atomicity) || (atomicity === 'gateway-admission-only' && !inspectThreadStates)) fail(500, 'archive_configuration', '原生归档需要完整的状态核验接口。');
  const scopeNotice = atomicity === 'gateway-admission-only' ? { atomicity, atomicityMessage: '归档期间会暂停从本网页发送消息。其他 Codex 客户端仍能改变对话或子对话，请先确认它们不会继续操作。' } : { atomicity };
  const plans = new Map(), operations = new Map();
  const statuses = ['complete', 'partial', 'failed', 'unknown'], itemStatuses = ['archived', 'alreadyArchived', 'notArchived', 'unknown'];
  const receipt = (operation, status = 'unknown', phase = operation.phase || 'recovering') => ({ operationId: operation.id, threadId: operation.threadId, status, phase, affected: operation.affected.map(row => ({ id: row.id, name: row.id, archived: row.archived, status: 'unknown' })), reports: [...operation.reports], archiveAttempted: operation.archiveAttempted, freezeRetained: operation.freezeRetained, ...scopeNotice });
  const record = operation => ({
    operationId: operation.id, ownerScope: operation.ownerScope, threadId: operation.threadId,
    createdAt: operation.createdAt, updatedAt: operation.updatedAt, phase: operation.phase || 'recovering',
    status: operation.result?.status || 'unknown', archiveAttempted: operation.archiveAttempted,
    requestUncertain: operation.requestUncertain, freezeRetained: operation.freezeRetained,
    ...(operation.scopeFingerprint ? { scopeFingerprint: operation.scopeFingerprint } : {}),
    affected: operation.affected.map(row => { const item = operation.result?.affected.find(item => item.id === row.id); return { id: row.id, archived: row.archived, status: item?.status || 'unknown' }; })
  });
  const ready = (async () => {
    if (!storeFile) return;
    try {
      const stat = await filesystem.lstat(storeFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('invalid receipt file');
      const data = JSON.parse(await filesystem.readFile(storeFile, 'utf8'));
      if (!data || Object.keys(data).sort().join(',') !== 'operations,schemaVersion' || data.schemaVersion !== 1 || !Array.isArray(data.operations) || data.operations.length > limits.plans) throw Error('invalid receipt schema');
      for (const value of data.operations) {
        const expectedKeys = ['affected', 'archiveAttempted', 'createdAt', 'freezeRetained', 'operationId', 'ownerScope', 'phase', 'requestUncertain', 'status', 'threadId', 'updatedAt'];
        if (Object.hasOwn(value || {}, 'scopeFingerprint')) { if (!inspectThreadStates || !/^[a-f0-9]{64}$/.test(value.scopeFingerprint)) throw Error('invalid scope fingerprint'); expectedKeys.push('scopeFingerprint'); }
        if (!value || Object.keys(value).sort().join(',') !== expectedKeys.sort().join(',') || !validId(value.operationId) || operations.has(value.operationId) || !/^[a-f0-9]{64}$/.test(value.ownerScope) || !validId(value.threadId) || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || typeof value.phase !== 'string' || value.phase.length > 100 || !statuses.includes(value.status) || ['archiveAttempted', 'requestUncertain', 'freezeRetained'].some(key => typeof value[key] !== 'boolean') || !Array.isArray(value.affected) || !value.affected.length || value.affected.length > limits.affected) throw Error('invalid operation');
        const ids = new Set();
        for (const row of value.affected) {
          if (!row || Object.keys(row).sort().join(',') !== 'archived,id,status' || !validId(row.id) || ids.has(row.id) || typeof row.archived !== 'boolean' || !itemStatuses.includes(row.status)) throw Error('invalid confirmed set');
          ids.add(row.id);
        }
        if (!ids.has(value.threadId)) throw Error('missing root');
        const operation = { id: value.operationId, ownerScope: value.ownerScope, threadId: value.threadId, affected: value.affected.map(row => ({ id: row.id, archived: row.archived })), scopeFingerprint: value.scopeFingerprint, phase: value.phase, createdAt: value.createdAt, updatedAt: value.updatedAt, archiveAttempted: value.archiveAttempted, requestUncertain: value.requestUncertain, freezeRetained: value.freezeRetained, reports: [{ phase: 'recovery', status: 'loaded', message: '仅恢复已确认集合和回执，不恢复执行或重发请求。' }] };
        operation.freeze = { release: () => releaseFrozenThreads([...ids], operation.id) };
        operation.result = { ...receipt(operation, value.status, value.phase), affected: value.affected.map(row => ({ ...row, name: row.id })) };
        operations.set(operation.id, operation);
      }
      await filesystem.chmod(storeFile, 0o600);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      operations.clear(); fail(500, 'archive_store_invalid', '归档回执文件无法安全读取，未恢复任何执行。');
    }
  })();
  ready.catch(() => {});
  let saving = Promise.resolve();
  const persist = () => {
    if (!storeFile) return Promise.resolve();
    const result = saving.then(async () => {
      const temporary = `${storeFile}.${token()}.tmp`; let handle;
      try {
        await filesystem.mkdir(dirname(storeFile), { recursive: true, mode: 0o700 });
        handle = await filesystem.open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, operations: [...operations.values()].map(record) }, null, 2)}\n`, 'utf8');
        await handle.sync(); await handle.close(); handle = null;
        await filesystem.rename(temporary, storeFile);
      } catch { fail(500, 'archive_store_unavailable', '归档回执保存失败，未确认的操作不会继续。'); }
      finally { await handle?.close(); await filesystem.rm(temporary, { force: true }); }
    });
    saving = result.catch(() => {}); return result;
  };
  const inventory = async (ancestorThreadId = null) => {
    const rows = new Map();
    for (const archived of [false, true]) {
      let cursor = null, done = false;
      const seen = new Set();
      for (let page = 0; page < limits.pages; page++) {
        const response = await rpc.call('thread/list', { archived, limit: 100, cursor, sourceKinds: [...THREAD_SOURCE_KINDS], sortKey: 'created_at', sortDirection: 'asc', ...(authoritativeDescendants ? { useStateDbOnly: true } : {}), ...(ancestorThreadId ? { ancestorThreadId } : {}) });
        if (!Array.isArray(response?.data) || response.data.length > 100 || (ancestorThreadId && !Object.hasOwn(response, 'nextCursor')) || (response.nextCursor != null && (typeof response.nextCursor !== 'string' || !response.nextCursor || response.nextCursor.length > 4096))) fail(502, 'archive_inventory_incomplete', '对话列表格式或分页信息不完整，不能归档。');
        for (const thread of response.data) {
          const row = metadata(thread, archived);
          if (rows.has(row.id)) fail(409, 'archive_inventory_changed', '完整列表出现重复或跨归档状态冲突，请重新预检。');
          rows.set(row.id, row);
          if (rows.size > limits.records) fail(409, 'archive_inventory_limit', '对话列表超出归档安全上限，未执行归档。');
        }
        cursor = response.nextCursor ?? null;
        if (!cursor) { done = true; break; }
        if (seen.has(cursor)) fail(502, 'archive_inventory_incomplete', '对话列表分页循环，不能确定完整归档范围。');
        seen.add(cursor);
      }
      if (!done) fail(409, 'archive_inventory_limit', '对话列表分页超出归档安全上限，未执行归档。');
    }
    return rows;
  };
  const subtree = (rows, threadId) => {
    if (!rows.has(threadId)) fail(404, 'archive_thread_missing', '完整对话库中没有找到该对话。');
    const blockedReasons = [], children = new Map();
    for (const row of rows.values()) {
      if (row.relationshipConflict) blockedReasons.push(reason('archive_relationship_conflict', 'parentThreadId 与 spawn 来源的父对话冲突。', [row.id]));
      else if (row.relationshipInvalid || (row.relationshipUnknown && row.id !== threadId)) blockedReasons.push(reason('archive_relationship_unknown', '有对话的父子关系未知，无法排除其属于本次归档子树。', [row.id]));
      if (row.parentThreadId && !rows.has(row.parentThreadId)) blockedReasons.push(reason('archive_relationship_unknown', '父对话不在完整列表中，无法确定子树边界。', [row.id]));
      if (row.parentThreadId) { if (!children.has(row.parentThreadId)) children.set(row.parentThreadId, []); children.get(row.parentThreadId).push(row.id); }
    }
    const complete = new Set();
    for (const row of rows.values()) {
      let current = row.id; const visiting = new Set();
      while (current && !complete.has(current)) {
        if (visiting.has(current)) { blockedReasons.push(reason('archive_relationship_cycle', '对话父子关系存在环，不能确定归档范围。', [...visiting])); break; }
        visiting.add(current); current = rows.get(current)?.parentThreadId;
      }
      for (const id of visiting) complete.add(id);
    }
    const affected = [], queue = [threadId], visited = new Set();
    while (queue.length) {
      const id = queue.shift(); if (visited.has(id)) continue; visited.add(id);
      affected.push(rows.get(id));
      if (affected.length > limits.affected) fail(409, 'archive_subtree_limit', '受影响子对话超出归档安全上限，未执行归档。');
      queue.push(...(children.get(id) || []).sort());
    }
    if (affected.some(row => row.ephemeral)) blockedReasons.push(reason('archive_ephemeral', '临时对话没有可核验的持久归档记录。', affected.filter(row => row.ephemeral).map(row => row.id)));
    return { affected, blockedReasons };
  };
  const readScope = async threadId => {
    const rows = await inventory();
    if (!authoritativeDescendants) return subtree(rows, threadId);
    if (!rows.has(threadId)) fail(404, 'archive_thread_missing', '完整对话库中没有找到该对话。');
    // 0.165 archives the DB spawn-edge subtree, which can cross a missing
    // metadata row. An ancestor-filtered DB listing, not local reachability,
    // therefore defines membership. Inventory only cross-checks its evidence.
    const descendants = await inventory(threadId), blockedReasons = [];
    if (descendants.has(threadId)) fail(502, 'archive_descendants_invalid', '后代筛选返回了根对话，无法核对筛选是否生效。');
    if (descendants.size + 1 > limits.affected) fail(409, 'archive_subtree_limit', '受影响子对话超出归档安全上限，未执行归档。');
    for (const row of descendants.values()) {
      const known = rows.get(row.id);
      if (!known || identity([known]) !== identity([row]) || ['relationshipUnknown', 'relationshipConflict', 'relationshipInvalid'].some(key => known[key] !== row[key])) fail(409, 'archive_inventory_changed', '后代查询与完整对话库不一致，请重新预检。');
      if (!row.parentThreadId) blockedReasons.push(reason('archive_descendants_invalid', '后代筛选返回了没有父对话的记录，无法核对其属于选定子树。', [row.id]));
    }
    const selected = new Map([[threadId, rows.get(threadId)], ...descendants]);
    for (const row of selected.values()) {
      if (row.relationshipConflict) blockedReasons.push(reason('archive_relationship_conflict', 'parentThreadId 与 spawn 来源的父对话冲突。', [row.id]));
      else if (row.relationshipInvalid || (row.relationshipUnknown && row.id !== threadId)) blockedReasons.push(reason('archive_relationship_unknown', '受影响对话的父子关系无法核对。', [row.id]));
      const visiting = new Set(); let current = row.id;
      while (selected.has(current)) {
        if (visiting.has(current)) { blockedReasons.push(reason('archive_relationship_cycle', '受影响对话的父子关系存在环。', [...visiting])); break; }
        visiting.add(current); const parent = selected.get(current).parentThreadId;
        // The root's ancestors are never archived. A missing intermediate is
        // allowed only because membership came from the authoritative DB query.
        if (current !== threadId && parent && rows.has(parent) && !selected.has(parent)) blockedReasons.push(reason('archive_descendants_invalid', '后代记录指向筛选集合外的已知父对话，不能确认筛选完整性。', [current, parent]));
        current = parent;
      }
    }
    // Locally provable descendants cannot disappear from the DB-filtered set;
    // this detects an ignored or incomplete filter without rejecting unrelated
    // orphan metadata elsewhere in the account.
    for (const row of rows.values()) {
      if (selected.has(row.id)) continue;
      let parent = row.parentThreadId; const seen = new Set();
      while (parent && rows.has(parent) && !seen.has(parent)) {
        if (parent === threadId) { blockedReasons.push(reason('archive_descendants_incomplete', '权威后代查询遗漏了已知子对话。', [row.id])); break; }
        seen.add(parent); parent = rows.get(parent).parentThreadId;
      }
    }
    const affected = [selected.get(threadId), ...[...descendants.values()].sort((a, b) => a.id.localeCompare(b.id))];
    if (affected.some(row => row.ephemeral)) blockedReasons.push(reason('archive_ephemeral', '临时对话没有可核验的持久归档记录。', affected.filter(row => row.ephemeral).map(row => row.id)));
    return { affected, blockedReasons };
  };
  const writers = async ids => {
    try {
      const observation = await inspectWriters(ids);
      if (!observation || observation.complete !== true || !Array.isArray(observation.holders) || observation.holders.length > 5000) return { complete: false, holders: [] };
      const set = new Set(ids), holders = [];
      for (const h of observation.holders) {
        if (!validId(h?.threadId) || !set.has(h.threadId) || !Number.isSafeInteger(h.pid) || h.pid <= 0) return { complete: false, holders: [] };
        holders.push({ threadId: h.threadId, managed: h.managed === true, runId: validId(h.runId) ? h.runId : null, rootThreadId: validId(h.rootThreadId) ? h.rootThreadId : null, pid: h.pid, status: typeof h.status === 'string' ? h.status.slice(0, 100) : 'unknown' });
      }
      return { complete: true, holders };
    } catch { return { complete: false, holders: [] }; }
  };
  const writerProblems = (observation, ids) => {
    if (!observation.complete) return [reason('archive_writer_unknown', '写入者观测不完整，不能确认没有外部或身份未知的写入者。', ids)];
    const reasons = [], set = new Set(ids);
    for (const holder of observation.holders) {
      if (!holder.managed || !holder.runId || !holder.rootThreadId) reasons.push(reason('archive_external_writer', '受影响对话存在外部或身份无法核验的写入者；未停止该进程。', [holder.threadId]));
      else if (!set.has(holder.rootThreadId)) reasons.push(reason('archive_run_outside_scope', '该子对话的运行环境属于确认集合外的父对话，不能顺带停止。', [holder.threadId, holder.rootThreadId]));
    }
    return reasons;
  };
  const visible = row => { const { relationshipUnknown, relationshipConflict, relationshipInvalid, ...result } = row; return result; };
  const threadStates = async ids => {
    if (!inspectThreadStates) return { states: [], fingerprint: null, blockedReasons: [] };
    try {
      const value = await inspectThreadStates(ids), seen = new Set();
      if (value?.complete !== true || !Array.isArray(value.states) || value.states.length !== ids.length) throw Error('Incomplete states');
      const states = value.states.map(row => {
        if (!ids.includes(row?.threadId) || seen.has(row.threadId) || !['idle', 'notLoaded', 'active', 'systemError', 'unknown'].includes(row.status) || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint)) throw Error('Invalid native state');
        seen.add(row.threadId); return { threadId: row.threadId, status: row.status, fingerprint: row.fingerprint };
      });
      return { states, fingerprint: digest([...states].sort((a, b) => a.threadId.localeCompare(b.threadId))), blockedReasons: states.filter(row => !['idle', 'notLoaded'].includes(row.status)).map(row => reason(row.status === 'active' ? 'archive_thread_active' : 'archive_state_unknown', row.status === 'active' ? '受影响对话仍在执行、等待审批或等待回答；未停止或回答任何请求。' : '受影响对话的原生状态无法确定，不能归档。', [row.threadId])) };
    } catch { return { states: [], fingerprint: null, blockedReasons: [reason('archive_state_unknown', '未能完整核对所有受影响对话的原生状态，不能归档。', ids)] }; }
  };
  const checkFresh = async plan => {
    try {
      const current = await readScope(plan.threadId);
      if (current.blockedReasons.length || identity(current.affected) !== plan.fingerprint) throw Error('changed');
      const state = await threadStates(current.affected.map(row => row.id));
      if (state.blockedReasons.length || state.fingerprint !== plan.stateFingerprint) throw Error('state changed');
      return current;
    } catch { fail(409, 'archive_plan_changed', '归档范围、原生状态或完整性已改变，请重新预检并确认。'); }
  };
  const ownedOperation = (id, owner) => {
    if (!validOwner(owner) || !validId(id)) fail(400, 'invalid_archive_parameters', '归档操作或会话身份无效。');
    const operation = operations.get(id);
    if (!operation || operation.ownerScope !== digest(owner)) fail(403, 'archive_operation_forbidden', '该归档操作不属于当前登录会话。');
    return operation;
  };
  const release = async operation => {
    if (!operation.freeze || !operation.freezeRetained) return;
    try { await operation.freeze.release(); operation.freezeRetained = false; operation.reports.push({ phase: 'release', status: 'released' }); }
    catch { operation.reports.push({ phase: 'release', status: 'unknown', message: '本次归档冻结尚未解除，可以重新核验。' }); }
  };
  const verify = async operation => {
    if (operation.reports.length > 50) operation.reports.splice(10, operation.reports.length - 50);
    let rows;
    try { rows = await inventory(); operation.reports.push({ phase: 'verification', status: 'complete' }); }
    catch (error) { operation.reports.push({ phase: 'verification', status: 'unknown', ...problem(error) }); }
    const affected = operation.affected.map(row => {
      const actual = rows?.get(row.id);
      return { ...visible(row), ...(actual ? { name: actual.name, cwd: actual.cwd, parentThreadId: actual.parentThreadId, forkedFromId: actual.forkedFromId } : {}), status: !actual ? 'unknown' : actual.archived ? (row.archived ? 'alreadyArchived' : 'archived') : 'notArchived', ...(actual ? { verifiedArchived: actual.archived } : {}) };
    });
    const observation = await writers(operation.affected.map(row => row.id));
    operation.reports.push({ phase: 'writers', status: observation.complete && !observation.holders.length ? 'clear' : 'unknown', holders: observation.holders, complete: observation.complete });
    const native = await threadStates(operation.affected.map(row => row.id));
    let nativeScopeClear = true;
    if (inspectThreadStates) {
      operation.reports.push({ phase: 'nativeStateVerification', status: native.blockedReasons.length ? 'unknown' : 'clear', blockedReasons: native.blockedReasons });
      try {
        const current = await readScope(operation.threadId), normalize = rows => rows.map(row => ({ ...row, archived: false }));
        nativeScopeClear = !current.blockedReasons.length && identity(normalize(current.affected)) === operation.scopeFingerprint;
        operation.reports.push({ phase: 'nativeScopeVerification', status: nativeScopeClear ? 'unchanged' : 'changed', unconfirmedThreadIds: current.affected.filter(row => !operation.affected.some(before => before.id === row.id)).map(row => row.id) });
      } catch (error) { nativeScopeClear = false; operation.reports.push({ phase: 'nativeScopeVerification', status: 'unknown', ...problem(error) }); }
    }
    const unknown = affected.some(row => row.status === 'unknown'), success = affected.filter(row => ['archived', 'alreadyArchived'].includes(row.status)).length;
    if (success === affected.length && !unknown) operation.requestUncertain = false;
    const settled = !unknown && !operation.requestUncertain, writersClear = observation.complete && !observation.holders.length && !native.blockedReasons.length && nativeScopeClear;
    operation.phase = 'verified'; operation.updatedAt = clock();
    const status = !settled || !writersClear || operation.storageFault ? 'unknown' : success === affected.length ? 'complete' : success ? 'partial' : 'failed';
    operation.result = { operationId: operation.id, threadId: operation.threadId, status, phase: 'verified', affected, reports: [...operation.reports], archiveAttempted: operation.archiveAttempted, freezeRetained: operation.freezeRetained, ...scopeNotice };
    try {
      await persist(); // Durable evidence precedes releasing durable admission markers.
      if (settled && writersClear && !operation.storageFault) await release(operation);
      if (operation.freezeRetained) operation.result.status = 'unknown';
      operation.result.freezeRetained = operation.freezeRetained; operation.result.reports = [...operation.reports];
      await persist();
    } catch (error) {
      operation.storageFault = true; operation.result.status = 'unknown';
      operation.reports.push({ phase: 'receipt', status: 'unknown', ...problem(error) });
      operation.result.reports = [...operation.reports]; operation.result.freezeRetained = operation.freezeRetained;
    }
    return operation.result;
  };
  const preview = async (threadId, owner) => {
    await ready;
    if (!validId(threadId) || !validOwner(owner)) fail(400, 'invalid_archive_parameters', '对话或登录会话身份无效。');
    for (const [id, p] of plans) if (!p.executing && clock() >= p.expiresAt) plans.delete(id);
    let tree;
    try { tree = await readScope(threadId); }
    catch (error) {
      if (error instanceof RelayError && error.code === 'archive_thread_missing') throw error;
      return { planId: null, threadId, affected: [], requiresConfirmation: true, canArchive: false, blockedReasons: [problem(error)], ...scopeNotice };
    }
    const ids = tree.affected.map(row => row.id), observation = await writers(ids), native = await threadStates(ids);
    const blockedReasons = [...tree.blockedReasons, ...writerProblems(observation, ids), ...native.blockedReasons];
    const affected = tree.affected.map(row => ({ ...visible(row), writers: observation.holders.filter(holder => holder.threadId === row.id), ...(inspectThreadStates ? { nativeStatus: native.states.find(state => state.threadId === row.id)?.status || 'unknown' } : {}) }));
    if (blockedReasons.length) return { planId: null, threadId, affected, requiresConfirmation: true, canArchive: false, blockedReasons, ...scopeNotice };
    if (plans.size >= limits.plans) fail(429, 'archive_plan_limit', '待确认归档预检过多，请稍后重试。');
    const planId = token(), expiresAt = clock() + limits.ttl;
    plans.set(planId, { owner, threadId, affected: tree.affected, fingerprint: identity(tree.affected), writerFingerprint: writerIdentity(observation.holders), stateFingerprint: native.fingerprint, expiresAt });
    return { planId, threadId, affected, requiresConfirmation: true, canArchive: true, expiresAt, ...scopeNotice };
  };
  const execute = async (planId, owner, { onOperation } = {}) => {
    await ready;
    if (onOperation !== undefined && typeof onOperation !== 'function') fail(500, 'archive_configuration', '归档回执关联器无效。');
    if (!validId(planId) || !validOwner(owner)) fail(400, 'invalid_archive_parameters', '归档预检或登录会话身份无效。');
    const plan = plans.get(planId);
    if (!plan || plan.owner !== owner) fail(403, 'archive_plan_forbidden', '归档预检不属于当前登录会话。');
    if (plan.promise) return plan.promise;
    if (clock() >= plan.expiresAt) fail(409, 'archive_plan_expired', '归档确认已过期，请重新预检。');
    for (const [id, op] of operations) if (operations.size >= limits.plans && op.result && !op.freezeRetained) operations.delete(id);
    if (operations.size >= limits.plans) fail(429, 'archive_operation_limit', '仍有未完成的归档操作，请先重新核验。');
    const operation = { id: `archive-${token()}`, ownerScope: digest(owner), threadId: plan.threadId, affected: plan.affected, ...(inspectThreadStates ? { scopeFingerprint: identity(plan.affected.map(row => ({ ...row, archived: false }))) } : {}), reports: [], freezeRetained: false, archiveAttempted: false, requestUncertain: false, phase: 'preflight', createdAt: clock(), updatedAt: clock() };
    if (typeof releaseFrozenThreads === 'function') operation.freeze = { release: () => releaseFrozenThreads(operation.affected.map(row => row.id), operation.id) };
    operations.set(operation.id, operation);
    plan.executing = true;
    plan.promise = (async () => {
      if (onOperation) { operation.phase = 'preflightLinked'; operation.result = receipt(operation, 'unknown', operation.phase); await persist(); await onOperation(operation.id); operation.result = null; }
      await checkFresh(plan);
      const ids = plan.affected.map(row => row.id);
      operation.phase = 'freezePending'; operation.freezeRetained = true;
      try { await persist(); } catch (error) { operation.freezeRetained = false; throw error; }
      operation.freeze = await freezeThreads(ids, operation.id);
      if (typeof operation.freeze?.release !== 'function') fail(500, 'archive_freeze_invalid', '归档冻结回执无效，未调用归档。');
      operation.phase = 'frozen'; await persist();
      operation.reports.push({ phase: 'freeze', status: 'frozen', threadIds: ids });
      let confirmedObservation;
      try {
        const observation = await writers(ids), blocked = writerProblems(observation, ids);
        if (blocked.length) fail(409, blocked[0].code, blocked[0].message);
        if (writerIdentity(observation.holders) !== plan.writerFingerprint) fail(409, 'archive_plan_changed', '受影响运行环境已改变，请重新预检并确认。');
        confirmedObservation = observation;
      } catch (error) { await release(operation); throw error; }
      try {
        const stopped = await stopManagedRuns(ids, { opId: operation.id, holders: confirmedObservation.holders });
        operation.reports.push({ phase: 'stop', status: stopped?.complete === true ? 'reported' : 'unknown', receipts: Array.isArray(stopped?.receipts) ? stopped.receipts : [] });
        const receipts = stopped?.receipts;
        if (stopped?.complete !== true || !Array.isArray(receipts) || receipts.some(row => !ids.includes(row.rootThreadId) || !['stopped', 'alreadyStopped'].includes(row.status))) return verify(operation);
      } catch (error) { operation.reports.push({ phase: 'stop', status: 'unknown', ...problem(error) }); return verify(operation); }
      const afterStop = await writers(ids);
      if (!afterStop.complete || afterStop.holders.length) {
        operation.reports.push({ phase: 'stopVerification', status: 'blocked', holders: afterStop.holders, complete: afterStop.complete });
        return verify(operation);
      }
      try { await checkFresh(plan); }
      catch (error) { await release(operation); throw error; }
      operation.reports.push({ phase: 'scopeRecheck', status: 'unchanged', threadIds: ids });
      const beforeArchive = await writers(ids);
      if (!beforeArchive.complete || beforeArchive.holders.length) {
        operation.reports.push({ phase: 'finalWriterCheck', status: 'blocked', holders: beforeArchive.holders, complete: beforeArchive.complete });
        return verify(operation);
      }
      if (!plan.affected.every(row => row.archived)) {
        operation.phase = 'archivePending'; operation.archiveAttempted = true; operation.requestUncertain = true;
        try { await persist(); }
        catch (error) { operation.archiveAttempted = false; operation.requestUncertain = false; throw error; }
        try { await rpc.call('thread/archive', { threadId: plan.threadId }); operation.requestUncertain = false; operation.reports.push({ phase: 'archive', status: 'returned' }); }
        catch (error) {
          operation.requestUncertain = !['upstream_error', 'method_forbidden'].includes(error?.code);
          operation.reports.push({ phase: 'archive', status: operation.requestUncertain ? 'unknown' : 'rejected', ...problem(error) });
        }
        operation.phase = 'archiveSettled';
        try { await persist(); }
        catch (error) { operation.storageFault = true; operation.reports.push({ phase: 'receipt', status: 'unknown', ...problem(error) }); }
      } else operation.reports.push({ phase: 'archive', status: 'alreadyArchived' });
      return verify(operation);
    })().catch(async error => {
      if (!operation.freezeRetained) {
        if (onOperation) {
          operation.phase = operation.archiveAttempted ? 'blocked' : 'preflightRejected';
          operation.reports.push({ phase: 'blocked', status: operation.archiveAttempted ? 'unknown' : 'notAttempted', ...problem(error) });
          operation.result = receipt(operation, operation.archiveAttempted ? 'unknown' : 'failed', operation.phase);
          error.operationId = operation.id; error.archiveAttempted = operation.archiveAttempted;
        } else operations.delete(operation.id);
        try { await persist(); } catch { /* A retained on-disk receipt can only be rechecked, never replayed. */ }
      }
      else {
        operation.reports.push({ phase: 'blocked', status: 'unknown', ...problem(error) });
        operation.phase = 'blocked'; operation.result = receipt(operation, 'unknown', 'blocked');
        try { await persist(); } catch { operation.storageFault = true; }
        if (!(error instanceof RelayError)) error = new RelayError(500, 'archive_operation_failed', '归档操作尚未完成，请重新核验。');
        error.operationId = operation.id; error.freezeRetained = true;
      }
      throw error;
    }).finally(() => { plan.executing = false; });
    operation.promise = plan.promise;
    return plan.promise;
  };
  const recheck = async (operationId, owner) => {
    await ready;
    const operation = ownedOperation(operationId, owner);
    if (operation.promise && operation.phase === 'preflightLinked') { try { await operation.promise; } catch (error) { if (!operation.result) throw error; } }
    if (!operation.archiveAttempted && !operation.freezeRetained && ['preflightLinked', 'preflightRejected'].includes(operation.phase)) {
      operation.phase = 'preflightRejected'; operation.result = receipt(operation, 'failed', operation.phase); await persist(); return operation.result;
    }
    if (!operation.result) { await operation.promise; if (!operation.result) fail(409, 'archive_not_executed', '该操作未执行归档，请重新预检。'); }
    if (!operation.recheckPromise) { operation.storageFault = false; operation.recheckPromise = verify(operation).finally(() => { operation.recheckPromise = null; }); }
    return operation.recheckPromise;
  };
  const listOperations = async owner => {
    await ready;
    if (!validOwner(owner)) fail(400, 'invalid_archive_parameters', '登录工作台身份无效。');
    const scope = digest(owner);
    return [...operations.values()].filter(operation => operation.ownerScope === scope && (operation.freezeRetained || !operation.result || operation.result.status === 'unknown')).map(operation => ({ operationId: operation.id, threadId: operation.threadId, status: operation.result?.status || 'unknown', phase: operation.phase, affectedCount: operation.affected.length, freezeRetained: operation.freezeRetained, archiveAttempted: operation.archiveAttempted, createdAt: operation.createdAt, updatedAt: operation.updatedAt }));
  };
  const frozen = threadId => [...operations.values()].some(operation => operation.freezeRetained && operation.affected.some(row => row.id === threadId));
  const isFrozen = async threadId => { await ready; return frozen(threadId); };
  const admit = async (threadId, dispatch) => { await ready; if (frozen(threadId)) fail(409, 'thread_frozen', '归档核验尚未结束，暂不能修改此对话。'); return dispatch(); };
  return { preview, execute, recheck, listOperations, isFrozen, admit, ready };
}
