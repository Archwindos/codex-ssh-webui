import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, resolve, relative, sep, dirname, join, basename } from 'node:path';
import { fail, RelayError } from './protocol.mjs';

const invalidCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !invalidCharacters.test(value) && isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/.test(value));
const within = (root, cwd) => { const path = relative(root, cwd); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };

export function validateWorkspaceConfig(config, mock) {
  if (config.workspace === undefined) return;
  const w = config.workspace;
  if ((!mock && config.transport !== 'local') || !w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some(key => !['roots', 'defaultCwd'].includes(key)) || !Array.isArray(w.roots) || w.roots.length < 1 || w.roots.length > 20 || w.roots.some(root => !validPath(root)) || !validPath(w.defaultCwd)) fail(500, 'configuration', 'workspace 需要本机 local transport、绝对路径 roots 和 defaultCwd。');
}

// Paths stay in the filesystem API. No request path is interpolated into a command.
export async function createWorkspaceBrowser(config, { filesystem = fs } = {}) {
  const directory = async value => {
    try {
      const cwd = await filesystem.realpath(value);
      if (!validPath(cwd)) fail(400, 'invalid_path', '文件夹链接指向无法使用的路径。');
      if (!(await filesystem.stat(cwd)).isDirectory()) fail(400, 'not_directory', '所选路径不是文件夹。');
      await filesystem.access(cwd, constants.R_OK | constants.X_OK);
      return cwd;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail(404, 'directory_not_found', '文件夹不存在。');
      if (error.code === 'EACCES' || error.code === 'EPERM') fail(403, 'directory_unreadable', '当前账号无法读取或进入该文件夹。');
      fail(400, 'invalid_path', '文件夹路径无法使用。');
    }
  };
  let roots;
  try { roots = [...new Set(await Promise.all(config.roots.map(directory)))]; }
  catch { fail(500, 'configuration', 'workspace roots 必须为当前账号可读取和进入的文件夹。'); }
  const allowed = cwd => roots.some(root => within(root, cwd));
  const canonical = async value => {
    if (!validPath(value)) fail(400, 'invalid_path', '需要有效的本机绝对文件夹路径。');
    if (!allowed(resolve(value))) fail(403, 'workspace_forbidden', '文件夹超出已配置范围。');
    const cwd = await directory(value);
    if (!allowed(cwd)) fail(403, 'workspace_forbidden', '文件夹链接超出已配置范围。');
    return cwd;
  };
  let defaultCwd;
  try { defaultCwd = await canonical(config.defaultCwd); }
  catch { fail(500, 'configuration', 'workspace defaultCwd 必须为范围内可访问的文件夹。'); }
  const browse = async value => {
    const cwd = await canonical(value === undefined ? defaultCwd : value), entries = [];
    let limited = false, count = 0;
    try {
      const directory = await filesystem.opendir(cwd);
      for await (const entry of directory) {
        if (++count > 2000 || entries.length >= 200) { limited = true; break; }
        if ((!entry.isDirectory() && !entry.isSymbolicLink()) || invalidCharacters.test(entry.name)) continue;
        try { entries.push({ name: entry.name, cwd: await canonical(join(cwd, entry.name)) }); }
        catch (error) { if (!(error instanceof RelayError)) throw error; }
      }
    } catch (error) {
      if (error instanceof RelayError) throw error;
      fail(403, 'directory_unreadable', '当前账号无法列出该文件夹。');
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(cwd);
    return { cwd, parent: parent !== cwd && allowed(parent) ? parent : null, entries, roots, limited };
  };
  return { roots, defaultCwd, canonical, browse };
}

const projectLimit = 1000;
const projectId = value => typeof value === 'string' && value !== 'all' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const projectName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !invalidCharacters.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Named bindings belong to this relay only. Discovered directories remain temporary.
export async function createProjectRegistry(seeds, { workspace, storeFile = null, filesystem = fs } = {}) {
  const projects = new Map(), stored = new Map();
  const readStore = async () => {
    if (!storeFile) return [];
    try {
      const stat = await filesystem.lstat(storeFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('invalid store');
      const data = JSON.parse(await filesystem.readFile(storeFile, 'utf8'));
      if (!sameKeys(data, ['schemaVersion', 'projects']) || data.schemaVersion !== 1 || !Array.isArray(data.projects) || data.projects.length > projectLimit) throw Error('invalid schema');
      const ids = new Set();
      for (const p of data.projects) {
        if (!sameKeys(p, ['id', 'name', 'cwd', 'revision', 'managed']) || !projectId(p.id) || ids.has(p.id) || !projectName(p.name) || !validPath(p.cwd) || !revision(p.revision) || p.managed !== true) throw Error('invalid project');
        ids.add(p.id);
      }
      await filesystem.chmod(storeFile, 0o600);
      return data.projects;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      fail(500, 'project_store_invalid', '项目登记文件无法安全读取，请检查本机登记文件。');
    }
  };
  const mergeStored = async entries => {
    for (const p of entries) {
      stored.set(p.id, p);
      try { projects.set(p.id, { ...p, cwd: await workspace.canonical(p.cwd) }); }
      catch { projects.delete(p.id); } // Preserve unavailable records on disk without offering them as real directories.
    }
  };
  for (const p of seeds) {
    try { projects.set(p.id, { id: p.id, name: p.name, cwd: await workspace.canonical(p.cwd), revision: 1, managed: true }); }
    catch { /* Configured examples and unavailable directories are not usable projects. */ }
  }
  await mergeStored(await readStore());
  if (new Set([...stored.keys(), ...projects.keys()]).size > projectLimit) fail(500, 'project_store_invalid', '项目登记数量超出上限。');
  const directoryProject = (map, cwd) => [...map.values()].find(p => p.cwd === cwd && p.managed) || [...map.values()].find(p => p.cwd === cwd);
  const discover = (map, cwd) => {
    const existing = directoryProject(map, cwd);
    if (existing) return existing;
    if (map.size >= projectLimit) fail(429, 'project_limit', '项目登记数量达到上限。');
    let id;
    for (let n = 0; n <= projectLimit; n++) {
      id = `workspace-${createHash('sha256').update(n ? `${cwd}\0${n}` : cwd).digest('hex').slice(0, 32)}`;
      if (!map.has(id) && !stored.has(id)) break;
      id = null;
    }
    if (!id) fail(409, 'project_conflict', '项目标识冲突。');
    const p = { id, name: (basename(cwd) || cwd).slice(0, 100), cwd, revision: 1, managed: false };
    map.set(id, p); return p;
  };
  const persist = async entries => {
    const temporary = `${storeFile}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await filesystem.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, projects: entries }, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = null;
      await filesystem.rename(temporary, storeFile);
    } finally {
      await handle?.close();
      await filesystem.rm(temporary, { force: true });
    }
  };
  let pending = Promise.resolve();
  const change = action => {
    const result = pending.then(async () => {
      let lock;
      try {
        if (storeFile) {
          await filesystem.mkdir(dirname(storeFile), { recursive: true, mode: 0o700 });
          try { lock = await filesystem.open(`${storeFile}.lock`, 'wx', 0o600); }
          catch (error) { if (error.code === 'EEXIST') fail(409, 'project_store_busy', '项目登记正在保存，请稍后刷新重试。'); throw error; }
          await mergeStored(await readStore());
        }
        const draft = new Map(projects), result = await action(draft);
        const records = new Map(stored);
        for (const p of draft.values()) if (p.managed) records.set(p.id, p);
        if (records.size > projectLimit) fail(429, 'project_limit', '项目登记数量达到上限。');
        if (storeFile) await persist([...records.values()]);
        stored.clear(); for (const [id, p] of records) stored.set(id, p);
        projects.clear(); for (const [id, p] of draft) projects.set(id, p);
        return result;
      } catch (error) {
        if (error instanceof RelayError) throw error;
        fail(500, 'project_store_unavailable', '项目登记保存失败，目录绑定未修改。');
      } finally {
        if (lock) { await lock.close(); await filesystem.rm(`${storeFile}.lock`, { force: true }); }
      }
    });
    pending = result.catch(() => {});
    return result;
  };
  const register = async value => { const cwd = await workspace.canonical(value); await pending; return discover(projects, cwd); };
  const create = async (value, name) => {
    if (name !== undefined && !projectName(name)) fail(400, 'invalid_project_name', '项目名称需要 1–100 个可显示字符。');
    const cwd = await workspace.canonical(value);
    return change(draft => {
      const p = discover(draft, cwd);
      if (p.managed && name !== undefined && name.trim() !== p.name) fail(409, 'project_conflict', '该目录已有项目，请刷新后通过修改项目名称保存。');
      const current = p.managed ? p : { ...p, name: name === undefined ? p.name : name.trim(), managed: true, revision: p.revision + (projects.has(p.id) ? 1 : 0) };
      draft.set(current.id, current); return current;
    });
  };
  const update = async (id, value, name, expectedRevision) => {
    if (!projectId(id) || !revision(expectedRevision)) fail(400, 'invalid_parameters', '项目 id 或版本无效。');
    if (name !== undefined && !projectName(name)) fail(400, 'invalid_project_name', '项目名称需要 1–100 个可显示字符。');
    const cwd = await workspace.canonical(value);
    return change(async draft => {
      const p = draft.get(id);
      if (!p) fail(400, 'project_forbidden', '项目尚未登记。');
      if (p.revision !== expectedRevision || p.revision === Number.MAX_SAFE_INTEGER) fail(409, 'project_conflict', '项目已被修改，请刷新后重试。');
      const existing = directoryProject(draft, cwd);
      if (cwd !== p.cwd && existing?.managed && existing.id !== id) fail(409, 'project_conflict', '该目录已绑定其他项目。');
      const current = { ...p, name: name === undefined ? p.name : name.trim(), cwd, revision: p.revision + 1, managed: true };
      draft.set(id, current);
      let previousProject;
      if (p.cwd !== cwd) {
        try { previousProject = discover(draft, await workspace.canonical(p.cwd)); }
        catch (error) { if (!(error instanceof RelayError) || error.code === 'project_limit') throw error; }
      }
      return { project: current, projects: [...draft.values()], ...(previousProject ? { previousProject } : {}) };
    });
  };
  return { projects, register, create, update };
}
