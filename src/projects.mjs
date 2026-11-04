import { randomUUID } from 'node:crypto';
import { fail, RelayError, safeThread, THREAD_SOURCE_KINDS } from './protocol.mjs';

// Verified in the official 0.165.0 state schema; pinning is a native section move.
export const PINNED_THREAD_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const validPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && value.length <= 4096 && !controls.test(value);
const validName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !controls.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const integer = value => Number.isSafeInteger(value) ? value : null;

export function safeProject(project) {
  if (!validId(project?.id) || !validName(project?.name) || !Array.isArray(project.roots) || project.roots.length > 20 || project.roots.some(root => !validPath(root?.path))) fail(502, 'project_metadata_invalid', '原生项目元数据不完整。');
  const roots = project.roots.map(root => ({ path: root.path }));
  return { id: project.id, name: project.name, roots, defaultCwd: roots[0]?.path || null, native: true, position: integer(project.position), createdAt: integer(project.createdAt), updatedAt: integer(project.updatedAt), recencyAt: integer(project.recencyAt) };
}

function pageOptions(value = {}, allowed = []) {
  if (!keys(value, ['cursor', 'limit', ...allowed]) || (value.cursor !== undefined && value.cursor !== null && (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 4096 || controls.test(value.cursor))) || (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100))) fail(400, 'invalid_query', '列表参数无效。');
  return { limit: value.limit ?? 50, ...(value.cursor ? { cursor: value.cursor } : {}) };
}

function projectPage(result) {
  if (!Array.isArray(result?.data) || result.data.length > 100 || (result.nextCursor !== null && typeof result.nextCursor !== 'string')) fail(502, 'project_metadata_invalid', '原生项目列表响应无效。');
  return { data: result.data.map(safeProject), nextCursor: result.nextCursor };
}

function nativeThread(thread) {
  if (!validId(thread?.id) || !Object.hasOwn(thread, 'projectId') || (thread.projectId !== null && !validId(thread.projectId)) || !Object.hasOwn(thread, 'section') || (thread.section !== null && !validId(thread.section?.id))) fail(502, 'thread_metadata_invalid', '会话缺少有效的原生项目或分区元数据。');
  return safeThread(thread);
}

// This service stores no project/thread shadow database and never groups by cwd.
export function createNativeProjectService({ rpc, canonical } = {}) {
  if (typeof rpc?.call !== 'function' || (canonical !== undefined && typeof canonical !== 'function')) fail(500, 'project_configuration', '原生项目服务需要官方 RPC 连接。');
  let capabilityProbe;
  const probe = ({ refresh = false } = {}) => {
    if (refresh) capabilityProbe = null;
    capabilityProbe ||= (async () => {
      try {
        projectPage(await rpc.call('project/list', { limit: 1 }));
        const sections = await rpc.call('threadSection/list', { limit: 100 });
        if (!Array.isArray(sections?.data)) fail(502, 'project_metadata_invalid', '原生分区列表响应无效。');
        const page = await rpc.call('thread/list', { limit: 1, sourceKinds: THREAD_SOURCE_KINDS, useStateDbOnly: true });
        if (!Array.isArray(page?.data) || page.data.some(thread => !Object.hasOwn(thread, 'projectId') || !Object.hasOwn(thread, 'section'))) fail(502, 'project_metadata_invalid', '会话缺少原生项目或置顶元数据。');
        return { nativeProjects: true, projectManagement: true, threadMetadata: true, threadNaming: true, threadPinning: true, projectAssignment: true };
      } catch (error) {
        return { nativeProjects: false, projectManagement: false, threadMetadata: false, threadNaming: false, threadPinning: false, projectAssignment: false, error: { code: 'native_projects_unavailable', reason: error instanceof RelayError ? error.code : 'capability_probe_failed', message: '当前官方 CLI 未能确认原生项目与会话元数据能力。' } };
      }
    })();
    return capabilityProbe;
  };
  const available = async () => { if (!(await probe()).nativeProjects) fail(503, 'native_projects_unavailable', '原生项目能力不可用，未使用目录分组或本地记录代替。'); };
  const id = (value, type = 'project') => { if (!validId(value) || value === 'all') fail(400, `invalid_${type}`, `${type === 'project' ? '项目' : '会话'} id 无效。`); return value; };
  const normalizeRoots = async roots => {
    if (!Array.isArray(roots) || roots.length > 20 || roots.some(root => !keys(root, ['path']) || !validPath(root.path))) fail(400, 'invalid_path', '项目目录需要有效的绝对路径。');
    const paths = [];
    for (const root of roots) {
      const path = canonical ? await canonical(root.path) : root.path;
      if (!validPath(path)) fail(400, 'invalid_path', '项目目录需要有效的绝对路径。');
      if (!paths.includes(path)) paths.push(path);
    }
    return paths.map(path => ({ path }));
  };
  const projectPatch = async (patch, create = false) => {
    if (!keys(patch, ['name', 'defaultCwd', 'roots', ...(create ? ['idempotencyKey'] : [])]) || (!create && !Object.keys(patch).length) || (create && !Object.hasOwn(patch, 'name')) || (Object.hasOwn(patch, 'name') && !validName(patch.name)) || (Object.hasOwn(patch, 'defaultCwd') && patch.defaultCwd !== null && !validPath(patch.defaultCwd)) || (Object.hasOwn(patch, 'roots') && Object.hasOwn(patch, 'defaultCwd'))) fail(400, 'invalid_project', '项目名称或默认目录无效。');
    const result = {};
    if (Object.hasOwn(patch, 'name')) result.name = patch.name.trim();
    if (Object.hasOwn(patch, 'roots')) result.roots = await normalizeRoots(patch.roots);
    else if (Object.hasOwn(patch, 'defaultCwd') || create) result.roots = await normalizeRoots(patch.defaultCwd ? [{ path: patch.defaultCwd }] : []);
    if (create) {
      const key = patch.idempotencyKey ?? randomUUID();
      if (typeof key !== 'string' || !key || key.length > 200 || controls.test(key)) fail(400, 'invalid_idempotency_key', '创建请求标识无效。');
      result.idempotencyKey = key;
    }
    return result;
  };
  const list = async (options = {}) => { const params = pageOptions(options); await available(); return projectPage(await rpc.call('project/list', params)); };
  const read = async projectId => { id(projectId); await available(); return safeProject((await rpc.call('project/read', { projectId })).project); };
  const create = async value => { const params = await projectPatch(value, true); await available(); return safeProject((await rpc.call('project/create', params)).project); };
  const update = async (projectId, patch) => {
    id(projectId); const params = await projectPatch(patch); await available();
    // An existing multi-root project must be edited explicitly, never collapsed by a one-directory UI.
    if (Object.hasOwn(patch, 'defaultCwd') && (await read(projectId)).roots.length > 1) fail(409, 'multiple_project_roots', '该原生项目有多个目录，请显式编辑完整目录列表。');
    return safeProject((await rpc.call('project/update', { projectId, ...params })).project);
  };
  const move = async (projectId, beforeProjectId = null) => {
    id(projectId); if (beforeProjectId !== null) id(beforeProjectId);
    if (beforeProjectId === projectId) fail(400, 'invalid_project', '项目不能移到自身之前。');
    await read(projectId); if (beforeProjectId) await read(beforeProjectId);
    await rpc.call('project/move', { projectId, beforeProjectId });
    return read(projectId);
  };
  const remove = async projectId => { id(projectId); await available(); await rpc.call('project/delete', { projectId }); return { removed: true }; };
  const listThreads = async (options = {}) => {
    const params = { ...pageOptions(options, ['projectId', 'pinned', 'searchTerm', 'archived', 'includeInternal']), sourceKinds: THREAD_SOURCE_KINDS, useStateDbOnly: true };
    if (options.includeInternal !== undefined && typeof options.includeInternal !== 'boolean') fail(400, 'invalid_query', '内部会话筛选必须为布尔值。');
    if (Object.hasOwn(options, 'projectId')) params.projectId = options.projectId === null ? null : id(options.projectId);
    if (options.pinned !== undefined && options.pinned !== true) fail(400, 'invalid_query', '置顶筛选只接受 true；省略时包含所有分区。');
    if (options.pinned) params.sectionId = PINNED_THREAD_SECTION_ID;
    if (options.searchTerm !== undefined) {
      if (typeof options.searchTerm !== 'string' || options.searchTerm.length > 200 || controls.test(options.searchTerm)) fail(400, 'invalid_query', '搜索文字无效。');
      if (options.searchTerm.trim()) params.searchTerm = options.searchTerm.trim();
    }
    if (options.archived !== undefined) { if (typeof options.archived !== 'boolean') fail(400, 'invalid_query', '归档筛选无效。'); params.archived = options.archived; }
    await available();
    const data = [], seen = new Set(), cursors = new Set(params.cursor ? [params.cursor] : []), limit = params.limit;
    let cursor = params.cursor;
    for (let page = 0; page < 10; page++) {
      const requested = limit - data.length;
      const result = await rpc.call('thread/list', { ...params, limit: requested, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || result.data.length > requested || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || controls.test(result.nextCursor)))) fail(502, 'thread_metadata_invalid', '会话列表响应无效。');
      for (const value of result.data) {
        const thread = nativeThread(value);
        if ((!options.includeInternal && value.source?.subAgent?.other === 'guardian') || seen.has(thread.id)) continue;
        seen.add(thread.id); data.push(thread);
      }
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) fail(502, 'thread_metadata_invalid', '会话列表返回了重复游标。');
      if (!cursor || data.length === limit) break;
      cursors.add(cursor);
    }
    return { data, nextCursor: cursor || null };
  };
  const readThread = async threadId => { id(threadId, 'thread'); await available(); const result = await rpc.call('thread/read', { threadId, includeTurns: false }); if (result?.thread?.id !== threadId) fail(502, 'thread_metadata_invalid', '会话元数据响应无效。'); return nativeThread(result.thread); };
  const updateThread = async (threadId, patch) => {
    id(threadId, 'thread');
    if (!keys(patch, ['name', 'pinned', 'projectId']) || !Object.keys(patch).length || (Object.hasOwn(patch, 'name') && !validName(patch.name)) || (Object.hasOwn(patch, 'pinned') && typeof patch.pinned !== 'boolean') || (Object.hasOwn(patch, 'projectId') && patch.projectId !== null && !validId(patch.projectId))) fail(400, 'invalid_thread_metadata', '会话名称、置顶或项目归属无效。');
    if (patch.projectId !== undefined && patch.projectId !== null) await read(patch.projectId);
    const before = await readThread(threadId), writes = [];
    if (Object.hasOwn(patch, 'projectId') && patch.projectId !== before.projectId) writes.push(['projectId', 'thread/metadata/update', { threadId, projectId: patch.projectId ?? '' }]);
    if (Object.hasOwn(patch, 'name') && patch.name.trim() !== before.name) writes.push(['name', 'thread/name/set', { threadId, name: patch.name.trim() }]);
    if (Object.hasOwn(patch, 'pinned') && patch.pinned !== before.pinned) writes.push(['pinned', 'thread/section/move', { threadId, sectionId: patch.pinned ? PINNED_THREAD_SECTION_ID : null }]);
    const attempted = [];
    try {
      for (const [field, method, params] of writes) { attempted.push(field); await rpc.call(method, params); }
      const result = await readThread(threadId);
      if ((Object.hasOwn(patch, 'projectId') && result.projectId !== patch.projectId) || (Object.hasOwn(patch, 'name') && result.name !== patch.name.trim()) || (Object.hasOwn(patch, 'pinned') && result.pinned !== patch.pinned)) fail(502, 'metadata_not_saved', '原生会话元数据未能核对。');
      return result;
    } catch (error) {
      if (!attempted.length) throw error;
      const failure = new RelayError(502, 'metadata_update_partial', '会话元数据更新未能全部确认，部分字段可能已经改变；请刷新核对，勿自动重发。');
      failure.attemptedFields = attempted; throw failure;
    }
  };
  return { probe, list, read, create, update, move, remove, listThreads, readThread, updateThread };
}

// A review-only migration proposal: retain saved legacy entries, never import or reassign threads.
export function legacyProjectMigrationCandidates(projects = []) {
  if (!Array.isArray(projects) || projects.length > 1000) fail(500, 'project_store_invalid', '旧项目清单无效。');
  return projects.filter(project => project?.managed === true).map(project => ({ legacyId: project.id, name: project.name, defaultCwd: project.cwd, revision: project.revision, nativeProjectId: null, status: 'requires_explicit_mapping' }));
}
