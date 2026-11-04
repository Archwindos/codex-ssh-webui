import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fail, RelayError } from './protocol.mjs';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const token = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const cleanError = error => ({ code: error instanceof RelayError ? error.code : 'project_action_failed', message: error instanceof RelayError ? error.message : '项目操作未能完成核验。' });
const projectIdentity = project => hash([project.id, project.name, project.roots, project.updatedAt]);
const memberIdentity = members => hash(members.map(row => [row.id, row.projectId, row.cwd, row.archived]).sort((a, b) => a[0].localeCompare(b[0])));
const assignmentIdentity = members => hash(members.map(row => [row.id, row.projectId]).sort((a, b) => a[0].localeCompare(b[0])));
const atomicityMessage = '只暂停本网页相关聊天的修改；其他 Codex 客户端仍可改变项目、聊天或关联子对话。操作会分项核验，不保证整个项目一次完成。';
const limit = { members: 1000, affected: 1000, roots: 50, operations: 50, plans: 50, pages: 100, ttl: 120000 };

// Project actions coordinate existing native metadata and archive receipts.
// They never send prompts, stop processes, or invent native pin/section fields.
export async function createProjectActions({ catalog, archive, storeFile = null, viewStoreFile = null, filesystem = fs, clock = Date.now } = {}) {
  if (!catalog?.list || !catalog?.read || !catalog?.remove || !archive?.preview || !archive?.execute || !archive?.recheck) fail(500, 'project_action_configuration', '项目操作需要完整原生接口。');
  for (const path of [storeFile, viewStoreFile]) if (path !== null && (typeof path !== 'string' || !isAbsolute(path))) fail(500, 'project_action_configuration', '项目操作存储路径无效。');
  const plans = new Map(), operations = new Map();
  let view = { viewScope: 'webui', pinnedProjectIds: [], sections: [], memberships: {} }, saveQueue = Promise.resolve(), viewQueue = Promise.resolve();
  const load = async path => {
    if (!path) return null;
    try {
      const stat = await filesystem.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077))) throw Error('Unsafe store');
      return JSON.parse(await filesystem.readFile(path, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; fail(500, 'project_action_store', '项目操作记录无法安全读取。'); }
  };
  const save = (path, value) => {
    if (!path) return Promise.resolve();
    const operation = saveQueue.catch(() => {}).then(async () => {
      await filesystem.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (await filesystem.realpath(dirname(path)) !== dirname(path)) fail(500, 'project_action_store', '项目操作目录不能经过符号链接。');
      const temporary = `${path}.${token()}.tmp`; let handle;
      try { handle = await filesystem.open(temporary, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = null; await filesystem.rename(temporary, path); if (process.platform !== 'win32') { const parent = await filesystem.open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); } } }
      catch { fail(500, 'project_action_store', '项目操作回执保存失败，未确认的步骤不会继续。'); }
      finally { if (handle) await handle.close(); await filesystem.rm(temporary, { force: true }); }
    });
    saveQueue = operation; return operation;
  };
  const validateView = data => {
    if (!data || data.viewScope !== 'webui' || !Array.isArray(data.pinnedProjectIds) || data.pinnedProjectIds.length > 1000 || data.pinnedProjectIds.some(value => !id(value)) || new Set(data.pinnedProjectIds).size !== data.pinnedProjectIds.length || !Array.isArray(data.sections) || data.sections.length > 100 || data.sections.some(section => !id(section?.id) || typeof section.name !== 'string' || !section.name.trim() || section.name.length > 100 || /[\u0000-\u001f\u007f]/.test(section.name)) || new Set(data.sections.map(section => section.id)).size !== data.sections.length || !data.memberships || typeof data.memberships !== 'object' || Array.isArray(data.memberships) || Object.keys(data.memberships).length > 1000 || Object.entries(data.memberships).some(([projectId, sectionId]) => !id(projectId) || !data.sections.some(section => section.id === sectionId))) fail(500, 'project_view_store', '网页项目分组记录无效。');
    return clone(data);
  };
  const stored = await load(storeFile);
  if (stored) {
    if (stored.schemaVersion !== 1 || !Array.isArray(stored.operations) || stored.operations.length > limit.operations) fail(500, 'project_action_store', '项目操作记录格式无效。');
    for (const op of stored.operations) {
      if (!id(op?.operationId) || operations.has(op.operationId) || !/^[a-f0-9]{64}$/.test(op.ownerScope) || !id(op.projectId) || !['archive', 'remove'].includes(op.kind) || !Array.isArray(op.affected) || op.affected.length > limit.affected || op.affected.some(row => !id(row?.id)) || !Array.isArray(op.roots) || op.roots.length > limit.roots || op.roots.some(root => !id(root?.threadId) || (root.operationId != null && !id(root.operationId))) || !['executing', 'complete', 'partial', 'unknown', 'failed'].includes(op.status) || typeof op.freezeRetained !== 'boolean') fail(500, 'project_action_store', '项目操作回执格式无效。');
      if (op.status === 'executing') { op.status = 'unknown'; op.freezeRetained = true; }
      operations.set(op.operationId, op);
    }
  }
  const storedView = await load(viewStoreFile); if (storedView) view = validateView(storedView);
  const persist = () => save(storeFile, { schemaVersion: 1, operations: [...operations.values()].map(op => { const { promise, recheckPromise, ...record } = op; return record; }) });
  const publicOperation = op => { const { ownerScope, promise, recheckPromise, ...result } = op; return clone({ ...result, atomicity: 'gateway-admission-only', atomicityMessage, filesDeleted: false, chatsDeleted: false }); };
  const listProjects = async () => {
    const result = []; let cursor; const seen = new Set();
    for (let page = 0; page < limit.pages; page++) { const data = await catalog.list({ limit: 100, cursor }); result.push(...data.data); if (result.length > 5000) break; if (!data.nextCursor) return result; if (seen.has(data.nextCursor)) break; seen.add(data.nextCursor); cursor = data.nextCursor; }
    fail(502, 'project_members_incomplete', '项目列表未完整读取。');
  };
  const members = async projectId => {
    const result = [], ids = new Set();
    for (const archived of [false, true]) {
      let cursor; const seen = new Set();
      for (let page = 0; page < limit.pages; page++) {
        const data = await catalog.listThreads({ projectId, archived, includeInternal: true, limit: 100, cursor });
        for (const thread of data.data) { if (!id(thread?.id) || thread.projectId !== projectId || ids.has(thread.id)) fail(409, 'project_members_changed', '项目成员出现重复或归属冲突，请重新预览。'); ids.add(thread.id); result.push({ ...thread, archived }); }
        if (result.length > limit.members) fail(409, 'project_action_limit', '项目聊天超出安全上限。');
        if (!data.nextCursor) break;
        if (seen.has(data.nextCursor) || page === limit.pages - 1) fail(502, 'project_members_incomplete', '项目聊天未完整读取。'); seen.add(data.nextCursor); cursor = data.nextCursor;
      }
    }
    return result;
  };
  const assignments = async affected => {
    const result = [];
    for (const row of affected) { const thread = await catalog.readThread(row.id); if (thread.id !== row.id) fail(502, 'project_members_changed', '关联聊天身份无法核对。'); result.push({ id: row.id, projectId: thread.projectId }); }
    return result;
  };
  const fresh = async plan => {
    const project = await catalog.read(plan.projectId), current = await members(plan.projectId);
    if (projectIdentity(project) !== plan.projectFingerprint || memberIdentity(current) !== memberIdentity(plan.expectedMembers) || assignmentIdentity(await assignments(plan.affected)) !== plan.assignmentFingerprint) fail(409, 'project_plan_changed', '项目成员、关联归属或项目资料已改变，请重新预览并确认。');
  };
  const newPlan = plan => {
    for (const [key, value] of plans) if (!value.promise && clock() >= value.expiresAt) plans.delete(key);
    if (plans.size >= limit.plans) fail(429, 'project_action_limit', '待确认项目操作过多。');
    plan.planId = token(); plan.operationId = `project-${token()}`; plan.expiresAt = clock() + limit.ttl; plans.set(plan.planId, plan); return plan;
  };
  const preview = async (kind, projectId, owner) => {
    if (!['archive', 'remove'].includes(kind) || !id(projectId) || typeof owner !== 'string' || !owner) fail(400, 'invalid_project_action', '项目操作参数无效。');
    const project = await catalog.read(projectId), all = await members(projectId), roots = [], affected = new Map(), blockedReasons = [];
    if (kind === 'archive') {
      const targets = all.filter(thread => !thread.archived), targetIds = new Set(targets.map(thread => thread.id));
      if (!targets.length) blockedReasons.push({ code: 'project_no_active_chats', message: '项目没有需要归档的聊天。' });
      // Parent metadata only chooses preview order. Authoritative preview
      // closures, rather than local ancestry, decide actual coverage.
      const ordered = [...targets].sort((a, b) => Number(targetIds.has(a.parentThreadId)) - Number(targetIds.has(b.parentThreadId)) || a.id.localeCompare(b.id));
      for (const target of ordered) {
        if (affected.has(target.id)) continue;
        if (roots.length >= limit.roots) { blockedReasons.push({ code: 'project_action_limit', message: '项目包含过多独立归档根，未执行操作。' }); break; }
        const detail = await archive.preview(target.id, owner);
        if (!detail.canArchive) blockedReasons.push(...(detail.blockedReasons || [{ code: 'project_archive_blocked', message: '关联聊天当前不能归档。' }]));
        const ids = new Set(detail.affected.map(row => row.id));
        for (const prior of roots) {
          const overlap = prior.affectedIds.some(value => ids.has(value));
          if (overlap && (!ids.has(prior.threadId) || prior.affectedIds.includes(target.id))) fail(409, 'project_plan_changed', '归档子树相互重叠，无法确定独立执行边界。');
        }
        for (let index = roots.length - 1; index >= 0; index--) if (ids.has(roots[index].threadId)) roots.splice(index, 1);
        roots.push({ threadId: target.id, planId: detail.planId, affectedIds: [...ids] });
        for (const row of detail.affected) affected.set(row.id, row);
        if (affected.size > limit.affected) fail(409, 'project_action_limit', '项目关联聊天超出安全上限。');
      }
      if (targets.some(thread => !affected.has(thread.id))) blockedReasons.push({ code: 'project_members_incomplete', message: '未能完整预览所有项目聊天。' });
    } else for (const thread of all) affected.set(thread.id, { id: thread.id, name: thread.name, cwd: thread.cwd, archived: thread.archived });
    const links = await assignments([...affected.values()]);
    const rows = [...affected.values()].map(row => ({ ...row, projectId: links.find(link => link.id === row.id).projectId, isProjectMember: all.some(member => member.id === row.id) }));
    const outsideProjectIds = rows.filter(row => row.projectId !== projectId).map(row => row.id);
    const plan = blockedReasons.length ? null : newPlan({ kind, projectId, ownerScope: hash(owner), project, projectFingerprint: projectIdentity(project), expectedMembers: all, affected: rows, assignmentFingerprint: assignmentIdentity(links), roots, outsideProjectIds });
    return { kind, projectId, project, planId: plan?.planId || null, operationId: plan?.operationId || null, expiresAt: plan?.expiresAt || null, affected: rows, roots: roots.map(({ planId, ...root }) => root), outsideProjectIds, requiresAssociatedConfirmation: outsideProjectIds.length > 0, requiresConfirmation: true, [kind === 'archive' ? 'canArchive' : 'canRemove']: Boolean(plan), blockedReasons, atomicity: 'gateway-admission-only', atomicityMessage, filesDeleted: false, chatsDeleted: false };
  };
  const own = (operationId, owner) => { const operation = operations.get(operationId); if (!operation || operation.ownerScope !== hash(owner)) fail(403, 'project_operation_forbidden', '项目操作不属于当前工作台。'); return operation; };
  const mergeArchiveResults = operation => {
    const receipts = new Map(); for (const root of operation.roots) for (const row of root.result?.affected || []) receipts.set(row.id, row);
    operation.affected = operation.affected.map(row => ({ ...row, ...(receipts.get(row.id) || {}), status: receipts.get(row.id)?.status || 'notAttempted' }));
    const success = operation.affected.filter(row => ['archived', 'alreadyArchived'].includes(row.status)).length;
    const uncertain = operation.scopeUnknown || operation.roots.some(root => root.status === 'attempting' || root.status === 'unknown' || root.result?.status === 'unknown' || root.result?.freezeRetained);
    operation.status = uncertain ? 'unknown' : success === operation.affected.length && !operation.stopReason ? 'complete' : success ? 'partial' : 'failed'; operation.freezeRetained = uncertain;
  };
  const verifyRemove = async operation => {
    const projects = await listProjects(); operation.projectRemoved = !projects.some(project => project.id === operation.projectId);
    const rows = [];
    for (const row of operation.affected) {
      try { const thread = await catalog.readThread(row.id); rows.push({ ...row, currentProjectId: thread.projectId, status: thread.projectId === null ? 'unassigned' : thread.projectId === operation.projectId ? 'stillAssigned' : 'reassigned' }); }
      catch { rows.push({ ...row, status: 'unknown' }); }
    }
    operation.affected = rows;
    const unknown = rows.some(row => row.status === 'unknown'), okay = rows.every(row => row.status === 'unassigned');
    operation.status = unknown ? 'unknown' : operation.projectRemoved && okay ? 'complete' : operation.projectRemoved ? 'partial' : operation.requestUncertain ? 'unknown' : 'failed'; operation.freezeRetained = operation.status === 'unknown';
    if (operation.projectRemoved) await mutateView(value => { value.pinnedProjectIds = value.pinnedProjectIds.filter(id => id !== operation.projectId); delete value.memberships[operation.projectId]; });
  };
  const execute = async (kind, planId, owner, { includeAssociated = false } = {}) => {
    const plan = plans.get(planId);
    if (!plan || plan.kind !== kind || plan.ownerScope !== hash(owner)) fail(403, 'project_plan_forbidden', '项目确认计划无效。');
    if (plan.outsideProjectIds.length && includeAssociated !== true) fail(409, 'project_associated_confirmation', '请明确确认所列项目外关联聊天。');
    if (plan.promise) return plan.promise;
    if (clock() >= plan.expiresAt) fail(409, 'project_plan_expired', '项目操作确认已过期，请重新预览。');
    if ([...operations.values()].some(op => op.freezeRetained && (op.projectId === plan.projectId || op.affected.some(row => plan.affected.some(target => target.id === row.id))))) fail(409, 'project_frozen', '项目或关联聊天已有未核实操作。');
    for (const [key, op] of operations) if (operations.size >= limit.operations && !op.freezeRetained && op.status !== 'executing') operations.delete(key);
    if (operations.size >= limit.operations) fail(429, 'project_action_limit', '仍有未核实项目操作。');
    const operation = { operationId: plan.operationId, ownerScope: plan.ownerScope, kind, projectId: plan.projectId, project: plan.project, memberSnapshot: plan.expectedMembers.map(row => ({ id: row.id, projectId: row.projectId, cwd: row.cwd, archived: row.archived })), outsideProjectIds: plan.outsideProjectIds, affected: clone(plan.affected), roots: plan.roots.map(root => ({ threadId: root.threadId, affectedIds: root.affectedIds, operationId: null, status: 'notAttempted' })), reports: [], status: 'executing', freezeRetained: true, createdAt: clock(), updatedAt: clock() };
    operations.set(operation.operationId, operation);
    plan.promise = (async () => {
      try {
        await fresh(plan); await persist();
        if (kind === 'remove') {
          for (const row of plan.affected) if (await archive.isFrozen?.(row.id)) fail(409, 'thread_frozen', '项目聊天尚有未核实归档，暂不能移除项目。');
          operation.requestUncertain = true; await persist();
          try { await catalog.remove(plan.projectId); operation.requestUncertain = false; } catch (error) { operation.requestUncertain = !['upstream_error', 'method_forbidden'].includes(error?.code); operation.reports.push(cleanError(error)); }
          await verifyRemove(operation);
        } else {
          for (let index = 0; index < plan.roots.length; index++) {
            await fresh(plan);
            const root = operation.roots[index];
            try {
              root.result = await archive.execute(plan.roots[index].planId, owner, { onOperation: async operationId => { root.operationId = operationId; root.status = 'attempting'; await persist(); } });
              root.operationId = root.result.operationId; root.status = root.result.status;
            } catch (error) { root.status = error.operationId && error.archiveAttempted !== false ? 'unknown' : 'failed'; if (error.operationId) root.operationId = error.operationId; root.error = cleanError(error); break; }
            for (const row of root.result.affected) if (row.verifiedArchived === true) { const member = plan.expectedMembers.find(member => member.id === row.id); if (member) member.archived = true; }
            await persist();
            if (root.result.status !== 'complete' || root.result.freezeRetained) break;
          }
          await fresh(plan);
          mergeArchiveResults(operation);
        }
      } catch (error) { operation.reports.push(cleanError(error)); if (kind === 'archive') { operation.stopReason = cleanError(error).code; mergeArchiveResults(operation); } else { operation.status = operation.requestUncertain ? 'unknown' : operation.projectRemoved ? 'partial' : 'failed'; operation.freezeRetained = operation.status === 'unknown'; } }
      operation.updatedAt = clock();
      try { await persist(); } catch (error) { operation.status = 'unknown'; operation.freezeRetained = true; operation.reports.push(cleanError(error)); }
      return publicOperation(operation);
    })();
    operation.promise = plan.promise; return plan.promise;
  };
  const recheck = async (operationId, owner) => {
    const operation = own(operationId, owner); if (operation.promise) await operation.promise;
    if (!operation.recheckPromise) operation.recheckPromise = (async () => {
      try {
        if (operation.kind === 'remove') await verifyRemove(operation);
        else {
          for (const root of operation.roots) if (root.operationId) { try { root.result = await archive.recheck(root.operationId, owner); root.status = root.result.status; } catch (error) { root.status = 'unknown'; root.error = cleanError(error); } }
          try {
            const expected = clone(operation.memberSnapshot), current = await members(operation.projectId), project = await catalog.read(operation.projectId);
            for (const root of operation.roots) for (const row of root.result?.affected || []) if (row.verifiedArchived === true) { const member = expected.find(member => member.id === row.id); if (member) member.archived = true; }
            const links = await assignments(operation.affected);
            operation.scopeUnknown = false;
            if (projectIdentity(project) !== projectIdentity(operation.project) || memberIdentity(current) !== memberIdentity(expected) || assignmentIdentity(links) !== assignmentIdentity(operation.affected)) { operation.stopReason = 'project_plan_changed'; operation.reports.push({ code: 'project_plan_changed', message: '重核时项目成员或关联归属已经改变；未继续归档。' }); }
          } catch (error) { operation.scopeUnknown = true; operation.reports.push(cleanError(error)); }
          mergeArchiveResults(operation);
        }
      } catch (error) { operation.status = 'unknown'; operation.freezeRetained = true; operation.reports.push(cleanError(error)); }
      operation.updatedAt = clock(); await persist(); return publicOperation(operation);
    })().finally(() => { operation.recheckPromise = null; });
    return operation.recheckPromise;
  };
  async function mutateView(change) {
    const operation = viewQueue.catch(() => {}).then(async () => { const candidate = clone(view); change(candidate); const safe = validateView(candidate); await save(viewStoreFile, safe); view = safe; return clone(view); });
    viewQueue = operation; return operation;
  }
  const pin = async (projectId, pinned) => { if (!id(projectId) || typeof pinned !== 'boolean') fail(400, 'invalid_project_view', '网页置顶参数无效。'); await catalog.read(projectId); return mutateView(view => { view.pinnedProjectIds = view.pinnedProjectIds.filter(value => value !== projectId); if (pinned) view.pinnedProjectIds.push(projectId); }); };
  const isFrozen = threadId => [...operations.values()].some(op => op.freezeRetained && op.affected.some(row => row.id === threadId));
  const admit = async (threadId, dispatch) => { if (isFrozen(threadId)) fail(409, 'thread_frozen', '项目操作尚未完成核验，暂不能修改此聊天。'); return dispatch(); };
  return { preview, execute, recheck, view: () => clone(view), pin, isFrozen, admit, isProjectFrozen: projectId => [...operations.values()].some(op => op.freezeRetained && op.projectId === projectId), listOperations: (owner, { includeComplete = false } = {}) => [...operations.values()].filter(op => op.ownerScope === hash(owner) && (includeComplete || op.freezeRetained || ['unknown', 'partial'].includes(op.status))).map(publicOperation) };
}
