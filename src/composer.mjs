import { fail } from './protocol.mjs';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const value = (input, max = 200) => typeof input === 'string' && input.length > 0 && input.length <= max && !/[\u0000-\u001f\u007f]/.test(input) ? input : null;
const counter = number => Number.isSafeInteger(number) && number >= 0 ? number : null;
export function safeTokenUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const breakdown = raw => {
    const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'];
    if (!raw || keys.some(key => counter(raw[key]) === null)) return null;
    return Object.fromEntries([...keys, ...(counter(raw.cacheWriteInputTokens) !== null ? ['cacheWriteInputTokens'] : [])].map(key => [key, raw[key]]));
  };
  const last = breakdown(usage.last), total = breakdown(usage.total);
  if (!last || !total || (usage.modelContextWindow != null && (counter(usage.modelContextWindow) === null || usage.modelContextWindow === 0))) return null;
  return { last, total, modelContextWindow: usage.modelContextWindow ?? null };
}
export async function readRolloutTokenUsage({ path, codexHome, filesystem = fs, uid = () => process.getuid(), maxBytes = 1024 * 1024 }) {
  let handle;
  try {
    if (!value(path, 4096) || !isAbsolute(path) || resolve(path) !== path || !codexHome || maxBytes < 1 || maxBytes > 1024 * 1024) return null;
    const root = resolve(codexHome), parts = relative(root, path).split(sep);
    if (!['sessions', 'archived_sessions'].includes(parts[0]) || parts.some(part => !part || part === '..') || !path.endsWith('.jsonl')) return null;
    let current = root;
    for (const part of ['', ...parts]) {
      if (part) current = resolve(current, part);
      const info = await filesystem.lstat(current);
      if (info.isSymbolicLink() || info.uid !== uid() || (current === path ? !info.isFile() : !info.isDirectory())) return null;
    }
    if (await filesystem.realpath(path) !== path) return null;
    const before = await filesystem.lstat(path);
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > 4 * 1024 ** 3) return null;
    handle = await filesystem.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > 4 * 1024 ** 3 || before.ino !== info.ino || before.dev !== info.dev || await filesystem.realpath(path) !== path) return null;
    const size = Math.min(info.size, maxBytes), start = info.size - size, buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n'); if (start) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let event; try { event = JSON.parse(lines[i]); } catch { continue; }
      const raw = event.type === 'event_msg' && event.payload?.type === 'token_count' ? event.payload.info : null;
      if (!raw) continue;
      const convert = usage => usage && Object.fromEntries(['total_tokens', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'].map(key => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), usage[key]]));
      const usage = safeTokenUsage({ last: convert(raw.last_token_usage), total: convert(raw.total_token_usage), modelContextWindow: raw.model_context_window });
      if (usage) return usage;
    }
  } catch { return null; } finally { if (handle) await handle.close().catch(() => {}); }
  return null;
}
export function createComposer({ rpc, codexHome, filesystem = fs, uid, clock = Date.now }) {
  const threads = new Map(), usages = new Map(), liveUsage = new Set();
  const fallbackAt = new Map();
  let generation = 0;
  const observe = (threadId, data) => {
    const previous = threads.get(threadId) || {};
    const source = data?.threadSettings || data?.thread || data || {};
    const next = { ...previous };
    for (const key of ['model', 'reasoningEffort']) { const chosen = Object.hasOwn(data || {}, key) ? data : source; if (Object.hasOwn(chosen, key)) next[key] = chosen[key] === null ? null : value(chosen[key]); }
    if (data?.activePermissionProfile) next.permissionProfile = value(data.activePermissionProfile.id);
    threads.set(threadId, next);
  };
  const tokenUsage = (threadId, raw) => { const safe = safeTokenUsage(raw); if (safe) { usages.set(threadId, safe); liveUsage.add(threadId); } return safe; };
  const context = thread => {
    if (thread) observe(thread.id, thread);
    const threadId = thread?.id, settings = threads.get(threadId) || {}, usage = usages.get(threadId) || null;
    return { threadId, model: settings.model ?? null, reasoningEffort: settings.reasoningEffort ?? null, tokenUsage: usage, context: usage && usage.modelContextWindow ? { used: usage.last.totalTokens, max: usage.modelContextWindow } : null, permissions: { mode: 'inherit', currentProfileId: settings.permissionProfile || null }, source: 'native' };
  };
  const readContext = async thread => {
    const observedGeneration = generation;
    const path = value(thread.path, 4096), parts = path && codexHome ? relative(resolve(codexHome), path).split(sep) : [];
    const hasRolloutPath = path && isAbsolute(path) && resolve(path) === path && path.endsWith('.jsonl') && ['sessions', 'archived_sessions'].includes(parts[0]) && parts.every(part => part && part !== '..');
    if (hasRolloutPath && !liveUsage.has(thread.id) && codexHome && (!fallbackAt.has(thread.id) || clock() - fallbackAt.get(thread.id) > 5000)) {
      fallbackAt.set(thread.id, clock());
      const usage = await readRolloutTokenUsage({ path: thread.path, codexHome, filesystem, ...(uid ? { uid } : {}) });
      if (usage && observedGeneration === generation && !liveUsage.has(thread.id)) usages.set(thread.id, usage);
    }
    return context(thread);
  };
  const pageAll = async (method, params) => {
    const data = [], seen = new Set(); let cursor = null;
    for (let page = 0; page < 20; page++) {
      const response = await rpc.call(method, { ...params, cursor, limit: 100 });
      if (!Array.isArray(response?.data) || response.data.length > 100 || (response.nextCursor != null && !value(response.nextCursor, 4096))) fail(502, 'composer_protocol', '原生选项列表格式无效。');
      data.push(...response.data); if (data.length > 1000) fail(502, 'composer_limit', '原生选项列表超出读取上限。');
      cursor = response.nextCursor;
      if (!cursor) return data;
      if (seen.has(cursor)) fail(502, 'composer_protocol', '原生选项列表分页循环。'); seen.add(cursor);
    }
    fail(502, 'composer_limit', '原生选项列表未完整读取。');
  };
  const models = async cwd => {
    const raw = await pageAll('model/list', { includeHidden: false }), ids = new Set();
    const models = raw.filter(model => model?.hidden !== true).map(model => {
      if (!value(model?.id) || !value(model.model) || !value(model.displayName) || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 30 || ids.has(model.id)) fail(502, 'composer_protocol', '原生模型元数据无效。');
      ids.add(model.id);
      const efforts = model.supportedReasoningEfforts.map(option => { if (!value(option?.reasoningEffort, 80)) fail(502, 'composer_protocol', '原生推理等级无效。'); return { reasoningEffort: option.reasoningEffort, description: typeof option.description === 'string' ? option.description.slice(0, 2000) : '' }; });
      return { id: model.id, model: model.model, displayName: model.displayName, description: typeof model.description === 'string' ? model.description.slice(0, 2000) : '', supportedReasoningEfforts: efforts, defaultReasoningEffort: value(model.defaultReasoningEffort, 80), isDefault: model.isDefault === true, inputModalities: (Array.isArray(model.inputModalities) ? model.inputModalities : []).filter(item => ['text', 'image'].includes(item)) };
    });
    let defaults = { model: null, reasoningEffort: null };
    try { const response = await rpc.call('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) }); defaults = { model: value(response?.config?.model), reasoningEffort: value(response?.config?.model_reasoning_effort, 80) }; } catch { /* Unknown stays unknown; catalog defaults are a separate suggestion. */ }
    const suggested = models.find(model => model.isDefault);
    return { models, defaults, catalogDefault: suggested ? { model: suggested.model, reasoningEffort: suggested.defaultReasoningEffort } : null };
  };
  const profiles = async cwd => {
    const raw = await pageAll('permissionProfile/list', { ...(cwd ? { cwd } : {}) }), seen = new Set();
    const profiles = raw.map(profile => { if (!value(profile?.id) || typeof profile.allowed !== 'boolean' || seen.has(profile.id)) fail(502, 'composer_protocol', '原生权限配置格式无效。'); seen.add(profile.id); return { id: profile.id, allowed: profile.allowed, description: typeof profile.description === 'string' ? profile.description.slice(0, 2000) : null }; });
    return { profiles, selection: 'inherit' };
  };
  const normalize = body => {
    const patch = {};
    for (const key of ['model', 'reasoningEffort', 'permissions']) if (Object.hasOwn(body, key)) { if (!value(body[key], key === 'reasoningEffort' ? 80 : 200)) fail(400, 'invalid_composer_options', '模型、推理等级或权限选择无效。'); patch[key] = body[key]; }
    const attachmentIds = body.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => !value(id, 160) || !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) fail(400, 'invalid_attachments', '附件标识或数量无效。');
    return { ...patch, attachmentIds };
  };
  const validate = async (selection, thread, input = []) => {
    const patch = {};
    const image = input.some(item => ['localImage', 'image'].includes(item?.type));
    if (selection.model || selection.reasoningEffort || image) {
      const listed = await models(thread.cwd), selected = listed.models.find(model => model.model === (selection.model || thread.model));
      if (!selected || (selection.reasoningEffort && !selected.supportedReasoningEfforts.some(option => option.reasoningEffort === selection.reasoningEffort))) fail(400, 'unsupported_model_options', '当前账户不支持所选模型或推理等级。');
      if (image && !selected.inputModalities.includes('image')) fail(400, 'model_image_unsupported', '当前模型不支持图片，请选择支持图片的模型。');
      if (selection.model) patch.model = selected.model;
      if (selection.reasoningEffort) patch.effort = selection.reasoningEffort;
    }
    if (selection.permissions) { const listed = await profiles(thread.cwd); if (!listed.profiles.some(profile => profile.id === selection.permissions && profile.allowed)) fail(403, 'permission_profile_unavailable', '当前对话不允许所选权限配置。'); patch.permissions = selection.permissions; }
    return patch;
  };
  const invalidate = () => { generation++; usages.clear(); liveUsage.clear(); fallbackAt.clear(); };
  return { models, profiles, normalize, validate, observe, tokenUsage, context, readContext, invalidate };
}
