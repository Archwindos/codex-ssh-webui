const $ = (id) => document.getElementById(id);
let terminalController, terminalLoading, terminalAuthEpoch = 0;
function updateTerminalAccess() {
  const epoch = ++terminalAuthEpoch;
  const allowed = Boolean(state.session?.authenticated && state.session?.capabilities?.terminal);
  const button = $('open-terminal');
  if (!button) return;
  button.hidden = !allowed;
  terminalController?.setAuthenticated(allowed, { available: allowed });
  if (!allowed || terminalController) return;
  button.disabled = true;
  terminalLoading ??= import('/terminal.js').then(module => {
    terminalController = module.installTerminal({ api, button });
    return terminalController;
  }).catch(failure => { terminalLoading = null; throw failure; });
  terminalLoading.then(controller => {
    if (epoch !== terminalAuthEpoch) return;
    controller.setAuthenticated(allowed, { available: allowed });
    button.disabled = false;
  }).catch(() => { if (epoch === terminalAuthEpoch) { button.hidden = true; error('临时终端界面未加载，请刷新页面重试。'); } });
}
const state = { session: null, projectId: null, threadProjectId: null, thread: null, turnId: null, terminalTurns: new Set(), events: null, eventCursor: null, upstreamStatus: 'idle', transportMode: 'sse', transportEpoch: 0, transportTimer: null, pollAbort: null, eventFailures: 0, hydrating: null, approvals: new Map(), items: new Map(), cursor: null, historyScope: 'all', historyEpoch: 0, historyCursor: null, busy: false, posting: false, connected: false, pending: null, view: 'home', priorView: 'home', directory: null, directoryEpoch: 0, directoryLoading: false, projectEdit: null, projectSaving: false, projectConflict: false, overviewTimer: null, overviewRequest: null, overviewEpoch: 0, overview: null, activityPhase: 'idle', activitySince: null, activityTimer: null, activityMessage: '准备好后，发送你的任务。' };
Object.assign(state, { libraryThreads: [], recentThreads: [], pinnedThreads: [], archived: false, joining: false, operation: null, archiveFreezes: new Map(), draftCwd: '', libraryProjectId: null, searchTerm: '', threadEdit: null, metadataSaving: false, keepRunningSaving: false, chatActionsOpen: false });
Object.assign(state, { userInputs: new Map(), userInputForms: new Map() });
Object.assign(state, { messageEpoch: 0, threadLoadEpoch: 0, loadingOlder: null, historyPagingMode: 'turns', suppressScroll: false, userScrollArmed: false, lastScrollTop: 0 });
state.includeInternal = false;
Object.assign(state, { attachments: [], attachmentNotice: '', models: [], modelDefaults: null, modelSelection: null, effortSelection: null, modelChoiceRequired: false, modelsLoading: null, modelsError: '', permissionProfiles: [], permissionSelection: 'inherit', permissionError: '', permissionEpoch: 0, composerAuthority: null, composerTarget: null, composerContextEpoch: 0 });
state.attachmentEpoch = 0;
Object.assign(state, { projectsCollapsed: false, activeProjectRow: null, projectMenu: null, directoryMode: 'edit' });
Object.assign(state, { projectView: null, projectRefreshEpoch: 0, projectRefreshRequest: null, projectRefreshTimer: null });
state.projectOperations = new Map();
Object.assign(state, { deviceBusy: false, deviceStatus: '', deviceError: false, deviceRecord: null, deviceAutoAttempted: false, deviceSuppressed: false, deviceRecovery: false, deviceRecoveryTimer: null, pairing: null });
const loopbackHttpOrigin = typeof location !== 'undefined' && /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})$/.test(location.origin) && Number(location.port) >= 1024 && Number(location.port) <= 65535 ? location.origin : null;
let sessionToken = '';
try { if (loopbackHttpOrigin) sessionToken = sessionStorage.getItem('relay-session-token') || ''; } catch { /* Keep the session in memory if browser storage is unavailable. */ }
function rememberToken(value) { sessionToken = value; try { if (value) sessionStorage.setItem('relay-session-token', value); else sessionStorage.removeItem('relay-session-token'); } catch { /* The current page remains usable without storage. */ } }
const authHeaders = () => loopbackHttpOrigin ? { 'X-Relay-Origin': loopbackHttpOrigin, ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) } : {};
const requestCredentials = () => state.session?.authTransport === 'bearer' ? 'omit' : 'same-origin';
function clearPairingToken() { state.pairing = null; try { sessionStorage.removeItem('relay-device-pairing'); } catch { /* The token is also cleared from memory. */ } }
function pairingToken() { if (!state.pairing || state.pairing.expiresAt <= Date.now()) { clearPairingToken(); return null; } return state.pairing.token; }
function capturePairingToken() {
  try {
    const fragment = typeof location !== 'undefined' ? location.hash || '' : '';
    if (fragment.startsWith('#pair=')) {
      if (typeof window !== 'undefined' && window.history) window.history.replaceState(null, '', `${location.pathname || '/'}${location.search || ''}`);
      const token = /^#pair=([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1];
      clearPairingToken(); if (token) { state.pairing = { token, expiresAt: Date.now() + 600000 }; sessionStorage.setItem('relay-device-pairing', JSON.stringify(state.pairing)); }
    } else {
      const saved = JSON.parse(sessionStorage.getItem('relay-device-pairing') || 'null');
      if (/^[A-Za-z0-9_-]{43}$/.test(saved?.token || '') && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now() && saved.expiresAt <= Date.now() + 600000) state.pairing = saved;
    }
  } catch { /* Pairing may remain in memory when session storage is unavailable. */ }
  pairingToken();
}
capturePairingToken();
function deviceSupport() { return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle && typeof TextEncoder !== 'undefined'; }
function openDeviceStore() {
  if (!deviceSupport()) return Promise.reject(new Error('此浏览器无法使用密钥认证。请使用支持 WebCrypto 和本地存储的浏览器，或使用恢复入口。'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('codex-relay-trusted-browser', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('devices')) request.result.createObjectStore('devices'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error('无法打开浏览器密钥存储。请允许此站点使用本地存储，或使用恢复入口。'));
  });
}
async function deviceStore(mode, operation) {
  const database = await openDeviceStore();
  return new Promise((resolve, reject) => {
    let transaction, result;
    const failed = () => { database.close(); reject(new Error('浏览器密钥未能保存或读取。请检查本地存储权限后重试。')); };
    try { transaction = database.transaction('devices', mode); const request = operation(transaction.objectStore('devices')); request.onsuccess = () => { result = request.result; }; transaction.oncomplete = () => { database.close(); resolve(result); }; transaction.onerror = transaction.onabort = failed; }
    catch { failed(); }
  });
}
async function loadTrustedDevice() { return (await deviceStore('readonly', store => store.get('current'))) || null; }
async function saveTrustedDevice(record) { await deviceStore('readwrite', store => store.put(record, 'current')); }
async function clearTrustedDevice() { await deviceStore('readwrite', store => store.delete('current')); }
function base64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decodeBase64url(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('浏览器公钥格式无效。'); return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0)); }
async function generateDeviceKey() {
  if (!deviceSupport()) throw new Error('此浏览器不支持密钥认证，请使用恢复入口。');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  if (keys.privateKey.extractable) throw new Error('浏览器未生成不可导出的私钥，未登记设备。');
  return { deviceId: null, privateKey: keys.privateKey, publicKey: base64url(await crypto.subtle.exportKey('spki', keys.publicKey)), origin: location.origin };
}
async function signDeviceChallenge(record, challenge, purpose) {
  const message = typeof challenge.message === 'string' && challenge.message.length <= 8192 ? JSON.parse(challenge.message) : null;
  if (!message || message.version !== 1 || message.origin !== location.origin || message.challengeId !== challenge.challengeId || message.purpose !== purpose || !/^[A-Za-z0-9_-]{1,160}$/.test(message.deviceId || '') || (purpose === 'device-login' && message.deviceId !== record.deviceId) || !Number.isFinite(message.expiresAt) || message.expiresAt <= Date.now()) throw new Error('认证挑战与此浏览器或当前页面不匹配，未签名。');
  const keyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', decodeBase64url(record.publicKey)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (message.keyHash !== keyHash || record.privateKey?.extractable !== false || record.privateKey?.algorithm?.name !== 'ECDSA' || record.privateKey.algorithm.namedCurve !== 'P-256') throw new Error('认证挑战与本地密钥不匹配，未签名。');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, new TextEncoder().encode(challenge.message));
  if (signature.byteLength !== 64) throw new Error('浏览器签名格式无效，未提交认证。');
  return base64url(signature);
}
function renderDeviceAuth() {
  const enabled = !!state.session?.capabilities?.deviceAuthentication, authenticated = !!state.session?.authenticated, trusted = state.session?.trustedDevice;
  $('device-login').hidden = !enabled; $('recovery-login').hidden = enabled && !state.deviceRecovery;
  $('device-settings').hidden = !enabled || !authenticated;
  $('trust-browser').hidden = !enabled || authenticated || !pairingToken(); $('trust-browser').disabled = state.deviceBusy || !deviceSupport();
  $('trust-browser-sidebar').hidden = !enabled || !authenticated || !!trusted; $('trust-browser-sidebar').disabled = state.deviceBusy || !deviceSupport();
  $('revoke-device').hidden = !enabled || !authenticated || !trusted; $('revoke-device').disabled = state.deviceBusy;
  $('device-retry').hidden = !enabled || authenticated || !state.deviceRecord?.deviceId; $('device-retry').disabled = state.deviceBusy || !deviceSupport();
  $('show-recovery').hidden = !enabled || state.deviceRecovery;
  $('device-login-status').textContent = state.deviceStatus || (!deviceSupport() ? '此浏览器不支持 WebCrypto 或密钥存储，无法启用自动认证。可使用下方恢复入口。' : pairingToken() ? '点击「信任此浏览器」完成一次性配对。' : '请用管理员提供的一次性配对链接打开本页，首次连接后即可信任此浏览器。');
  const expires = trusted?.expiresAt ? new Date(trusted.expiresAt) : null;
  $('trusted-device-info').textContent = state.deviceError ? state.deviceStatus : trusted ? `已信任此浏览器${expires && !Number.isNaN(expires.getTime()) ? ` · 有效至 ${expires.toLocaleDateString('zh-CN')}` : ''}` : state.deviceStatus || '信任后，可在此浏览器自动连接。';
}
async function authenticateTrustedDevice() {
  if (state.deviceBusy || state.deviceSuppressed || state.deviceAutoAttempted) return false;
  state.deviceAutoAttempted = true; state.deviceBusy = true; state.deviceError = false; state.deviceStatus = '正在验证此浏览器…'; renderDeviceAuth();
  try {
    state.deviceRecord = await loadTrustedDevice();
    if (!state.deviceRecord?.deviceId) { state.deviceStatus = ''; return false; }
    const challenge = await api('/api/device/challenge', { deviceId: state.deviceRecord.deviceId });
    const signature = await signDeviceChallenge(state.deviceRecord, challenge, 'device-login');
    const session = await api('/api/device/verify', { challengeId: challenge.challengeId, signature });
    if (!session.authenticated || session.trustedDevice?.id !== state.deviceRecord.deviceId) throw new Error('浏览器认证响应无效。');
    state.session = session; state.deviceStatus = '已自动验证此浏览器。'; return true;
  } catch (failure) { state.deviceError = true; state.deviceStatus = `${failure.message} 请重试，或使用新的配对链接。`; return false; }
  finally { state.deviceBusy = false; renderDeviceAuth(); }
}
async function establishAuthSession() {
  state.session = await api('/api/session');
  setAuthenticated(state.session.authenticated);
  return state.session;
}
async function enrollTrustedDevice() {
  if (state.deviceBusy || (!state.session?.authenticated && !pairingToken())) return;
  state.deviceBusy = true; state.deviceError = false; state.deviceStatus = '正在保存浏览器认证密钥…'; renderDeviceAuth(); let enrolled = false;
  try {
    const current = await establishAuthSession();
    if (!current.authenticated && !pairingToken()) throw new Error('工作台登录已过期，请使用恢复口令或新的配对链接。');
    const record = await generateDeviceKey(); await saveTrustedDevice(record);
    const persisted = await loadTrustedDevice();
    if (!persisted?.privateKey || persisted.publicKey !== record.publicKey || persisted.privateKey.extractable !== false) throw new Error('未能核验已保存的浏览器密钥，未登记设备。');
    state.deviceRecord = persisted;
    const challenge = await api('/api/device/challenge', { publicKey: persisted.publicKey, label: '我的手机浏览器', ...(!state.session?.authenticated ? { pairingToken: pairingToken() } : {}) });
    const signature = await signDeviceChallenge(persisted, challenge, 'device-enroll');
    persisted.deviceId = JSON.parse(challenge.message).deviceId; persisted.pending = true; await saveTrustedDevice(persisted);
    clearPairingToken();
    const session = await api('/api/device/verify', { challengeId: challenge.challengeId, signature });
    if (!session.authenticated || session.trustedDevice?.id !== persisted.deviceId) throw new Error('浏览器登记响应无效。');
    state.session = session; enrolled = true; persisted.pending = false; await saveTrustedDevice(persisted);
    state.deviceRecord = persisted; state.deviceSuppressed = false; state.deviceAutoAttempted = false; state.deviceStatus = '已信任此浏览器。';
  } catch (failure) {
    if (failure.code === 'device_pairing_invalid') clearPairingToken();
    state.deviceError = true; state.deviceStatus = failure.code === 'device_pairing_invalid' ? '配对链接已过期或已使用。请在电脑重新生成，或使用恢复口令登录。' : `${failure.message} 浏览器配对未完成。`;
  }
  finally { state.deviceBusy = false; renderDeviceAuth(); }
  if (enrolled) await hydrate(true);
}
function scheduleDeviceRecovery() {
  if (!state.session?.capabilities?.deviceAuthentication || state.deviceBusy || state.deviceSuppressed || state.deviceAutoAttempted || state.deviceRecoveryTimer !== null) return;
  state.deviceRecoveryTimer = setTimeout(() => { state.deviceRecoveryTimer = null; run(() => hydrate(true)); }, 0);
}
async function revokeTrustedDevice() {
  if (state.deviceBusy || !state.session?.trustedDevice?.id) return;
  state.deviceBusy = true; state.deviceSuppressed = true; state.deviceError = false; renderDeviceAuth(); let revoked = false;
  try {
    await api('/api/devices/revoke', { deviceId: state.session.trustedDevice.id });
    revoked = true; rememberToken(''); clearPairingToken(); state.deviceRecord = null; setAuthenticated(false); await clearTrustedDevice();
    state.deviceStatus = '已取消信任并退出。再次连接需要新的配对链接。'; setAuthenticated(false);
  } catch (failure) { state.deviceError = true; state.deviceStatus = revoked ? '设备已撤销并退出，但本地密钥尚未删除。请清除此站点的浏览器存储。' : failure.message; if (!revoked && state.session?.authenticated) state.deviceSuppressed = false; }
  finally { state.deviceBusy = false; renderDeviceAuth(); }
  if (state.deviceSuppressed) await hydrate(true);
}
function submissionId() { if (typeof crypto.randomUUID === 'function') return crypto.randomUUID(); return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
const runtimePresence = { clientId: submissionId(), desired: undefined, attempted: false, sequence: 0, queue: Promise.resolve(), timer: null, auth: null, pageLeaving: false, suspended: false, failed: false };
function runtimePresenceTarget() {
  return state.session?.authenticated && state.session?.capabilities?.runtimePresence && state.connected && state.upstreamStatus !== 'closed' && document.visibilityState === 'visible' && !runtimePresence.pageLeaving && !runtimePresence.suspended && state.view === 'chat' && state.thread?.id ? state.thread.id : null;
}
function syncRuntimePresence({ force = false } = {}) {
  const target = runtimePresenceTarget();
  if (state.session?.authenticated && state.session?.capabilities?.runtimePresence) runtimePresence.auth = { credentials: requestCredentials(), headers: { ...authHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': state.session.csrf || '' } };
  if (target === runtimePresence.desired && !force) return runtimePresence.queue;
  if (runtimePresence.timer !== null) { clearTimeout(runtimePresence.timer); runtimePresence.timer = null; }
  runtimePresence.desired = target;
  const sequence = ++runtimePresence.sequence, auth = runtimePresence.auth;
  if (!auth || (!target && !runtimePresence.attempted)) return runtimePresence.queue;
  runtimePresence.queue = runtimePresence.queue.catch(() => {}).then(async () => {
    if (sequence !== runtimePresence.sequence) return;
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
    runtimePresence.attempted = true; let retry = true;
    try {
      const response = await fetch('/api/runtime-presence', { method: 'POST', credentials: auth.credentials, headers: auth.headers, body: JSON.stringify({ clientId: runtimePresence.clientId, threadId: target }), keepalive: true, signal: abort.signal });
      if (!response.ok) { const failure = new Error('presence unavailable'); failure.status = response.status; throw failure; }
      runtimePresence.failed = false;
      if (!target) runtimePresence.attempted = false;
    } catch (failure) { runtimePresence.failed = true; retry = ![401, 403].includes(failure.status); }
    finally {
      clearTimeout(timeout);
      if (retry && sequence === runtimePresence.sequence && target && runtimePresenceTarget() === target) runtimePresence.timer = setTimeout(() => { runtimePresence.timer = null; void syncRuntimePresence({ force: true }); }, 20000);
    }
  });
  return runtimePresence.queue;
}
function releaseRuntimePresence() { runtimePresence.suspended = true; return syncRuntimePresence(); }
let savedSelection;
try { savedSelection = JSON.parse(sessionStorage.getItem('relay-selection') || 'null'); } catch { /* Unavailable storage does not block the workspace. */ }
if (['chat', 'library'].includes(savedSelection?.view)) state.view = savedSelection.view;
if (savedSelection?.historyScope === 'project') state.historyScope = 'project';
function rememberSelection() { try { sessionStorage.setItem('relay-selection', JSON.stringify({ projectId: state.projectId, threadId: state.thread?.id, threadProjectId: state.threadProjectId, threadCwd: state.thread?.cwd, historyScope: state.historyScope, view: state.view === 'directory' ? state.priorView : state.view === 'operation' ? state.operation?.priorView : state.view })); } catch { /* No secrets or message content are stored. */ } }
const labels = { completed: '已完成', interrupted: '已中断', failed: '执行失败', inProgress: '正在执行' };

function error(message) { $('error-text').textContent = message; $('error').hidden = false; }
async function api(path, data, signal, { raw = false, headers = {} } = {}) {
  const requestToken = sessionToken;
  const authenticationAttempt = ['/api/login', '/api/device/challenge', '/api/device/verify'].includes(path);
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: requestCredentials(), headers: { ...authHeaders(), ...(data === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-CSRF-Token': state.session?.csrf || '' }), ...headers }, ...(data === undefined ? {} : { body: raw ? data : JSON.stringify(data) }), ...(signal ? { signal } : {}) });
  const body = await response.json();
  if (!response.ok) {
    // Invalid credentials do not invalidate the anonymous session that carries CSRF.
    // A late response from a replaced bearer must not clear the newer login.
    const rejectedCredentials = authenticationAttempt && !['session_required', 'authentication_required'].includes(body.error?.code);
    if (response.status === 401 && !rejectedCredentials && (!loopbackHttpOrigin || requestToken === sessionToken)) { rememberToken(''); state.connected = false; setAuthenticated(false); if (!authenticationAttempt) scheduleDeviceRecovery(); }
    if (body.error?.code === 'external_thread_open' && path === '/api/turns' && data?.threadId === state.thread?.id) { state.thread.readOnly = true; state.thread.readOnlyReason = 'external_thread_open'; controls(); }
    const failure = new Error(body.error?.message || '连接未完成，请稍后重试。'); failure.status = response.status; failure.code = body.error?.code; throw failure;
  }
  if (body.authTransport === 'bearer') {
    if (!loopbackHttpOrigin || !/^[A-Za-z0-9_-]{43}$/.test(body.sessionToken || '')) throw new Error('回环会话响应无效。');
    rememberToken(body.sessionToken);
  } else if (loopbackHttpOrigin && path === '/api/session') rememberToken('');
  if (path === '/api/logout') rememberToken('');
  return body;
}
function connection(online, text) { state.connected = online; $('connection').className = `connection ${online ? 'online' : 'offline'}`; $('connection-text').textContent = text; controls(); }
function stopActivityClock() { clearTimeout(state.activityTimer); state.activityTimer = null; }
const effortNames = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
const permissionNames = { inherit: '服务器默认', ':read-only': '只读', ':workspace': '工作区', ':danger-full-access': '完全访问' };
function currentComposerModel() { return state.modelSelection || state.thread?.model || state.modelDefaults?.model || null; }
function currentComposerEffort() { return state.effortSelection || state.thread?.reasoningEffort || state.modelDefaults?.reasoningEffort || null; }
function selectedModelInfo() { return state.models.find(model => model.model === currentComposerModel()); }
function supportedEfforts() { return (selectedModelInfo()?.supportedReasoningEfforts || []).filter(option => typeof option.reasoningEffort === 'string'); }
function composerOverrides() { return { ...(state.modelSelection ? { model: state.modelSelection } : {}), ...(state.effortSelection ? { reasoningEffort: state.effortSelection } : {}), ...(state.permissionSelection !== 'inherit' ? { permissions: state.permissionSelection } : {}) }; }
function resetComposerChoices() { state.modelSelection = null; state.effortSelection = null; state.modelChoiceRequired = false; state.permissionSelection = 'inherit'; }
function syncComposerAuthority(value, threadId = state.thread?.id || null) {
  if (threadId !== (state.thread?.id || null)) return;
  const target = threadId || 'draft', authority = { target, model: value?.model ?? null, effort: value?.reasoningEffort ?? null };
  const prior = state.composerAuthority;
  if (state.composerTarget !== target || prior?.target === target && ((authority.model && prior.model && authority.model !== prior.model) || (authority.effort && prior.effort && authority.effort !== prior.effort))) resetComposerChoices();
  state.composerTarget = target; state.composerAuthority = authority;
}
async function loadComposerCatalog() {
  if (!state.session?.authenticated || !state.session?.capabilities?.composerModels || state.modelsLoading) return state.modelsLoading;
  const authenticatedSession = state.session, targetThread = state.thread?.id || null;
  const request = (async () => {
    try { const result = await api(`/api/models${targetThread ? `?thread=${encodeURIComponent(targetThread)}` : ''}`); if (!state.session?.authenticated || state.session.csrf !== authenticatedSession.csrf) return; state.models = (result.models || []).filter(model => typeof model.model === 'string' && Array.isArray(model.supportedReasoningEfforts)); if (targetThread === (state.thread?.id || null)) state.modelDefaults = result.defaults || null; state.modelsError = ''; }
    catch (failure) { state.modelsError = failure.message; }
    finally { if (state.modelsLoading === request) state.modelsLoading = null; renderComposer(); controls(); }
  })(); state.modelsLoading = request; return request;
}
async function loadPermissionProfiles(threadId = state.thread?.id || null) {
  if (!state.session?.authenticated || !state.session?.capabilities?.permissionProfiles) return;
  const epoch = ++state.permissionEpoch;
  try { const result = await api(`/api/permission-profiles${threadId ? `?thread=${encodeURIComponent(threadId)}` : ''}`); if (epoch !== state.permissionEpoch || threadId !== (state.thread?.id || null)) return; state.permissionProfiles = (result.profiles || []).filter(profile => profile.allowed === true && typeof profile.id === 'string'); state.permissionError = ''; if (state.permissionSelection !== 'inherit' && !state.permissionProfiles.some(profile => profile.id === state.permissionSelection)) state.permissionSelection = 'inherit'; }
  catch (failure) { if (epoch === state.permissionEpoch) state.permissionError = failure.message; }
  renderComposer();
}
async function refreshComposerContext(threadId = state.thread?.id, { force = false } = {}) {
  if (!threadId || !state.session?.authenticated || !state.session?.capabilities?.threadContext || !force && state.composerContextThread === threadId) return;
  const epoch = ++state.composerContextEpoch; state.composerContextThread = threadId;
  try { const result = await api(`/api/thread-context?thread=${encodeURIComponent(threadId)}`); if (epoch !== state.composerContextEpoch || state.thread?.id !== threadId) return; syncComposerAuthority(result, threadId); state.thread = { ...state.thread, ...result, id: threadId }; state.composerContextError = ''; renderComposer(); }
  catch (failure) { if (epoch === state.composerContextEpoch && state.thread?.id === threadId) { state.thread = { ...state.thread, context: null, tokenUsage: null }; state.composerContextError = `读取失败：${failure.message}`; renderComposer(); } }
}
function contextReading() {
  const direct = state.thread?.context, usage = state.thread?.tokenUsage;
  const used = direct?.used ?? usage?.last?.totalTokens ?? usage?.last?.total_tokens;
  const max = direct?.max ?? usage?.modelContextWindow ?? usage?.model_context_window;
  return Number.isFinite(used) && used >= 0 && Number.isFinite(max) && max > 0 ? { used, max, percent: Math.round(used / max * 100) } : null;
}
function renderComposer() {
  const model = currentComposerModel(), effort = currentComposerEffort(), info = selectedModelInfo(), options = supportedEfforts();
  $('composer-model').textContent = [info?.displayName || model || '服务器设置', state.modelChoiceRequired ? '选择推理等级' : effortNames[effort] || effort || ''].filter(Boolean).join(' ');
  $('model-summary').textContent = [model, effort].filter(Boolean).join(' · ') || '使用服务器模型设置';
  $('model-trigger').setAttribute('aria-label', `模型与推理等级：${$('composer-model').textContent}`);
  const inheritedModel = state.thread?.model || state.modelDefaults?.model, inheritedName = state.models.find(option => option.model === inheritedModel)?.displayName || inheritedModel;
  const modelKey = JSON.stringify([state.models.map(item => [item.model, item.displayName]), state.modelSelection, inheritedName]);
  if (modelKey !== state.composerModelKey) { state.composerModelKey = modelKey; $('composer-model-select').replaceChildren(); for (const value of [{ model: '', displayName: inheritedName ? `${inheritedName}（当前设置）` : '继承服务器设置' }, ...state.models]) { const option = document.createElement('option'); option.value = value.model; option.textContent = value.displayName || value.model; $('composer-model-select').append(option); } }
  $('composer-model-select').value = state.modelSelection || ''; $('composer-model-select').disabled = !state.session?.authenticated || state.posting || !!state.modelsError || !!state.modelsLoading || !state.models.length;
  const index = options.findIndex(option => option.reasoningEffort === effort);
  $('composer-effort').max = String(Math.max(0, options.length - 1)); $('composer-effort').value = String(Math.max(0, index)); $('composer-effort').disabled = !state.session?.authenticated || state.posting || !!state.modelsError || !options.length; $('reset-composer-model').disabled = state.posting;
  $('composer-effort').style?.setProperty('--effort-progress', String(options.length > 1 ? Math.max(0, index) / (options.length - 1) * 100 : 0));
  $('composer-effort').setAttribute('aria-valuetext', state.modelChoiceRequired ? '请选择推理等级' : effortNames[effort] || effort || '服务器默认');
  $('effort-label').textContent = state.modelChoiceRequired ? '请选择' : effortNames[effort] || effort || '服务器默认';
  const ticksKey = options.map(option => option.reasoningEffort).join('|');
  if (ticksKey !== state.composerTicksKey) { state.composerTicksKey = ticksKey; $('effort-ticks').replaceChildren(); for (const option of options) { const tick = document.createElement('span'); tick.textContent = effortNames[option.reasoningEffort] || option.reasoningEffort; $('effort-ticks').append(tick); } }
  $('composer-model-status').textContent = state.modelsError || (state.modelChoiceRequired ? '当前模型不支持原推理等级，请选择一个支持的等级。' : state.busy ? '模型与权限选择会用于下一轮任务；补充消息继续使用当前任务设置。' : state.modelsLoading ? '正在读取此账号支持的模型…' : !state.models.length ? '使用服务器当前设置。可用模型尚未提供。' : '未主动更改时，继续使用服务器当前设置。');
  $('permission-label').textContent = permissionNames[state.permissionSelection] || state.permissionSelection;
  const profiles = [{ id: 'inherit', description: '继承服务器当前权限设置。' }, ...state.permissionProfiles.filter(profile => profile.id !== 'inherit')];
  const permissionKey = JSON.stringify([profiles, state.permissionSelection]);
  if (permissionKey !== state.composerPermissionKey) { state.composerPermissionKey = permissionKey; $('permission-options').replaceChildren(); for (const profile of profiles) { const button = document.createElement('button'); button.type = 'button'; button.className = 'permission-option'; button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(state.permissionSelection === profile.id)); const title = document.createElement('strong'), description = document.createElement('small'); title.textContent = permissionNames[profile.id] || profile.id; description.textContent = profile.description || ''; button.append(title, description); button.addEventListener('click', () => { state.permissionSelection = profile.id; $('permissions-picker').open = false; renderComposer(); }); $('permission-options').append(button); } }
  $('permission-note').textContent = state.permissionError || (state.busy ? '选择用于下一轮任务。' : '只显示服务器当前允许的权限配置。');
  const context = contextReading(); $('context-meter').dataset.known = String(!!context);
  $('context-progress').setAttribute('stroke-dasharray', `${context ? Math.min(100, context.percent) : 0} 100`);
  $('context-percent').textContent = context ? `${context.percent}% 已用` : '未提供';
  $('context-tokens').textContent = context ? `已用 ${context.used.toLocaleString('zh-CN')} 标记，共 ${context.max.toLocaleString('zh-CN')}` : state.composerContextError || '服务器未提供上下文用量。';
  $('context-toggle').setAttribute('aria-label', `上下文窗口：${context ? `${context.percent}% 已用，${context.used} / ${context.max} 标记` : '服务器未提供'}`);
  $('attach-files').hidden = !state.session?.capabilities?.attachments;
  $('attach-files').disabled = !state.session?.authenticated || state.posting;
  for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = state.posting;
  for (const button of $('permission-options').querySelectorAll('button')) button.disabled = state.posting;
  $('attachment-file').accept = state.session?.attachments?.accept || state.session?.attachmentAccept || state.session?.capabilities?.attachmentAccept || '';
}
function renderAttachments() {
  $('attachment-list').replaceChildren(); $('attachment-list').hidden = !state.attachments.length;
  for (const attachment of state.attachments) {
    const chip = document.createElement('div'); chip.className = 'attachment-chip'; chip.dataset.status = attachment.status;
    const icon = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : document.createElement('path'); path.setAttribute('d', 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6'); icon.append(path);
    const copy = document.createElement('div'), name = document.createElement('strong'), status = document.createElement('small'); name.textContent = attachment.name; name.setAttribute('title', attachment.name); status.textContent = attachment.status === 'uploading' ? '正在上传…' : attachment.status === 'failed' ? attachment.error || '上传失败，请移除后重新选择' : bytes(attachment.size); copy.append(name, status);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除附件 ${attachment.name}`); remove.disabled = state.posting; remove.addEventListener('click', () => run(() => removeAttachment(attachment.key)));
    chip.append(icon, copy, remove); $('attachment-list').append(chip);
  }
  $('attachment-status').textContent = state.attachmentNotice; $('attachment-status').hidden = !state.attachmentNotice;
  controls();
}
async function removeAttachment(key) {
  const attachment = state.attachments.find(item => item.key === key); if (!attachment || state.posting) return;
  attachment.abort?.abort(); state.attachments = state.attachments.filter(item => item.key !== key); state.attachmentNotice = ''; renderAttachments();
  if (attachment.id && state.session?.authenticated) try { await api('/api/attachments/cancel', { attachmentId: attachment.id }); } catch (failure) { state.attachmentNotice = `附件已移出草稿；服务器清理未确认：${failure.message}`; renderAttachments(); }
}
async function addAttachments(files) {
  if (!state.session?.authenticated || !state.session?.capabilities?.attachments || state.posting) return;
  const limits = state.session.attachments || state.session.attachmentLimits || state.session.capabilities?.attachmentLimits || {}, selected = Array.from(files || []);
  if (limits.maxFiles && selected.length + state.attachments.length > limits.maxFiles) { state.attachmentNotice = `每次最多附加 ${limits.maxFiles} 个文件，请减少文件数量。`; renderAttachments(); return; }
  state.attachmentNotice = '';
  const uploads = selected.map(file => ({ key: submissionId(), epoch: state.attachmentEpoch, file, name: file.name, size: file.size, mimeType: file.type, status: 'uploading', abort: new AbortController() })); state.attachments.push(...uploads); renderAttachments();
  for (const attachment of uploads) {
    if (!state.attachments.includes(attachment)) continue;
    try {
      if (limits.maxFileBytes && attachment.size > limits.maxFileBytes) throw new Error(`超过单个文件 ${bytes(limits.maxFileBytes)} 的限制`);
      const result = await api('/api/attachments', attachment.file, attachment.abort.signal, { raw: true, headers: { 'X-Attachment-Name': encodeURIComponent(attachment.name), 'X-Attachment-Type': attachment.mimeType || '' } });
      if (attachment.epoch !== state.attachmentEpoch || !state.attachments.includes(attachment)) { if (result.attachment?.id && state.session?.authenticated) await api('/api/attachments/cancel', { attachmentId: result.attachment.id }); continue; }
      if (!result.attachment?.id) throw new Error('上传响应未提供附件标识');
      Object.assign(attachment, result.attachment, { status: 'ready' }); attachment.file = null;
    } catch (failure) { if (state.attachments.includes(attachment)) { attachment.status = 'failed'; attachment.error = failure.message; } }
    renderAttachments();
  }
}
function clearComposerSession() {
  clearDraftAttachments(false); state.models = []; state.modelsLoading = null; state.modelDefaults = null; state.permissionProfiles = []; state.composerContextThread = null; state.composerContextEpoch++; state.permissionEpoch++; resetComposerChoices();
}
function clearDraftAttachments(cancel = true) {
  const attachments = state.attachments; state.attachmentEpoch++; state.attachments = []; state.attachmentNotice = '';
  for (const attachment of attachments) { attachment.abort?.abort(); if (cancel && attachment.id && state.session?.authenticated) void api('/api/attachments/cancel', { attachmentId: attachment.id }).catch(failure => { if (state.session?.authenticated) error(`草稿附件已移除，服务器清理未确认：${failure.message}`); }); }
  renderAttachments();
}
function sharedMode() { return !!state.session?.capabilities?.sharedDaemon; }
function catalogMode() { return sharedMode() || !!state.session?.capabilities?.chatCatalog; }
function defaultCwd() { return state.session?.workspace?.defaultCwd || '/workspace'; }
function projectCwd(project) { return catalogMode() ? project?.defaultCwd || defaultCwd() : project?.cwd || ''; }
function externalRuntime(thread = state.thread) { return thread?.runtimes?.find(runtime => !runtime.managed && runtime.status !== 'closed'); }
function externalThread(thread = state.thread) { return !!thread && (sharedMode() ? !!thread.readOnly : !!externalRuntime(thread) || !!thread.readOnly); }
function managedRuntime(thread = state.thread) { return thread?.runtimes?.find(runtime => runtime.managed && runtime.status !== 'closed'); }
function archiveFrozen(thread = state.thread) { return !!thread && (!!thread.archiveFrozen || !!thread.freezeRetained || [...state.archiveFreezes.values()].some(ids => ids.has(thread.id)) || (state.session?.pendingArchiveOperations || []).some(operation => operation.freezeRetained && operation.threadId === thread.id)); }
function admissionText(thread = state.thread) {
  if (sharedMode()) return thread?.archived ? '此对话已归档，可阅读历史。' : archiveFrozen(thread) ? '归档结果待核验，暂不能发送。请核验结果后继续。' : thread?.readOnly ? '此对话被另一独立 Codex 服务占用，当前只读。释放占用后重新打开。' : thread?.unavailable ? '执行目录暂不可用，历史仍可阅读。恢复目录后重试。' : '对话已就绪。';
  if (catalogMode()) return thread?.archived ? '此对话已归档，可阅读历史。' : archiveFrozen(thread) ? '归档结果待核验，暂不能发送。请在对话库核验结果。' : thread?.unavailable ? '原执行目录不可用，历史仍可阅读。请恢复目录后重试。' : externalThread(thread) ? '此对话正在外部 Codex 中运行，当前只读。先安全停止外部运行，再发送消息继续原对话。' : !managedRuntime(thread) ? '运行已停止，历史保留。发送消息会恢复原对话并创建独立运行环境。' : '对话已就绪。';
  return thread?.archived ? '此对话已归档，可阅读历史。' : archiveFrozen(thread) ? '上次归档结果待核验，此对话暂不能加入运行区或发送消息。请在对话库核验结果。' : thread?.unavailable ? '原文件夹不可用，可阅读历史；暂不能加入运行区。' : thread?.runtimes?.some(runtime => !runtime.managed) || thread?.readOnly ? '此对话正在原终端中运行，只读。关闭原 Codex 终端后，可加入运行区继续。' : '正在查看历史。加入运行区后，可在独立的运行环境中继续此对话。';
}
function renderActivity() {
  stopActivityClock();
  if (state.session?.capabilities?.runtimeManagement && state.thread && (state.thread.archived || archiveFrozen() || (!catalogMode() && !managedRuntime()) || (catalogMode() && (externalThread() || state.thread.unavailable || (!managedRuntime() && !state.posting))))) { $('run-state').dataset.active = 'false'; $('run-state').dataset.phase = 'readonly'; $('run-state-text').textContent = admissionText(); $('run-elapsed').textContent = ''; return; }
  if (state.thread?.readOnly && state.session?.authenticated && state.upstreamStatus !== 'closed') { $('run-state').dataset.phase = 'readonly'; $('run-state').dataset.active = 'false'; $('run-state-text').textContent = sharedMode() ? admissionText() : '此会话仍在原 Codex 客户端中打开。请先关闭原客户端，再重新打开会话。'; $('run-elapsed').textContent = ''; return; }
  const active = !!state.session?.authenticated && (state.busy || state.posting) && ['sending', 'thinking', 'tool', 'responding'].includes(state.activityPhase);
  $('run-state').dataset.phase = state.activityPhase; $('run-state').dataset.active = String(active);
  $('run-state-text').textContent = state.activityMessage;
  const seconds = state.activitySince === null ? 0 : Math.max(0, Math.floor((Date.now() - state.activitySince) / 1000));
  $('run-elapsed').textContent = state.activitySince !== null && (state.busy || state.posting) ? `${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}` : '';
  if ((state.busy || state.posting) && state.session?.authenticated && document.visibilityState !== 'hidden') state.activityTimer = setTimeout(renderActivity, 1000);
}
function activity(phase, message, fresh = false) {
  state.activityPhase = phase; state.activityMessage = message;
  if (fresh || (['sending', 'thinking', 'tool', 'responding', 'approval'].includes(phase) && state.activitySince === null)) state.activitySince = Date.now();
  if (['idle', 'completed', 'interrupted', 'failed', 'closed'].includes(phase)) state.activitySince = null;
  renderActivity();
}
function upstream(status) {
  state.upstreamStatus = status;
  connection(status === 'connected', status === 'closed' ? '连接已断开' : status === 'connected' ? (state.session?.mode === 'mock' ? '演示已连接' : '转发已连接') : '等待连接');
  if (status === 'closed') { stopSubscription(); stopOverview(); state.busy = false; state.turnId = null; state.approvals.clear(); renderApprovals(); activity('closed', sharedMode() ? '连接已断开。重连后会重新读取对话，消息不会自动重发。' : '连接已关闭；请重启 relay。不会自动重发消息。'); }
}
function controls() {
  const ready = !!state.session?.authenticated && state.connected;
  const readOnly = !!state.thread?.readOnly || !!state.thread?.archived || archiveFrozen() || !!(state.thread && state.session?.capabilities?.runtimeManagement && ((!catalogMode() && !managedRuntime()) || state.thread.unavailable || (catalogMode() && externalThread())));
  $('prompt').disabled = !ready || readOnly;
  const readyAttachments = state.attachments.some(attachment => attachment.status === 'ready'), pendingAttachments = state.attachments.some(attachment => attachment.status !== 'ready');
  $('send').disabled = !ready || readOnly || state.posting || pendingAttachments || state.modelChoiceRequired && !state.busy || (state.busy && (!sharedMode() || !state.turnId)) || (!$('prompt').value.trim() && !readyAttachments);
  for (const id of ['new-thread', 'top-new-thread', 'welcome-new-thread']) $(id).disabled = !ready || state.posting || !!state.operation?.busy || (state.busy && !sharedMode() && !state.session?.capabilities?.runtimeManagement) || state.projectSaving;
  $('join-thread').disabled = !ready || state.joining || state.posting || !!state.thread?.archived || !!state.thread?.unavailable || archiveFrozen();
  $('join-thread').textContent = state.joining ? '正在加入…' : '加入运行区';
  $('project').disabled = !ready || state.posting;
  $('draft-cwd').disabled = !ready || state.posting;
  $('add-project').disabled = !ready || state.projectSaving;
  $('edit-project').disabled = !ready || state.projectSaving || !selectedProject();
  $('cancel-directory').disabled = state.projectSaving;
  $('project-name').disabled = state.projectSaving;
  const multipleProjectRoots = state.directoryMode === 'edit' && (state.projectEdit?.roots || []).length > 1;
  $('directory-path').disabled = state.projectSaving || multipleProjectRoots;
  $('browse-directory').disabled = state.projectSaving || multipleProjectRoots;
  $('copy-directory').disabled = state.directoryLoading || !state.directory?.cwd;
  $('select-directory').disabled = state.projectSaving || state.directoryLoading || (!catalogMode() && !state.directory) || state.projectConflict;
  if (!catalogMode() && !state.thread && state.session?.capabilities?.workspaceBrowser && (!state.session?.capabilities?.runtimeManagement || !selectedProject())) { $('prompt').disabled = true; $('send').disabled = true; }
  if (catalogMode() && !sharedMode() && !state.thread && !$('draft-cwd').value.trim()) { $('prompt').disabled = true; $('send').disabled = true; }
  $('keep-running').disabled = !ready || state.keepRunningSaving || !state.thread || externalThread() || !!state.thread.archived;
  $('thread-settings-save').disabled = state.metadataSaving;
  $('thread-name').disabled = state.metadataSaving; $('thread-project').disabled = state.metadataSaving;
  if (catalogMode() && externalThread()) { $('join-thread').disabled = !ready || state.posting || !externalRuntime(); $('join-thread').textContent = externalRuntime() ? '安全停止外部运行' : '请先关闭外部 Codex'; }
  $('interrupt').hidden = !state.busy || readOnly;
  $('interrupt').disabled = !ready || readOnly || !state.turnId;
  $('send-label').textContent = sharedMode() && state.busy ? '补充' : '发送';
  $('send').setAttribute('aria-label', sharedMode() && state.busy ? '向当前任务补充消息' : '发送消息');
  $('prompt').placeholder = sharedMode() && state.busy ? '补充说明或调整当前任务…' : '发消息给 Codex…';
  $('reconnect').hidden = !sharedMode() || !state.session?.authenticated || state.connected;
  $('reconnect').disabled = !!state.reconnecting || state.posting;
  renderComposer();
  renderActivity();
  void syncRuntimePresence();
}
function setAuthenticated(value) {
  if (value) runtimePresence.suspended = false;
  if (state.session) state.session.authenticated = value;
  updateTerminalAccess();
  $('login').hidden = value;
  $('logout').hidden = !value || state.session?.mode === 'mock';
  if (!value) { state.threadLoadEpoch++; state.historyEpoch++; state.projectRefreshEpoch++; stopProjectRefresh(); closeProjectMenu(); $('sidebar-history').hidden = true; stopSubscription(); stopOverview(); state.busy = false; state.turnId = null; for (const id of state.userInputs.keys()) clearUserInput(id); clearComposerSession(); activity('idle', '登录后继续会话。'); $('approvals').hidden = true; }
  renderView();
  renderDeviceAuth();
  controls();
  if (value) { void loadComposerCatalog(); void loadPermissionProfiles(); scheduleProjectRefresh(); }
}
function renderView() {
  const authenticated = !!state.session?.authenticated;
  document.documentElement?.classList?.toggle('shared-daemon', sharedMode());
  $('home-view').hidden = !authenticated || state.view !== 'home';
  $('library-view').hidden = !authenticated || state.view !== 'library';
  $('operation-view').hidden = !authenticated || state.view !== 'operation';
  $('directory-view').hidden = !authenticated || state.view !== 'directory';
  $('thread-settings-view').hidden = !authenticated || state.view !== 'thread-settings';
  $('conversation').hidden = !authenticated || state.view !== 'chat';
  $('composer-area').hidden = !authenticated || state.view !== 'chat';
  $('mobile-tabs').hidden = !authenticated || ['directory', 'operation', 'thread-settings'].includes(state.view);
  $('thread-title').textContent = state.view === 'home' ? '主页' : state.view === 'library' ? '对话库' : state.view === 'operation' ? '操作确认与结果' : state.view === 'directory' ? state.projectEdit ? '编辑项目' : '新增项目' : state.view === 'thread-settings' ? '整理对话' : state.thread?.name || state.thread?.preview || '新会话';
  for (const [id, view] of [['nav-home', 'home'], ['nav-chat', 'library'], ['mobile-home', 'home'], ['mobile-chat', 'library']]) { $(id).classList.toggle('active', state.view === view); $(id).setAttribute('aria-current', state.view === view ? 'page' : 'false'); }
  $('runtime-help').hidden = !state.session?.capabilities?.runtimeManagement;
  $('thread-admission').hidden = !authenticated || state.view !== 'chat' || !state.thread || !state.session?.capabilities?.runtimeManagement || (!!managedRuntime() && !state.thread.archived && !state.thread.readOnly && !state.thread.unavailable && !archiveFrozen());
  if (catalogMode()) $('thread-admission').hidden = !authenticated || state.view !== 'chat' || !state.thread || !(state.thread.archived || archiveFrozen() || state.thread.unavailable || externalThread());
  $('thread-admission-text').textContent = admissionText(); $('join-thread').hidden = !!state.thread?.archived || (catalogMode() && !externalThread());
  $('chat-archive').hidden = !state.session?.capabilities?.archiveManagement || !state.thread || !!state.thread.archived;
  const cwd = state.thread?.cwd || (catalogMode() ? state.draftCwd || projectCwd(selectedProject()) : selectedProject()?.cwd) || '';
  $('chat-project-path').textContent = cwd; $('chat-project').hidden = !cwd;
  $('welcome-project').textContent = state.thread ? (cwd || '会话已就绪，发送你的任务。') : selectedProject() ? `新会话将使用「${selectedProject().name}」：${cwd}` : '先新增工作项目，选择服务器上的文件夹。';
  $('welcome-new-thread').textContent = selectedProject() ? '新建会话' : '新增工作项目';
  $('composer-note').textContent = state.session?.capabilities?.runtimeManagement && !state.thread ? '发送首条任务后创建会话；空白草稿不保存到 Codex 历史。' : '需要权限时，由你确认后继续。';
  $('welcome-new-thread').hidden = !!state.thread || !state.session?.capabilities?.workspaceBrowser || (!!state.session?.capabilities?.runtimeManagement && !!selectedProject());
  $('return-chat').hidden = !state.thread;
  $('return-chat-title').textContent = state.thread?.name || state.thread?.preview || '上次会话';
  $('approvals').hidden = state.view !== 'chat' || !$('approvals').children.length;
  $('draft-context').hidden = !catalogMode() || !!state.thread;
  $('edit-project').hidden = !selectedProject() || !state.session?.capabilities?.projectManagement;
  $('chat-menu').hidden = !catalogMode() || !state.thread || !!state.thread.archived;
  $('chat-actions').hidden = !catalogMode() || !state.thread || !!state.thread.archived || !state.chatActionsOpen;
  $('chat-lifecycle').hidden = !catalogMode() || !state.thread || !!state.thread.archived;
  $('keep-running').checked = !!state.thread?.keepRunning;
  $('idle-policy').textContent = state.thread?.keepRunning ? '已暂停自动回收' : '未连接且 2 小时无新产出后回收';
  if (catalogMode()) { $('welcome-project').textContent = state.thread ? admissionText() : '项目可选。发送第一条消息后，创建对话并启动独立运行环境。'; $('welcome-new-thread').hidden = true; $('chat-project').hidden = !state.thread?.cwd; $('chat-archive').hidden = true; }
  if (sharedMode()) {
    $('thread-title').textContent = state.view === 'home' ? '服务器' : state.view === 'library' ? state.searchTerm ? `搜索「${state.searchTerm}」` : '对话' : $('thread-title').textContent;
    $('home-title').textContent = '服务器';
    $('library-description').textContent = '搜索、继续或整理你的对话。项目只用于分组。';
    $('runtime-help').hidden = true; $('runtime-library').hidden = true; $('chat-lifecycle').hidden = true;
    $('chat-back-runtime').hidden = true; $('chat-back-library').hidden = true;
    $('thread-admission').hidden = !authenticated || state.view !== 'chat' || !state.thread || !(state.thread.archived || archiveFrozen() || state.thread.unavailable || state.thread.readOnly);
    $('join-thread').hidden = true;
    $('welcome-project').textContent = state.thread ? admissionText() : selectedProject() ? `在「${selectedProject().name}」中开始对话。` : '有想法就从这里开始。项目可以稍后再整理。';
    $('composer-note').textContent = state.busy ? state.turnId ? '补充消息会交给正在执行的任务。' : '正在确认当前任务状态，稍后可补充消息。' : 'Codex 可能会出错。需要权限时，由你确认后继续。';
    $('draft-options-label').textContent = selectedProject() ? `对话选项 · ${selectedProject().name}` : '对话选项';
    const model = state.thread?.model || state.session?.defaults?.model;
    const effort = state.thread?.reasoningEffort || state.session?.defaults?.reasoningEffort;
    const modelText = typeof model === 'string' && model ? [model, typeof effort === 'string' ? effort : ''].filter(Boolean).join(' · ') : '使用服务器模型设置';
    $('model-summary').textContent = modelText; $('composer-model').textContent = modelText;
  }
  $('open-server').hidden = !authenticated || !sharedMode();
  $('thread-filter-field').hidden = !authenticated || !sharedMode();
  $('internal-threads-field').hidden = !authenticated || !state.session?.capabilities?.internalThreads;
  $('nav-home-label').textContent = sharedMode() ? '服务器' : '主页';
  $('nav-chat-label').textContent = sharedMode() ? '对话' : '对话库';
  $('mobile-home-label').textContent = sharedMode() ? '服务器' : '主页';
  $('mobile-chat-label').textContent = sharedMode() ? '对话' : '对话库';
  $('project-name-field').hidden = state.directoryMode === 'browse';
  $('select-directory').hidden = state.directoryMode === 'browse'; $('copy-directory').hidden = state.directoryMode !== 'browse';
  if (state.view === 'directory' && state.directoryMode === 'browse') $('thread-title').textContent = '服务器目录';
  renderComposer();
  void syncRuntimePresence();
}
function showView(view) { if (state.view === 'operation' && state.operation?.busy && view !== 'operation') return; state.view = view; rememberSelection(); renderView(); if (view === 'home') startOverview(); else stopOverview(); if (view === 'chat') renderActivity(); if (view === 'library') run(() => history()); }
function sidebar(open) { if (!open) closeProjectMenu(); $('sidebar').classList.toggle('open', open); $('scrim').hidden = !open; $('open-sidebar').setAttribute('aria-expanded', String(open)); if (open) $('close-sidebar').focus(); else $('open-sidebar').focus(); }
const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => finite(value) && value >= 0 && value <= 100 ? `${Math.round(value)}%` : '暂不可用';
const usage = value => finite(value) && value >= 0 && value <= 100 ? value : null;
const ratio = (used, total) => finite(used) && finite(total) && total > 0 && used >= 0 && used <= total ? used / total * 100 : null;
function bytes(value) { if (!finite(value) || value < 0) return '未知'; if (value < 1024) return `${Math.round(value)} B`; const unit = value >= 1024 ** 4 ? 'TB' : value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : 'KB'; const divisor = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 }[unit]; return `${Number((value / divisor).toFixed(1))} ${unit}`; }
function statusType(status) { return typeof status === 'string' ? status : status?.type || 'unknown'; }
function threadProject(thread) { if (catalogMode()) return thread.projectId ?? null; return thread.projectId || state.session?.projects?.find(p => p.cwd === thread.cwd)?.id || (!state.session?.capabilities?.allThreads ? state.projectId : null); }
function selectedProject() { return state.session?.projects?.find(p => p.id === state.projectId); }
function activeProjectId() { if (catalogMode()) return state.thread?.projectId ?? state.projectId ?? null; return state.threadProjectId || threadProject(state.thread || {}) || state.projectId; }
async function restoreThreadProject(cwd, fallbackId) {
  if (catalogMode()) return fallbackId ?? null;
  if (!cwd) return fallbackId;
  const existing = state.session.projects.find(p => p.cwd === cwd); if (existing) return existing.id;
  const result = await api(`/api/projects?cwd=${encodeURIComponent(cwd)}`);
  state.session.projects = [...new Map([...state.session.projects, ...result.projects, result.project].map(project => [project.id, project])).values()];
  renderProjects();
  return result.project.id;
}
function threadName(thread) { return thread.name || thread.preview || '未命名对话'; }
function threadActivityStatus(thread) {
  if (sharedMode() && thread?.id === state.thread?.id && state.busy) return [...state.approvals.values()].some(approval => approval.params?.threadId === thread.id) ? 'waitingApproval' : 'working';
  const flags = thread?.status?.activeFlags || [];
  if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return 'waitingApproval';
  return managedRuntime(thread)?.status || statusType(thread?.status);
}
function matchesThreadFilter(thread) {
  if (!sharedMode() || !state.threadFilter || state.threadFilter === 'all') return true;
  const status = threadActivityStatus(thread);
  return state.threadFilter === 'approval' ? status === 'waitingApproval' : ['active', 'working', 'inProgress', 'waitingApproval'].includes(status);
}
function threadStatus(thread) {
  if (thread.archived) return '已归档';
  if (archiveFrozen(thread)) return '归档待核验';
  if (externalThread(thread)) return '外部运行';
  const runtime = managedRuntime(thread), status = threadActivityStatus(thread);
  if (status === 'working' || status === 'active' || status === 'inProgress') return '正在工作';
  if (status === 'waitingApproval') return '待你确认';
  if (sharedMode()) return status === 'systemError' || status === 'failed' ? '执行异常' : status === 'unknown' ? '状态未知' : '可继续';
  if (runtime) return runtime.status === 'idle' ? '空闲' : '状态未知';
  if (status === 'unknown') return '状态未知';
  return '已停止';
}
function mergeThread(thread) {
  for (const name of ['libraryThreads', 'recentThreads', 'pinnedThreads']) state[name] = state[name].map(item => item.id === thread.id ? { ...item, ...thread } : item);
  if (state.thread?.id === thread.id) { state.thread = { ...state.thread, ...thread }; state.threadProjectId = state.thread.projectId ?? null; }
  if (thread.pinned && !thread.archived && !state.pinnedThreads.some(item => item.id === thread.id)) state.pinnedThreads.unshift(thread);
  state.pinnedThreads = state.pinnedThreads.filter(item => item.pinned && !item.archived);
}
function threadActions(thread) {
  const actions = document.createElement('div'); actions.className = 'thread-action-list';
  if (thread.archived) return actions;
  actions.append(actionButton('重命名', () => openThreadSettings(thread, 'name'), 'text-button'), actionButton(thread.pinned ? '取消置顶' : '置顶', () => updateThreadMetadata(thread, { pinned: !thread.pinned }), 'text-button'), actionButton('移动到项目', () => openThreadSettings(thread, 'project'), 'text-button'));
  const runtime = managedRuntime(thread) || externalRuntime(thread);
  if (!sharedMode() && runtime?.runtimeId) actions.append(actionButton(externalThread(thread) ? '安全停止外部运行' : '停止运行', () => previewOperation('close', { ...runtime, threadId: thread.id, name: threadName(thread) }), 'text-button'));
  if (state.session?.capabilities?.archiveManagement && !thread.archived) actions.append(actionButton('归档', () => previewOperation('archive', thread), 'text-button'));
  return actions;
}
function sidebarThread(thread) {
  const row = document.createElement('div'); row.className = 'sidebar-thread'; row.dataset.threadId = thread.id;
  const button = document.createElement('button'); button.className = `thread-button${state.thread?.id === thread.id ? ' active' : ''}`; button.dataset.threadId = thread.id;
  const title = document.createElement('strong'); title.textContent = threadName(thread);
  const status = document.createElement('small'); status.className = 'thread-status'; status.textContent = threadStatus(thread); status.dataset.status = sharedMode() ? threadActivityStatus(thread) : managedRuntime(thread)?.status || (externalThread(thread) ? 'external' : 'stopped');
  status.hidden = sharedMode() && status.textContent === '可继续';
  button.setAttribute('title', threadName(thread)); button.setAttribute('aria-label', `${threadName(thread)}，${status.textContent}`); button.append(title, status); button.addEventListener('click', () => run(() => openThread(thread)));
  const more = document.createElement('button'); more.className = 'icon-button thread-more'; more.setAttribute('aria-label', `${threadName(thread)}的菜单`); more.setAttribute('aria-expanded', 'false');
  const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  for (const x of [5, 12, 19]) { const circle = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'circle') : document.createElement('circle'); circle.setAttribute('cx', String(x)); circle.setAttribute('cy', '12'); circle.setAttribute('r', '1'); svg.append(circle); }
  more.append(svg); const actions = threadActions(thread); actions.hidden = true;
  more.addEventListener('click', () => { actions.hidden = !actions.hidden; more.setAttribute('aria-expanded', String(!actions.hidden)); });
  row.append(button, more, actions); return row;
}
function sidebarEmpty(list, text) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = text; list.append(empty); }
function uniqueThreads(threads) { const result = new Map(); for (const thread of threads) if (thread?.id) result.set(thread.id, { ...result.get(thread.id), ...thread }); return [...result.values()]; }
function projectIcon(path) {
  const svg = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : document.createElement('path'); shape.setAttribute('d', path); svg.append(shape); return svg;
}
function closeProjectMenu() {
  if (state.projectMenu?.anchor) state.projectMenu.anchor.setAttribute('aria-expanded', 'false');
  state.projectMenu = null; $('project-menu').hidden = true;
}
function activateProjectRow(projectId) {
  state.activeProjectRow = projectId;
  for (const row of $('sidebar-projects').querySelectorAll('.native-project')) row.dataset.active = String(row.dataset.projectId === projectId);
}
function projectView() { return state.projectView || state.session?.projectView || { pinnedProjectIds: [], sections: [], memberships: {} }; }
async function refreshProjects({ force = false } = {}) {
  if (!state.session?.authenticated || !state.session?.capabilities?.nativeProjects) return;
  if (state.projectRefreshRequest && !force) return state.projectRefreshRequest;
  const epoch = ++state.projectRefreshEpoch, csrf = state.session.csrf;
  const request = (async () => {
    try {
      const result = await api('/api/projects');
      if (epoch !== state.projectRefreshEpoch || !state.session?.authenticated || csrf !== state.session.csrf) return;
      if (!Array.isArray(result.projects)) throw new Error('项目列表格式无效');
      state.session.projects = result.projects; if (result.projectView) { state.projectView = result.projectView; state.session.projectView = result.projectView; }
      $('project-refresh-status').hidden = true; renderProjects();
    } catch (failure) { if (epoch === state.projectRefreshEpoch && state.session?.authenticated) { $('project-refresh-status').textContent = '项目列表更新失败，可刷新对话列表重试。'; $('project-refresh-status').hidden = false; } }
    finally { if (state.projectRefreshRequest === request) state.projectRefreshRequest = null; scheduleProjectRefresh(); }
  })(); state.projectRefreshRequest = request; return request;
}
function stopProjectRefresh() { clearTimeout(state.projectRefreshTimer); state.projectRefreshTimer = null; }
function scheduleProjectRefresh() { stopProjectRefresh(); if (state.session?.authenticated && state.session?.capabilities?.nativeProjects && document.visibilityState !== 'hidden') state.projectRefreshTimer = setTimeout(() => { state.projectRefreshTimer = null; void refreshProjects(); }, 60000); }
async function updateProjectView(path, data) {
  const result = await api(path, data); if (result.projectView) { state.projectView = result.projectView; state.session.projectView = result.projectView; }
  await refreshProjects({ force: true }); renderSidebar(); return result;
}
async function moveProjectToTop(project) {
  const first = state.session.projects.find(item => item.id !== project.id); if (!first) return;
  await api('/api/projects/move', { projectId: project.id, beforeProjectId: first.id }); await refreshProjects({ force: true });
}
function positionProjectMenu(anchor) {
  const box = anchor?.getBoundingClientRect?.() || { right: 250, top: 180 }, bounds = $('project-menu').getBoundingClientRect?.() || { width: 244, height: 300 };
  const width = window.innerWidth || 1280, height = window.innerHeight || 800;
  $('project-menu').style?.setProperty('--project-menu-left', `${Math.max(10, Math.min(box.right + 6, width - bounds.width - 10))}px`);
  $('project-menu').style?.setProperty('--project-menu-top', `${Math.max(10, Math.min(box.top, height - bounds.height - 10))}px`);
}
function projectMenuItem(label, icon, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'project-menu-item'; button.setAttribute('role', 'menuitem');
  const text = document.createElement('span'); text.textContent = label; button.append(projectIcon(icon), text); button.addEventListener('click', () => { closeProjectMenu(); run(action); }); return button;
}
function openProjectMenu(project, anchor) {
  if (state.projectMenu?.project.id === project.id) { closeProjectMenu(); return; }
  closeProjectMenu(); state.projectMenu = { project, anchor }; activateProjectRow(project.id);
  const menu = $('project-menu'); menu.replaceChildren();
  if (state.session?.capabilities?.projectViewPreferences) menu.append(projectMenuItem(projectView().pinnedProjectIds?.includes(project.id) ? '取消置顶' : '置顶', 'M9 3h6l-1 6 4 4H6l4-4Zm3 10v8', () => updateProjectView('/api/project-view/pin', { projectId: project.id, pinned: !projectView().pinnedProjectIds?.includes(project.id) })));
  if (state.session?.capabilities?.projectReorder && !state.session?.capabilities?.projectViewPreferences && state.session.projects[0]?.id !== project.id) menu.append(projectMenuItem('移到顶部', 'M12 19V7m-5 5 5-5 5 5M5 4h14', () => moveProjectToTop(project)));
  if (state.session?.capabilities?.projectManagement) menu.append(projectMenuItem('编辑', 'm15 5 4 4M4 20l4-1L20 7l-4-4L4 15Z', () => { state.projectId = project.id; return openProjectEditor(true); }));
  if (state.session?.capabilities?.projectViewPreferences && state.session?.capabilities?.projectViewSections) {
    const divider = document.createElement('div'); divider.className = 'project-menu-separator'; divider.setAttribute('role', 'separator'); menu.append(divider);
    const entry = document.createElement('div'); entry.className = 'project-section-entry';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'project-menu-item'; trigger.setAttribute('role', 'menuitem'); trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); const label = document.createElement('span'); label.textContent = '分区'; trigger.append(projectIcon('M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01'), label, projectIcon('m9 6 6 6-6 6'));
    const submenu = document.createElement('div'); submenu.className = 'project-submenu'; submenu.setAttribute('role', 'menu'); submenu.hidden = true;
    for (const section of [{ id: null, name: '未分区' }, ...(projectView().sections || [])]) { const button = projectMenuItem(section.name, 'M4 6h16M4 12h16M4 18h16', () => updateProjectView('/api/project-view/assign', { projectId: project.id, sectionId: section.id })); button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String((projectView().memberships?.[project.id] || null) === section.id)); submenu.append(button); }
    const form = document.createElement('form'); form.className = 'project-section-form'; const input = document.createElement('input'); input.type = 'text'; input.maxLength = 80; input.placeholder = '新建分区'; input.setAttribute('aria-label', '新分区名称'); const create = document.createElement('button'); create.type = 'submit'; create.textContent = '创建'; const message = document.createElement('p'); message.className = 'inline-error'; message.hidden = true; form.append(input, create, message);
    form.addEventListener('submit', event => { event.preventDefault(); const name = input.value.trim(); if (!name) { input.focus(); return; } create.disabled = true; run(async () => { try { await updateProjectView('/api/project-view/sections', { name, projectId: project.id }); closeProjectMenu(); } catch (failure) { message.textContent = failure.message; message.hidden = false; } finally { create.disabled = false; } }); }); submenu.append(form);
    const show = () => { submenu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); const bounds = menu.getBoundingClientRect?.(); entry.classList.toggle('submenu-left', !!bounds && (window.innerWidth || 1280) - bounds.right < 230); positionProjectMenu(anchor); };
    trigger.addEventListener('click', () => { if (!submenu.hidden) { submenu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); } else show(); }); trigger.addEventListener('pointerenter', show); entry.append(trigger, submenu); menu.append(entry);
  }
  if (state.session?.capabilities?.workspaceBrowser) menu.append(projectMenuItem('浏览服务器目录', 'M3 7h7l2 2h9v11H3Z', () => openProjectDirectory(project)));
  if (state.session?.capabilities?.projectArchive || state.session?.capabilities?.projectRemoval) { const divider = document.createElement('div'); divider.className = 'project-menu-separator'; divider.setAttribute('role', 'separator'); menu.append(divider); }
  if (state.session?.capabilities?.projectArchive) menu.append(projectMenuItem('归档聊天', 'M4 4h16v5H4Zm1 5v11h14V9m-10 4h6', () => previewProjectOperation('project-archive', project)));
  if (state.session?.capabilities?.projectArchive && state.session?.capabilities?.projectRemoval) { const divider = document.createElement('div'); divider.className = 'project-menu-separator'; divider.setAttribute('role', 'separator'); menu.append(divider); }
  if (state.session?.capabilities?.projectRemoval) menu.append(projectMenuItem('移除项目', 'm6 6 12 12M18 6 6 18', () => previewProjectOperation('project-remove', project)));
  if (state.session?.capabilities?.projectViewPreferences) { const note = document.createElement('p'); note.className = 'project-menu-note'; note.textContent = state.session?.capabilities?.projectViewSections ? '置顶和分区仅用于网页侧栏' : '置顶仅用于网页侧栏'; menu.append(note); }
  menu.hidden = false; anchor?.setAttribute('aria-expanded', 'true'); positionProjectMenu(anchor); menu.querySelector?.('button')?.focus();
}
function renderSidebar() {
  if (!catalogMode()) return;
  $('pinned-threads').replaceChildren();
  for (const thread of state.pinnedThreads.filter(matchesThreadFilter)) $('pinned-threads').append(sidebarThread(thread));
  if (!state.pinnedThreads.length) sidebarEmpty($('pinned-threads'), '置顶的对话显示在这里');
  if (state.pinnedCursor) $('pinned-threads').append(actionButton('加载更多已置顶对话', () => refreshPinned(true), 'text-button'));
  $('sidebar-projects').replaceChildren();
  $('sidebar-projects').hidden = state.projectsCollapsed; $('toggle-projects').setAttribute('aria-expanded', String(!state.projectsCollapsed));
  const projects = state.session?.projects || [], view = projectView(), pinnedIds = new Set(view.pinnedProjectIds || []);
  const ordered = [...projects.filter(project => pinnedIds.has(project.id)), ...projects.filter(project => !pinnedIds.has(project.id))], sectionLists = new Map();
  for (const project of ordered) {
    const group = document.createElement('details'); group.className = 'sidebar-project native-project'; group.dataset.projectId = project.id; group.dataset.active = String((state.activeProjectRow || state.thread?.projectId) === project.id); group.open = state.expandedProjects?.has(project.id) || false;
    const summary = document.createElement('summary');
    const icon = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const folder = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : document.createElement('path'); folder.setAttribute('d', 'M3 6h6l2 2h10v12H3Z'); icon.append(folder);
    const label = document.createElement('span'); label.className = 'project-row-name'; label.textContent = project.name; summary.append(icon, label);
    const rowActions = document.createElement('span'); rowActions.className = 'project-row-actions';
    const more = document.createElement('button'); more.type = 'button'; more.className = 'project-row-button project-more'; more.setAttribute('aria-label', `${project.name}的项目菜单`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(state.projectMenu?.project.id === project.id)); more.append(projectIcon('M5 12h.01M12 12h.01M19 12h.01')); more.addEventListener('click', event => { event.preventDefault(); event.stopPropagation?.(); openProjectMenu(project, more); });
    const create = document.createElement('button'); create.type = 'button'; create.className = 'project-row-button project-create'; create.setAttribute('aria-label', `在${project.name}中新建对话`); create.append(projectIcon('M14 5H6v14h14v-8m-9 2 1-4 7-7 3 3-7 7Z')); create.addEventListener('click', event => { event.preventDefault(); event.stopPropagation?.(); closeProjectMenu(); run(() => openNewThread(project.id)); });
    rowActions.append(more, create); summary.append(rowActions); group.append(summary);
    summary.addEventListener('click', () => activateProjectRow(project.id));
    group.addEventListener('toggle', () => { state.expandedProjects ??= new Set(); if (group.open) state.expandedProjects.add(project.id); else state.expandedProjects.delete(project.id); });
    const chats = document.createElement('nav'); chats.setAttribute('aria-label', `${project.name}的最近对话`);
    for (const thread of state.recentThreads.filter(item => item.projectId === project.id && !item.archived && !item.pinned && !state.pinnedThreads.some(pinned => pinned.id === item.id) && matchesThreadFilter(item)).slice(0, sharedMode() ? 12 : 5)) chats.append(sidebarThread(thread));
    const moreChats = state.recentThreads.filter(item => item.projectId === project.id && !item.archived && !item.pinned).length > (sharedMode() ? 12 : 5) || state.recentCursor;
    group.append(chats); if (moreChats) group.append(actionButton('查看全部项目对话', () => openProjectLibrary(project.id), 'text-button'));
    const sectionId = !!state.session?.capabilities?.projectViewSections && !pinnedIds.has(project.id) && view.memberships?.[project.id], section = (view.sections || []).find(item => item.id === sectionId);
    if (section) { if (!sectionLists.has(section.id)) { const sectionNode = document.createElement('section'); sectionNode.className = 'sidebar-project-group'; const heading = document.createElement('h3'); heading.textContent = section.name; sectionNode.append(heading); sectionLists.set(section.id, sectionNode); $('sidebar-projects').append(sectionNode); } sectionLists.get(section.id).append(group); }
    else $('sidebar-projects').append(group);
  }
  if (!(state.session?.projects || []).length) sidebarEmpty($('sidebar-projects'), '项目可选，用于整理对话');
  $('threads').replaceChildren();
  const knownProjectIds = new Set((state.session?.projects || []).map(project => project.id));
  const recent = state.recentThreads.filter(item => !item.archived && !item.pinned && (!sharedMode() || !item.projectId || !knownProjectIds.has(item.projectId)) && matchesThreadFilter(item));
  for (const thread of recent) $('threads').append(sidebarThread(thread));
  if (!recent.length) sidebarEmpty($('threads'), sharedMode() && state.threadFilter && state.threadFilter !== 'all' ? '当前没有符合状态的对话' : '发送一条消息，开始新的对话');
  $('pinned-section').hidden = sharedMode() && !state.pinnedThreads.length;
  $('older-threads').hidden = !state.recentCursor;
  renderPendingProjectOperations();
  if (state.projectMenu) { const anchor = document.querySelector?.(`.native-project[data-project-id="${state.projectMenu.project.id}"] .project-more`); if (anchor) { state.projectMenu.anchor = anchor; positionProjectMenu(anchor); } }
}
function renderPendingProjectOperations() {
  $('project-operations').replaceChildren();
  for (const entry of state.session?.pendingProjectOperations || []) if (entry.operationId && !state.projectOperations.has(entry.operationId)) state.projectOperations.set(entry.operationId, { kind: entry.kind === 'remove' ? 'project-remove' : 'project-archive', target: { id: entry.projectId, name: entry.project?.name || entry.projectName || entry.projectId }, result: entry, preview: null, error: '', busy: false, priorView: 'chat' });
  for (const operation of state.projectOperations.values()) if (operation.result?.status !== 'complete') $('project-operations').append(actionButton(`核验「${operation.target.name}」${operation.kind === 'project-remove' ? '移除' : '归档'}结果`, () => { state.operation = operation; operation.priorView = state.view; sidebar(false); showView('operation'); renderProjectOperation(); return recheckProjectOperation(); }, 'text-button'));
}
async function previewProjectOperation(kind, project, changed = false) {
  const previous = state.operation, op = { kind, target: project, priorView: previous?.kind === kind && previous?.target.id === project.id ? previous.priorView : state.view, preview: null, result: null, busy: true, error: '', includeAssociated: false };
  state.operation = op; closeProjectMenu(); sidebar(false); showView('operation'); renderProjectOperation();
  try { op.preview = await api(`/api/projects/${kind === 'project-remove' ? 'remove' : 'archive'}/preview`, { projectId: project.id }); if (changed) op.error = '影响范围已重新检查，请核对后再确认。'; }
  catch (failure) { op.error = failure.message; }
  finally { op.busy = false; if (state.operation === op) renderProjectOperation(); controls(); }
}
function renderProjectOperation() {
  const op = state.operation; if (!op || !op.kind.startsWith('project-')) return;
  const removing = op.kind === 'project-remove', preview = op.preview, result = op.result, source = result || preview;
  const statuses = { archived: '已归档', alreadyArchived: '此前已归档', notArchived: '未归档', detached: '已取消项目归属', unassigned: '已取消项目归属', notDetached: '未取消归属', stillAssigned: '仍属于原项目', reassigned: '已归属其他项目', retained: '已保留', removed: '已移除', complete: '已完成', partial: '部分完成', executing: '执行中', unknown: '结果未知', notAttempted: '未尝试', unattempted: '未尝试', skipped: '未尝试', failed: '失败' };
  $('operation-title').textContent = result ? removing ? '项目移除结果' : '项目聊天归档结果' : removing ? '移除项目' : '归档项目聊天';
  $('operation-description').textContent = result ? result.status === 'complete' ? removing ? '项目已移除，聊天历史和服务器文件保留。' : '项目聊天归档已完成，请查看逐项结果。' : result.status === 'partial' ? '操作仅部分完成，请核对每一项结果。' : result.status === 'failed' ? '操作未完成，请查看逐项结果。' : '操作结果尚未确认，请重新核验。' : op.busy ? '正在读取完整影响范围…' : removing ? `移除「${op.target.name}」，并取消下列聊天的项目归属。聊天历史和服务器文件保留。` : `归档「${op.target.name}」中的下列聊天及关联子对话。确认前，请逐项检查。`;
  $('operation-details').replaceChildren();
  if (source) {
    const notice = result?.atomicityMessage || preview?.atomicityMessage; if (notice) { const paragraph = document.createElement('p'); paragraph.className = 'operation-blocked'; paragraph.textContent = notice; $('operation-details').append(paragraph); }
    const affected = uniqueThreads(source.affected || []), outside = new Set(result?.outsideProjectIds || preview?.outsideProjectIds || []);
    const describe = item => { const projectId = result && Object.hasOwn(item, 'currentProjectId') ? item.currentProjectId : item.projectId; return [result ? statuses[item.status] || item.status || '结果未知' : removing ? '取消项目归属，保留聊天' : item.archived ? '此前已归档' : '将归档', projectId ? state.session.projects.find(project => project.id === projectId)?.name || projectId : '未分配项目', item.id].filter(Boolean).join(' · '); };
    const members = affected.filter(item => item.isProjectMember !== false && !outside.has(item.id)), associated = affected.filter(item => item.isProjectMember === false || outside.has(item.id));
    $('operation-details').append(operationList('此项目的聊天', members, describe));
    if (associated.length) $('operation-details').append(operationList('其他项目或未分配的关联对话', associated, describe));
    for (const reason of preview?.blockedReasons || []) { const paragraph = document.createElement('p'); paragraph.className = 'operation-blocked'; paragraph.textContent = reason.message || reason; $('operation-details').append(paragraph); }
    if (result?.roots?.length) $('operation-details').append(operationList('各项操作回执', result.roots.map(item => ({ ...item, id: item.threadId || item.id, name: item.name || item.threadId || item.id })), item => [item.operationId, statuses[item.status] || item.status || '结果未知'].filter(Boolean).join(' · ')));
    for (const report of result?.reports || []) { const paragraph = document.createElement('p'); paragraph.className = 'operation-report'; paragraph.textContent = [report.phase, report.status, report.message].filter(Boolean).join(' · '); $('operation-details').append(paragraph); }
  }
  const needsAssociated = !result && !!preview?.requiresAssociatedConfirmation;
  $('project-associated-consent').hidden = !needsAssociated; $('include-associated-project-chats').checked = !!op.includeAssociated; $('include-associated-project-chats').disabled = op.busy;
  $('operation-error').textContent = op.error || ''; $('operation-error').hidden = !op.error; $('operation-back').disabled = op.busy;
  $('operation-confirm').hidden = !!result || !preview?.planId || !(removing ? preview.canRemove : preview.canArchive) || !!op.needsPreview;
  $('operation-confirm').disabled = op.busy || needsAssociated && !op.includeAssociated;
  $('operation-confirm').textContent = op.busy ? '正在处理…' : removing ? '确认移除项目' : `确认归档 ${(preview?.affected || []).length} 个对话`;
  $('operation-repreview').hidden = !!result || !op.needsPreview && !!preview; $('operation-repreview').disabled = op.busy;
  $('operation-recheck').hidden = !result?.operationId || result.status === 'complete'; $('operation-recheck').disabled = op.busy;
  $('operation-note').textContent = result && result.status !== 'complete' ? '重新核验只读取结果，不会补发归档或移除操作。未完成和未知项会保留。' : removing ? '此次操作保留聊天内容与服务器上的文件。' : '';
}
async function applyProjectOperationResult(op) {
  state.projectOperations.set(op.result.operationId, op);
  const successful = new Set((op.result.affected || []).filter(item => ['archived', 'alreadyArchived'].includes(item.status)).map(item => item.id));
  const unassigned = new Set((op.result.affected || []).filter(item => item.status === 'unassigned').map(item => item.id));
  for (const thread of [...state.libraryThreads, ...state.recentThreads, ...state.pinnedThreads, ...(state.thread ? [state.thread] : [])]) { if (successful.has(thread.id)) thread.archived = true; const current = op.result.affected?.find(item => item.id === thread.id); if (current && Object.hasOwn(current, 'currentProjectId')) thread.projectId = current.currentProjectId; else if (unassigned.has(thread.id) || op.result.projectRemoved === true && thread.projectId === op.target.id) thread.projectId = null; }
  if (op.result.projectRemoved && state.libraryProjectId === op.target.id) { state.libraryProjectId = null; state.historyScope = 'all'; }
  await refreshProjects({ force: true }); await run(() => history()); renderView(); controls(); renderPendingProjectOperations();
}
async function confirmProjectOperation() {
  const op = state.operation; if (!op?.kind.startsWith('project-') || op.busy || op.result || !op.preview?.planId || op.needsPreview || op.preview.requiresAssociatedConfirmation && !op.includeAssociated || !(op.kind === 'project-remove' ? op.preview.canRemove : op.preview.canArchive)) return;
  op.busy = true; op.error = ''; renderProjectOperation();
  try { op.result = await api(`/api/projects/${op.kind === 'project-remove' ? 'remove' : 'archive'}`, { planId: op.preview.planId, ...(op.kind === 'project-archive' && op.includeAssociated ? { includeAssociated: true } : {}) }); await applyProjectOperationResult(op); }
  catch (failure) {
    op.error = failure.message;
    if ((!failure.status || failure.status >= 500) && op.preview?.operationId) { op.result = { operationId: op.preview.operationId, kind: op.kind === 'project-remove' ? 'remove' : 'archive', projectId: op.target.id, status: 'unknown', affected: (op.preview.affected || []).map(item => ({ ...item, status: 'unknown' })), outsideProjectIds: op.preview.outsideProjectIds || [] }; state.projectOperations.set(op.result.operationId, op); op.error += ' 执行结果未确认，请只读核验；不会自动重复提交。'; renderPendingProjectOperations(); }
    else op.needsPreview = true;
  }
  finally { op.busy = false; if (state.operation === op) renderProjectOperation(); controls(); }
}
async function recheckProjectOperation() {
  const op = state.operation; if (!op?.kind.startsWith('project-') || !op.result?.operationId || op.busy) return;
  op.busy = true; op.error = ''; renderProjectOperation();
  try { op.result = await api(`/api/projects/${op.kind === 'project-remove' ? 'remove' : 'archive'}/recheck`, { operationId: op.result.operationId }); await applyProjectOperationResult(op); }
  catch (failure) { op.error = failure.message; }
  finally { op.busy = false; if (state.operation === op) renderProjectOperation(); controls(); }
}
async function refreshPinned(append = false) {
  if (!catalogMode()) return;
  const epoch = state.historyEpoch;
  const result = await api(`/api/threads?project=all&archived=false&pinned=true${state.includeInternal ? '&includeInternal=true' : ''}${append && state.pinnedCursor ? `&cursor=${encodeURIComponent(state.pinnedCursor)}` : ''}`);
  if (epoch !== state.historyEpoch || !state.session?.authenticated) return;
  state.pinnedThreads = uniqueThreads(append ? [...state.pinnedThreads, ...(result.data || [])] : result.data || []); state.pinnedCursor = result.nextCursor; renderSidebar();
}
function openProjectLibrary(projectId) { state.libraryProjectId = projectId; state.historyScope = projectId ? 'project' : 'all'; state.archived = false; state.searchTerm = ''; $('sidebar-search').value = ''; renderProjects(); showView('library'); sidebar(false); }
function renderChatActions() { $('chat-actions').replaceChildren(); if (catalogMode() && state.thread) $('chat-actions').append(threadActions(state.thread)); }
async function updateThreadMetadata(thread, patch) {
  if (!thread || thread.archived) return;
  const result = await api('/api/threads/metadata', { threadId: thread.id, ...patch }); if (!state.session?.authenticated) return; mergeThread(result.thread); renderProjects(); renderLibrary(); renderChatActions(); renderView(); rememberSelection();
}
function openThreadSettings(thread, focus = 'name') {
  if (!thread || thread.archived) return;
  state.threadEdit = { thread, priorView: state.view }; $('thread-name').value = threadName(thread); $('thread-project').replaceChildren();
  for (const [value, label] of [['', '未分配项目'], ...(state.session?.projects || []).map(project => [project.id, project.name])]) { const option = document.createElement('option'); option.value = value; option.textContent = label; $('thread-project').append(option); }
  $('thread-project').value = thread.projectId || ''; $('thread-settings-cwd').textContent = `执行目录：${thread.cwd || '未知'}`; $('thread-settings-error').hidden = true; state.chatActionsOpen = false; showView('thread-settings'); sidebar(false); $(focus === 'project' ? 'thread-project' : 'thread-name').focus();
}
async function saveThreadSettings() {
  if (!state.threadEdit || state.metadataSaving) return;
  const name = $('thread-name').value.trim(); if (!name) { $('thread-name').focus(); return; }
  state.metadataSaving = true; controls();
  try { await updateThreadMetadata(state.threadEdit.thread, { name, projectId: $('thread-project').value || null }); const prior = state.threadEdit.priorView; state.threadEdit = null; showView(prior); }
  catch (failure) { $('thread-settings-error').textContent = `${failure.message} 输入已保留，请重试。`; $('thread-settings-error').hidden = false; }
  finally { state.metadataSaving = false; controls(); }
}
async function setKeepRunning(thread, keepRunning) {
  if (!thread || thread.archived || state.keepRunningSaving || externalThread(thread)) return;
  state.keepRunningSaving = true; controls();
  try { const result = await api('/api/threads/keep-running', { threadId: thread.id, keepRunning }); mergeThread({ ...thread, keepRunning: result.keepRunning }); renderView(); renderSidebar(); }
  finally { state.keepRunningSaving = false; controls(); }
}
function renderProjects() {
  const projects = state.session?.projects || [];
  if (!projects.some(p => p.id === state.projectId)) state.projectId = catalogMode() ? null : projects[0]?.id || null;
  $('project').replaceChildren();
  if (catalogMode()) { const option = document.createElement('option'); option.value = ''; option.textContent = '未分配项目'; $('project').append(option); }
  for (const project of projects) { const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; $('project').append(option); }
  if (!projects.length && !catalogMode()) { const option = document.createElement('option'); option.value = ''; option.textContent = '尚无工作项目'; $('project').append(option); }
  $('project').value = state.projectId || ''; $('project-field').hidden = false;
  $('project-path').textContent = catalogMode() ? selectedProject()?.defaultCwd || '使用工作台默认目录' : selectedProject()?.cwd || '新增项目后，可直接新建会话。';
  $('project-path').setAttribute('title', selectedProject()?.cwd || '');
  $('project-management').hidden = !state.session?.capabilities?.projectManagement;
  $('history-filter').hidden = !state.session?.capabilities?.allThreads;
  $('sidebar-history').hidden = !state.session?.authenticated || (!catalogMode() && !!state.session?.capabilities?.library);
  $('archive-filter').hidden = !state.session?.capabilities?.library;
  if (catalogMode()) {
    $('history-scope').replaceChildren();
    for (const [value, label] of [['all', '全部对话'], ['unassigned', '未分配项目'], ...projects.map(project => [project.id, project.name])]) { const option = document.createElement('option'); option.value = value; option.textContent = label; $('history-scope').append(option); }
    $('history-scope').value = state.libraryProjectId || 'all';
    $('sidebar-search').disabled = !state.session?.authenticated;
    if (!state.draftCwd) state.draftCwd = projectCwd(selectedProject());
    $('draft-cwd').value = state.draftCwd;
    renderSidebar();
  } else $('history-scope').value = state.historyScope;
  $('history-title').textContent = sharedMode() ? '对话' : catalogMode() ? '最近对话' : state.session?.capabilities?.allThreads && state.historyScope === 'all' ? '全部会话' : '会话历史';
  controls();
}
async function openThread(thread) {
  const loadEpoch = ++state.threadLoadEpoch;
  if (sharedMode()) stopSubscription();
  if (sharedMode() || state.session?.capabilities?.library) {
    try {
      const result = await api('/api/resume', { threadId: thread.threadId || thread.id });
      if (loadEpoch !== state.threadLoadEpoch) return;
      if (sharedMode()) await installSharedSnapshot({ ...result, thread: { ...thread, ...result.thread } }, { loadEpoch, activate: true, preserve: state.thread?.id === result.thread.id });
      else renderThread({ ...thread, ...result.thread, runtimes: result.thread.runtimes || thread.runtimes || [] }, result.nextCursor, true, result.thread.projectId || state.session.projects.find(project => project.cwd === result.thread.cwd)?.id);
      if (loadEpoch === state.threadLoadEpoch) sidebar(false);
    } finally { if (sharedMode() && loadEpoch === state.threadLoadEpoch && !state.hydrating) subscribe(); }
    return;
  }
  const projectId = threadProject(thread);
  if (!projectId || thread.unavailable) { error('这个会话的项目文件夹暂不可用。'); return; }
  const result = await api('/api/resume', { projectId, threadId: thread.threadId || thread.id });
  renderThread({ ...thread, ...result.thread, runtimes: result.thread.runtimes || thread.runtimes || [] }, result.nextCursor, true, projectId); sidebar(false);
}
function resourceRow(label, value, detail = '', meters = [null]) {
  const row = document.createElement('div'); row.className = 'resource-row';
  const name = document.createElement('div'); name.className = 'resource-label'; name.textContent = label;
  const reading = document.createElement('div'); reading.className = 'resource-reading';
  const line = document.createElement('div'); line.className = 'resource-value'; const strong = document.createElement('strong'); strong.textContent = value;
  const context = document.createElement('span'); context.textContent = detail; line.append(strong); if (meters.length < 2) line.append(context); reading.append(line);
  for (const [index, amount] of meters.entries()) {
    const track = document.createElement('div'); track.className = `resource-meter${index ? ' memory-meter' : ''}`; track.setAttribute('aria-hidden', 'true'); track.dataset.known = String(finite(amount));
    if (finite(amount)) { const fill = document.createElement('span'); fill.style?.setProperty('--usage', `${Math.max(0, Math.min(100, amount))}%`); fill.dataset.percent = String(amount); track.append(fill); }
    reading.append(track);
    if (index === 0 && meters.length > 1) { const memory = document.createElement('div'); memory.className = 'resource-value memory-value'; memory.append(context); reading.append(memory); }
  }
  row.append(name, reading); return row;
}
function resourceGroup(family, label, rows) {
  const group = document.createElement('div'); group.className = 'resource-group'; group.dataset.resourceFamily = family; group.setAttribute('role', 'group'); group.setAttribute('aria-label', label); group.append(...rows); return group;
}
function tmuxLabel(agent) {
  if (agent.tmuxState === 'none') return '未使用 tmux';
  if (agent.tmuxState === 'attached' && typeof agent.tmux?.target === 'string' && /^\$\d+:\d+\.\d+$/.test(agent.tmux.target)) return `tmux ${agent.tmux.target}`;
  return '无法确认 tmux';
}
const runtimeLabels = { working: '正在工作', waitingApproval: '待确认', idle: '空闲', unknown: '状态未知' };
function renderOverview(value) {
  state.overview = value;
  const runtimeMode = !!state.session?.capabilities?.runtimeManagement;
  const allAgents = value.agents || [], rank = { working: 0, waitingApproval: 1, idle: 2, unknown: 3 };
  const agents = allAgents.filter(agent => sharedMode() ? agent.threadId && ['working', 'active', 'inProgress', 'waitingApproval'].includes(agent.status) : catalogMode() ? (agent.runtimeId || agent.threadId) && agent.status !== 'closed' : runtimeMode ? agent.tmuxState === 'attached' && (agent.runtimeId || agent.threadId) : agent.status === 'working' && typeof agent.threadId === 'string' && agent.threadId.trim()).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
  const incomplete = value.coverage?.externalComplete === false || allAgents.some(agent => agent.status === 'unknown');
  $('agent-summary').hidden = !agents.length && !incomplete;
  $('agent-summary').textContent = [agents.length ? runtimeMode ? `${agents.length} 个运行中的对话 · ${agents.filter(agent => agent.status === 'working').length} 个正在工作` : `${agents.length} 个对话正在运行` : '', incomplete ? '部分会话状态暂不可确认' : ''].filter(Boolean).join(' · ');
  if (sharedMode()) $('agent-summary').textContent = [agents.filter(agent => agent.status !== 'waitingApproval').length ? `${agents.filter(agent => agent.status !== 'waitingApproval').length} 个对话正在工作` : '', agents.some(agent => agent.status === 'waitingApproval') ? `${agents.filter(agent => agent.status === 'waitingApproval').length} 个等待确认` : '', incomplete ? '部分对话状态暂不可确认' : ''].filter(Boolean).join(' · ');
  $('agents').replaceChildren();
  if (!agents.length) { const empty = document.createElement('p'); empty.className = 'empty-agents'; empty.textContent = catalogMode() ? '暂无运行中的 Codex 对话。直接新建，或发送消息继续历史对话。' : runtimeMode ? '暂无 Codex 运行环境。可从对话库加入，或新建会话。' : incomplete ? '暂未发现正在工作的对话。' : '暂无正在工作的对话。'; $('agents').append(empty); }
  for (const agent of agents) {
    if (runtimeMode) {
      const row = document.createElement('article'); row.className = 'working-card runtime-card'; row.dataset.threadId = agent.threadId || ''; row.dataset.runtimeId = agent.runtimeId; row.dataset.status = agent.status;
      const heading = document.createElement('div'); heading.className = 'working-card-heading';
      const title = document.createElement('strong'); title.className = 'working-name'; title.textContent = agent.name || 'Codex 运行环境';
      const status = document.createElement('span'); status.className = 'working-state'; status.textContent = runtimeLabels[agent.status] || runtimeLabels.unknown; heading.append(title, status);
      const path = document.createElement('p'); path.className = 'runtime-path'; path.textContent = agent.cwd || '文件夹未知';
      const foot = document.createElement('div'); foot.className = 'working-card-foot'; const tmux = document.createElement('span'); tmux.className = 'working-tmux'; tmux.textContent = `${tmuxLabel(agent)} · ${agent.managed ? '网页运行' : catalogMode() ? '外部运行 / 只读' : '终端运行 / 只读'}`; foot.append(tmux);
      const actions = document.createElement('div'); actions.className = 'runtime-actions';
      if (agent.canOpen && agent.threadId) actions.append(actionButton('打开对话', () => openThread(agent), 'text-button'));
      if (agent.runtimeId) actions.append(actionButton(catalogMode() ? agent.managed ? '停止运行' : '安全停止外部运行' : '关闭运行环境', () => previewOperation('close', agent), 'text-button close-runtime'));
      row.append(heading, path, foot, actions);
      if (catalogMode() && agent.managed && agent.threadId) { const lifecycle = document.createElement('p'); lifecycle.className = 'runtime-policy'; lifecycle.textContent = agent.keepRunning ? '保持运行已开启，不自动回收' : '未连接且 2 小时无新产出后回收'; row.append(lifecycle); }
      $('agents').append(row); continue;
    }
    const row = document.createElement(agent.canOpen ? 'button' : 'div'); row.className = 'working-card'; row.dataset.threadId = agent.threadId;
    const heading = document.createElement('div'); heading.className = 'working-card-heading';
    const title = document.createElement('strong'); title.className = 'working-name'; title.textContent = agent.name || '未命名会话'; title.setAttribute('title', title.textContent);
    const status = document.createElement('span'); status.className = 'working-state'; status.textContent = sharedMode() ? threadStatus(agent) : '运行中'; heading.append(title, status);
    const project = document.createElement('p'); project.className = 'working-project'; project.textContent = state.session?.projects?.find(p => p.id === agent.projectId)?.name || agent.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '项目未知'; project.setAttribute('title', agent.cwd || '');
    const foot = document.createElement('div'); foot.className = 'working-card-foot'; const tmux = document.createElement('span'); tmux.className = 'working-tmux'; tmux.textContent = tmuxLabel(agent); if (!sharedMode()) foot.append(tmux);
    if (agent.canOpen) { const open = document.createElement('span'); open.className = 'working-open'; open.textContent = '查看会话'; foot.append(open); row.setAttribute('aria-label', `${title.textContent}，${project.textContent}，运行中，${tmux.textContent}`); row.addEventListener('click', () => run(() => openThread(agent))); }
    row.append(heading, project, foot);
    $('agents').append(row);
  }
  const metrics = value.metrics || {}, cpu = metrics.cpu || {}, memory = metrics.memory || {};
  const system = resourceGroup('system', 'CPU 与内存', [resourceRow('CPU', percent(cpu.percent), '', [usage(cpu.percent)]), resourceRow('内存', ratio(memory.usedBytes, memory.totalBytes) !== null ? `${bytes(memory.usedBytes)} / ${bytes(memory.totalBytes)}` : '暂不可用', '', [ratio(memory.usedBytes, memory.totalBytes)])]);
  const gpuGroup = resourceGroup('gpu', 'GPU', []), storageGroup = resourceGroup('storage', '储存', []);
  $('resource-list').replaceChildren(system, gpuGroup, storageGroup);
  const gpus = metrics.gpus || [];
  if (!gpus.length) gpuGroup.append(resourceRow('GPU', '暂不可用'));
  for (const [index, gpu] of gpus.entries()) {
    const memoryPercent = ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes);
    const row = resourceRow(gpus.length > 1 ? `GPU ${gpu.index ?? index}` : 'GPU', `计算 ${percent(gpu.utilizationPercent)}`, memoryPercent !== null ? `显存 ${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}` : '显存未知', [usage(gpu.utilizationPercent), memoryPercent]);
    row.dataset.memoryPressure = memoryPercent === null ? 'unknown' : memoryPercent >= 90 ? 'high' : 'normal';
    if (memoryPercent >= 90) { const warning = document.createElement('div'); warning.className = 'resource-warning'; warning.textContent = `显存占用高 · ${Number(memoryPercent.toFixed(1))}%`; row.children[1].append(warning); }
    gpuGroup.append(row);
  }
  const storage = metrics.storage || [];
  if (!storage.length) storageGroup.append(resourceRow('储存', '暂不可用'));
  for (const disk of storage) { const used = finite(disk.usedBytes) ? disk.usedBytes : finite(disk.totalBytes) && finite(disk.availableBytes) ? disk.totalBytes - disk.availableBytes : null; storageGroup.append(resourceRow(disk.path || '储存', ratio(used, disk.totalBytes) !== null ? `${bytes(used)} / ${bytes(disk.totalBytes)}` : '暂不可用', finite(disk.availableBytes) && disk.availableBytes >= 0 ? `${bytes(disk.availableBytes)} 可用` : '可用空间未知', [ratio(used, disk.totalBytes)])); }
  const sample = value.sampledAt ? new Date(typeof value.sampledAt === 'number' && value.sampledAt < 1e12 ? value.sampledAt * 1000 : value.sampledAt) : null;
  $('sample-time').textContent = sample && !Number.isNaN(sample.getTime()) ? `${sample.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 采样` : '';
  const errors = [...(metrics.errors || []), ...(value.errors || [])];
  const notice = [metrics.simulated ? '模拟资源数据。' : '', errors.length ? '部分资源暂不可用。' : ''].filter(Boolean).join(' ');
  $('resource-notice').hidden = !notice; $('resource-notice').textContent = notice;
  $('overview-error').hidden = true; renderView();
}
function stopOverview() { state.overviewEpoch++; clearTimeout(state.overviewTimer); state.overviewTimer = null; state.overviewRequest?.abort(); state.overviewRequest = null; $('refresh-overview').disabled = false; }
async function refreshOverview() {
  if (!state.session?.authenticated || state.upstreamStatus === 'closed' || state.view !== 'home' || document.visibilityState === 'hidden' || state.overviewRequest) return;
  if (!state.session.capabilities?.overview) { $('agent-summary').textContent = '服务器尚未提供工作状态'; $('agents').replaceChildren(); $('resource-list').replaceChildren(resourceRow('资源', '暂不可用')); return; }
  clearTimeout(state.overviewTimer); state.overviewTimer = null;
  const epoch = state.overviewEpoch, abort = new AbortController(); state.overviewRequest = abort; $('refresh-overview').disabled = true;
  try { const value = await api('/api/overview', undefined, abort.signal); if (epoch === state.overviewEpoch) renderOverview(value); }
  catch (failure) { if (epoch !== state.overviewEpoch || failure.name === 'AbortError') return; $('overview-error-text').textContent = state.overview ? '状态更新失败，当前仍显示上次采样。' : '暂时无法读取服务器状态。'; $('overview-error').hidden = true !== !!state.session?.authenticated; if (!state.overview) { $('agent-summary').textContent = '状态暂不可用'; $('agents').replaceChildren(); $('resource-list').replaceChildren(resourceRow('资源', '暂不可用')); } }
  finally { if (epoch === state.overviewEpoch) { state.overviewRequest = null; $('refresh-overview').disabled = false; if (state.session?.authenticated && state.view === 'home' && document.visibilityState !== 'hidden') state.overviewTimer = setTimeout(refreshOverview, 5000); } }
}
function startOverview() { if (!state.overviewRequest && !state.overviewTimer) void refreshOverview(); }
async function browseDirectory(path) {
  if (state.projectSaving) return;
  const epoch = ++state.directoryEpoch; state.directoryLoading = true; state.directory = null; $('select-directory').disabled = true; $('directory-up').disabled = true; $('directory-status').textContent = '正在读取文件夹…'; $('directory-list').replaceChildren();
  try {
    const directory = await api(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    if (epoch !== state.directoryEpoch || state.view !== 'directory') return;
    state.directory = directory; $('directory-path').value = directory.cwd; $('directory-current').textContent = directory.cwd; $('directory-up').disabled = !directory.parent; $('directory-roots').replaceChildren();
    for (const root of directory.roots || []) { const cwd = typeof root === 'string' ? root : root.cwd || root.path; const b = document.createElement('button'); b.textContent = typeof root === 'string' ? root : root.name || cwd; b.addEventListener('click', () => run(() => browseDirectory(cwd))); $('directory-roots').append(b); }
    for (const entry of directory.entries || []) { const b = document.createElement('button'); b.className = 'directory-row'; const icon = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); const folder = document.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', 'path') : document.createElement('path'); folder.setAttribute('d', 'M3 7h7l2 2h9v11H3Z'); icon.append(folder); const title = document.createElement('span'); title.textContent = entry.name; b.append(icon, title); b.addEventListener('click', () => run(() => browseDirectory(entry.cwd))); $('directory-list').append(b); }
    $('directory-status').textContent = directory.entries?.length ? directory.limited ? '仅显示部分文件夹，可输入完整路径打开。' : state.directoryMode === 'browse' ? '打开子目录，或复制当前路径。' : '选择子文件夹，或使用当前目录。' : state.directoryMode === 'browse' ? '当前目录没有可浏览的子目录。' : '这个文件夹没有可浏览的子文件夹，可直接使用。';
  } catch (failure) { if (epoch === state.directoryEpoch) { $('directory-status').textContent = `${failure.message} 请检查路径后重试。`; } }
  finally { if (epoch === state.directoryEpoch) { state.directoryLoading = false; controls(); } }
}
async function openProjectDirectory(project) {
  closeProjectMenu(); state.directoryMode = 'browse'; state.projectEdit = null; state.projectConflict = false;
  state.priorView = state.view === 'directory' ? state.priorView : state.view;
  $('directory-title').textContent = '浏览服务器目录'; $('directory-help').textContent = project.defaultCwd || project.cwd ? `浏览「${project.name}」的服务器目录，复制需要的路径。` : `「${project.name}」没有默认目录，当前显示服务器默认目录。`;
  $('project-save-error').hidden = true; $('directory-copy-status').textContent = ''; sidebar(false); showView('directory'); await browseDirectory(project.defaultCwd || project.cwd || defaultCwd());
}
async function openProjectEditor(edit = false) {
  if (state.projectSaving || !state.session?.capabilities?.projectManagement) return;
  const project = edit ? selectedProject() : null; if (edit && !project) return;
  closeProjectMenu(); state.directoryMode = 'edit'; $('directory-copy-status').textContent = '';
  state.projectEdit = project ? { ...project } : null; state.projectConflict = false; state.projectCreateKey = null;
  $('project-save-error').hidden = true; $('reload-project').hidden = true;
  $('project-name').value = project?.name || '';
  $('project-name').placeholder = project ? '输入项目名称' : '留空使用文件夹名称';
  $('directory-title').textContent = project ? '编辑项目' : '新增项目';
  $('directory-help').textContent = project ? '名称和绑定文件夹用于之后的新会话；已有会话继续使用原文件夹。' : '保存后，新会话直接使用此文件夹。';
  $('select-directory').textContent = '保存项目';
  state.priorView = state.view === 'directory' ? state.priorView : state.view;
  sidebar(false); showView('directory');
  if (catalogMode()) { $('project-name').placeholder = '输入项目名称'; $('directory-help').textContent = (project?.roots || []).length > 1 ? `此项目有 ${project.roots.length} 个目录，此处修改名称时会保留完整目录列表。` : '项目用于整理对话。默认目录只用于之后的新对话；已有对话的执行目录和历史保持不变。'; $('directory-path').value = project?.defaultCwd || ''; state.directory = null; state.directoryLoading = false; $('directory-current').textContent = ''; $('directory-list').replaceChildren(); $('directory-roots').replaceChildren(); $('directory-status').textContent = (project?.roots || []).length > 1 ? '多目录项目的目录列表在此保持不变。' : '默认目录可留空；填写后保存时会检查目录是否可用。'; $('directory-up').disabled = true; controls(); }
  else await browseDirectory(project?.cwd || selectedProject()?.cwd || state.session?.workspace?.defaultCwd);
}
async function saveProject() {
  if ((!catalogMode() && !state.directory) || state.directoryLoading || state.projectSaving || state.projectConflict) return;
  const name = $('project-name').value.trim();
  if (catalogMode() && !name) { $('project-save-error-text').textContent = '请输入项目名称。'; $('project-save-error').hidden = false; $('project-name').focus(); return; }
  const data = catalogMode() ? { name, defaultCwd: $('directory-path').value.trim() || null } : { cwd: state.directory.cwd }; if (name) data.name = name;
  if (catalogMode() && (state.projectEdit?.roots || []).length > 1) delete data.defaultCwd;
  if (catalogMode() && !state.projectEdit) { state.projectCreateKey ??= submissionId(); data.idempotencyKey = state.projectCreateKey; }
  if (state.projectEdit && !name) { $('project-save-error-text').textContent = '请输入项目名称后保存。'; $('project-save-error').hidden = false; $('project-name').focus(); return; }
  if (state.projectEdit) Object.assign(data, { projectId: state.projectEdit.id, revision: state.projectEdit.revision });
  state.projectSaving = true; $('project-save-error').hidden = true; $('select-directory').textContent = '正在保存…'; controls();
  try {
    const result = await api(state.projectEdit ? '/api/projects/update' : '/api/projects', data);
    state.session.projects = result.projects || [...state.session.projects.filter(p => p.id !== result.project.id), result.project];
    if (!catalogMode() && state.thread?.cwd && result.previousProject?.cwd === state.thread.cwd) state.threadProjectId = result.previousProject.id;
    else if (!catalogMode() && state.thread?.cwd) state.threadProjectId = state.session.projects.find(p => p.cwd === state.thread.cwd)?.id || state.threadProjectId;
    state.projectId = result.project.id; if (catalogMode() && !state.thread) state.draftCwd = projectCwd(result.project); state.projectCreateKey = null; renderProjects(); rememberSelection();
    await refreshProjects({ force: true });
    state.directoryEpoch++; showView(state.priorView); await run(() => history());
  } catch (failure) {
    state.projectConflict = failure.code === 'project_conflict';
    $('project-save-error-text').textContent = state.projectConflict ? '项目已在别处更新。重新载入后再修改；当前输入仍保留。' : `${failure.message} 输入已保留，请重试。`;
    $('project-save-error').hidden = false; $('reload-project').hidden = !state.projectConflict;
  } finally { state.projectSaving = false; $('select-directory').textContent = '保存项目'; controls(); }
}
async function reloadProject() {
  if (!state.projectEdit || state.projectSaving) return;
  const result = await api('/api/projects'); state.session.projects = result.projects; renderProjects();
  const project = result.projects.find(p => p.id === state.projectEdit.id);
  if (!project) throw new Error('项目已不可用，请返回后选择其他项目。');
  state.projectEdit = { ...project }; state.projectConflict = false; $('project-name').value = project.name;
  $('project-save-error').hidden = true; $('reload-project').hidden = true; if (catalogMode()) { $('directory-path').value = project.defaultCwd || ''; controls(); } else await browseDirectory(project.cwd);
}
async function openNewThread(projectId = null) {
  if (state.posting || state.operation?.busy || (state.busy && !sharedMode() && !state.session?.capabilities?.runtimeManagement) || state.projectSaving) return;
  if (catalogMode()) { state.projectId = typeof projectId === 'string' ? projectId : null; state.draftCwd = projectCwd(selectedProject()); renderProjects(); }
  if (!catalogMode() && !selectedProject() && state.session?.capabilities?.projectManagement) return openProjectEditor();
  if (catalogMode() || state.session?.capabilities?.runtimeManagement) {
    state.threadLoadEpoch++;
    clearDraftAttachments(); resetComposerChoices(); state.composerTarget = 'draft'; state.composerAuthority = null; state.composerContextThread = null;
    state.thread = null; state.threadProjectId = null; state.pending = null; state.historyCursor = null; state.busy = false; state.turnId = null;
    state.chatActionsOpen = false; clearMessages(); $('older-messages').hidden = true; $('welcome').hidden = false; $('prompt').value = '';
    sidebar(false); showView('chat'); activity('idle', sharedMode() ? '准备好后，发送你的消息。' : '发送第一条任务时创建独立运行环境并保存对话。'); controls(); if (sharedMode() && !state.hydrating) subscribe(); $('prompt').focus(); return;
  }
  sidebar(false); state.posting = true; controls();
  try { await createThread(); $('prompt').focus(); } finally { state.posting = false; controls(); renderActivity(); }
}
function nearBottom() { const c = $('conversation'); return c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
function scroll(force = false) { if (!state.suppressScroll && (force || nearBottom())) { $('conversation').scrollTop = $('conversation').scrollHeight; state.lastScrollTop = $('conversation').scrollTop; } }
function clearMessages() { state.messageEpoch++; state.loadingOlder = null; state.userScrollArmed = false; $('older-messages').disabled = false; $('older-messages').textContent = '加载更早的消息'; $('messages').replaceChildren(); state.items.clear(); }
function mergeItem(previous, incoming) {
  if (!previous) return incoming;
  const item = { ...previous, ...incoming };
  for (const field of ['text', 'aggregatedOutput']) if (typeof previous[field] === 'string' && typeof incoming[field] === 'string' && (previous[field].startsWith(incoming[field]) || incoming.truncated && previous[field].length > incoming[field].length)) item[field] = previous[field];
  for (const field of ['summary', 'content']) if (incoming.type === 'reasoning' && Array.isArray(previous[field]) && Array.isArray(incoming[field])) item[field] = Array.from({ length: Math.max(previous[field].length, incoming[field].length) }, (_, index) => {
    const before = typeof previous[field][index] === 'string' ? previous[field][index] : previous[field][index]?.text || '', after = typeof incoming[field][index] === 'string' ? incoming[field][index] : incoming[field][index]?.text || '';
    return before.startsWith(after) ? before : incoming[field][index] ?? previous[field][index];
  });
  if (incoming.truncated && ((item.text || '').length > (incoming.text || '').length || (item.aggregatedOutput || '').length > (incoming.aggregatedOutput || '').length)) item.truncated = !!previous.truncated;
  return item;
}
function mergeMessageOrder(previous, incoming) {
  const result = [], seen = new Set(), previousIndex = new Map(previous.map((entry, index) => [entry.item.id, index]));
  let position = 0, pending = [];
  const add = entry => { if (!seen.has(entry.item.id)) { seen.add(entry.item.id); result.push(entry); } };
  for (const entry of incoming) {
    const index = previousIndex.get(entry.item.id);
    if (index === undefined || index < position) { pending.push(entry); continue; }
    for (; position < index; position++) add(previous[position]);
    for (const item of pending) add(item); pending = [];
    add({ ...entry, item: mergeItem(previous[index].item, entry.item) }); position = index + 1;
  }
  if (!result.length) { for (const item of previous) add(item); }
  for (const item of pending) add(item);
  for (; position < previous.length; position++) add(previous[position]);
  return result;
}
function itemField(item, field, index) { const value = index === null ? item?.[field] : item?.[field]?.[index]; return typeof value === 'string' ? value : value?.text || ''; }
function deltaField(message) {
  const p = message.params || {};
  if (message.method === 'item/agentMessage/delta') return { id: p.itemId, type: 'agentMessage', field: 'text', index: null };
  if (message.method === 'item/commandExecution/outputDelta') return { id: p.itemId, type: 'commandExecution', field: 'aggregatedOutput', index: null };
  if (message.method === 'item/plan/delta') return { id: p.itemId, type: 'plan', field: 'text', index: null };
  if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(message.method)) return { id: p.itemId, type: 'reasoning', field: message.method.includes('summaryTextDelta') ? 'summary' : 'content', index: Math.min(100, Math.max(0, p.summaryIndex ?? p.contentIndex ?? 0)) };
  return null;
}
function snapshotOverlap(text, delta) {
  const pattern = delta.slice(0, text.length); if (!pattern) return 0;
  const prefix = new Array(pattern.length).fill(0);
  for (let index = 1, length = 0; index < pattern.length; index++) { while (length && pattern[index] !== pattern[length]) length = prefix[length - 1]; if (pattern[index] === pattern[length]) length++; prefix[index] = length; }
  let length = 0;
  for (let index = Math.max(0, text.length - pattern.length); index < text.length; index++) { const character = text[index]; while (length && character !== pattern[length]) length = prefix[length - 1]; if (character === pattern[length]) length++; }
  return length;
}
function replaySnapshotEvents(events, previous, snapshot, through) {
  const groups = new Map(), starts = new Map(), before = new Map(previous.map(entry => [entry.item.id, entry.item])), saved = new Map(snapshot.map(entry => [entry.item.id, entry.item]));
  for (const entry of events) {
    if (entry.event !== 'rpc') continue;
    const message = entry.data, p = message.params || {};
    if (p.threadId !== state.thread?.id) continue;
    if (message.method === 'item/started' && p.item?.id) starts.set(p.item.id, p.item);
    const field = deltaField(message); if (!field?.id) continue;
    const key = JSON.stringify([field.id, field.field, field.index]);
    if (!groups.has(key)) groups.set(key, { ...field, base: before.get(field.id) || starts.get(field.id), snapshot: saved.get(field.id), pre: '', post: '', applied: false });
    groups.get(key)[entry.id <= through ? 'pre' : 'post'] += p.delta || '';
  }
  for (const entry of events) {
    const field = entry.event === 'rpc' && entry.data.params?.threadId === state.thread?.id ? deltaField(entry.data) : null;
    if (!field) { handleEvent(entry.event, entry.data, entry.id); continue; }
    const group = groups.get(JSON.stringify([field.id, field.field, field.index]));
    state.eventCursor = Math.max(state.eventCursor || 0, entry.id || 0);
    if (group.applied) continue; group.applied = true;
    const savedText = itemField(group.snapshot, group.field, group.index), baseText = itemField(group.base, group.field, group.index);
    const replayed = baseText + group.pre;
    const text = group.base ? savedText.startsWith(replayed) ? savedText : replayed.startsWith(savedText) ? replayed : replayed : savedText + group.pre.slice(snapshotOverlap(savedText, group.pre));
    const item = { ...(state.items.get(group.id)?.item || group.snapshot || group.base), id: group.id, type: group.type };
    if (group.index === null) item[group.field] = text + group.post;
    else { item[group.field] = [...(item[group.field] || [])]; item[group.field][group.index] = text + group.post; }
    appendItem(item, entry.data.params?.turnId);
  }
}
async function installSharedSnapshot(result, { loadEpoch = state.threadLoadEpoch, activate = false, preserve = false, baselineCursor = state.eventCursor } = {}) {
  const previous = preserve && state.thread?.id === result.thread.id ? [...state.items.values()] : [];
  const previousHistoryCursor = state.historyCursor;
  const snapshot = (result.thread.turns || []).flatMap(turn => (turn.items || []).map(item => ({ item, turnId: turn.id })));
  const start = Number.isSafeInteger(result.eventCursor) ? preserve && Number.isSafeInteger(baselineCursor) ? Math.min(baselineCursor, result.eventCursor) : result.eventCursor : state.eventCursor;
  let page = null;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(result.eventCursorEnd) && result.eventCursorEnd > start) page = await api(`/api/poll?cursor=${start}&wait=0`);
  if (loadEpoch !== state.threadLoadEpoch) return;
  state.eventCursor = start;
  state.historyPagingMode = result.pagingMode || 'turns';
  renderThread(result.thread, previous.length ? previousHistoryCursor : result.nextCursor, activate, result.thread.projectId, { preserve });
  if (page?.resync) { state.eventCursor = page.cursor; error('实时消息缓冲已过期，已读取最新记录。请核对当前任务结果，必要时重新打开对话。'); return; }
  if (page && Array.isArray(page.events)) { state.replayingSnapshot = true; try { replaySnapshotEvents(page.events, previous, snapshot, result.eventCursorEnd); } finally { state.replayingSnapshot = false; } state.eventCursor = Math.max(state.eventCursor || 0, page.cursor || 0); }
}
function refreshLatestMessages() {
  if (!state.thread?.id || state.latestMessagesRequest?.threadId === state.thread.id) return state.latestMessagesRequest;
  const threadId = state.thread.id, loadEpoch = state.threadLoadEpoch, baselineCursor = state.eventCursor;
  stopSubscription();
  const request = (async () => {
    const page = await api(`/api/history?thread=${encodeURIComponent(threadId)}`);
    if (loadEpoch !== state.threadLoadEpoch || state.thread?.id !== threadId) return;
    await installSharedSnapshot({ ...page, thread: { ...state.thread, status: page.status || state.thread.status, activeTurnId: page.activeTurnId || null, turns: page.turns || [] } }, { loadEpoch, preserve: true, baselineCursor });
  })().finally(() => { if (state.latestMessagesRequest === request) state.latestMessagesRequest = null; if (loadEpoch === state.threadLoadEpoch && !state.hydrating) subscribe(); });
  request.threadId = threadId; state.latestMessagesRequest = request; return request;
}
function historyAnchor() {
  const container = $('conversation'), box = container.getBoundingClientRect?.();
  if (box) for (const entry of state.items.values()) { const bounds = entry.node.getBoundingClientRect?.(); if (bounds?.height > 0 && bounds.bottom > box.top) return { node: entry.node, top: bounds.top }; }
  return null;
}
async function loadOlderMessages() {
  if (!state.thread?.id || !state.historyCursor || state.loadingOlder) return;
  const request = { threadId: state.thread.id, cursor: state.historyCursor, epoch: state.messageEpoch };
  state.loadingOlder = request; state.userScrollArmed = false;
  const container = $('conversation');
  $('older-messages').disabled = true; $('older-messages').textContent = '正在加载…';
  try {
    const page = await api(`/api/history?${sharedMode() || state.session?.capabilities?.library ? '' : `project=${encodeURIComponent(activeProjectId())}&`}thread=${encodeURIComponent(request.threadId)}&cursor=${encodeURIComponent(request.cursor)}`);
    if (request.epoch !== state.messageEpoch || request.threadId !== state.thread?.id || request.cursor !== state.historyCursor) return;
    const beforeHeight = container.scrollHeight, beforeTop = container.scrollTop, anchor = historyAnchor();
    const existing = [...state.items.entries()], added = document.createDocumentFragment(), ids = [];
    state.suppressScroll = true;
    try { for (const turn of page.turns || []) for (const item of turn.items || []) { if (state.items.has(item.id)) { appendItem(item, turn.id); continue; } appendItem(item, turn.id); const entry = state.items.get(item.id); if (entry) { added.append(entry.node); ids.push(item.id); } } }
    finally { state.suppressScroll = false; }
    $('messages').prepend(added); state.items = new Map([...ids.map(id => [id, state.items.get(id)]), ...existing.map(([id]) => [id, state.items.get(id)])]);
    state.historyCursor = page.nextCursor; $('older-messages').hidden = !page.nextCursor;
    const after = anchor?.node.getBoundingClientRect?.();
    container.scrollTop = anchor && after ? container.scrollTop + after.top - anchor.top : beforeTop + container.scrollHeight - beforeHeight;
    state.lastScrollTop = container.scrollTop;
  } finally {
    if (state.loadingOlder === request) { state.loadingOlder = null; $('older-messages').disabled = false; $('older-messages').textContent = '加载更早的消息'; }
  }
}
function acceptTurnItems(turn, existingIds) {
  const firstReply = [...state.items.values()].find(entry => !existingIds.has(entry.item.id));
  for (const item of turn.items || []) {
    if (state.items.has(item.id)) continue;
    appendItem(item);
    if (item.type === 'userMessage' && firstReply) firstReply.node.before?.(state.items.get(item.id)?.node);
  }
}
const turnKey = (threadId, turnId) => JSON.stringify([threadId, turnId]);
function rememberTerminalTurn(threadId, turnId) {
  state.terminalTurns.add(turnKey(threadId, turnId));
  if (state.terminalTurns.size > 100) state.terminalTurns.delete(state.terminalTurns.values().next().value);
}
function acceptTurnStatus(threadId, turn) {
  if (state.terminalTurns.has(turnKey(threadId, turn.id)) || (state.turnId && state.turnId !== turn.id)) return;
  state.busy = turn.status === 'inProgress'; state.turnId = state.busy ? turn.id : null;
  if (!state.busy) rememberTerminalTurn(threadId, turn.id);
  if ([...state.approvals.values()].some(a => a.params.threadId === threadId)) activity('approval', '等待你确认操作');
  else if (state.busy && ['sending', 'idle'].includes(state.activityPhase)) activity('thinking', 'Codex 正在思考');
  else if (!state.busy) activity(turn.status, labels[turn.status] || '消息已发送。');
}
function appendItem(item, turnId = null) {
  if (!item?.id) return;
  const prior = state.items.get(item.id);
  item = mergeItem(prior?.item, item);
  const follow = !state.suppressScroll && nearBottom();
  const type = item.type;
  let node, body;
  if (prior) { node = prior.node; body = prior.body; }
  else if (type === 'userMessage' || type === 'agentMessage') {
    node = document.createElement('article'); node.className = `message ${type === 'userMessage' ? 'user' : 'agent'}`;
    const heading = document.createElement('div'); heading.className = 'message-heading';
    const name = document.createElement('span'); name.textContent = type === 'userMessage' ? '你' : 'Codex'; heading.append(name);
    body = document.createElement('div'); body.className = 'message-body'; node.append(heading, body); $('messages').append(node);
  } else if (['commandExecution', 'fileChange', 'reasoning', 'plan', 'mcpToolCall', 'webSearch'].includes(type)) {
    node = document.createElement('details'); node.className = 'message tool';
    const summary = document.createElement('summary'); summary.textContent = ({ commandExecution: '命令执行', fileChange: '文件改动', reasoning: '思考进度', plan: '任务计划', mcpToolCall: '工具调用', webSearch: '网页检索' })[type];
    body = document.createElement('pre'); node.append(summary, body); $('messages').append(node);
  } else return;
  let text = '';
  if (type === 'userMessage') text = (item.content || []).map(x => x.text || '').join('\n');
  else if (type === 'agentMessage') text = item.text || prior?.text || '';
  else if (type === 'commandExecution') text = [item.command, item.cwd ? `目录：${item.cwd}` : '', item.aggregatedOutput, item.status ? `状态：${labels[item.status] || item.status}` : ''].filter(Boolean).join('\n');
  else if (type === 'fileChange') text = (item.changes || []).map(x => `${x.path || ''}\n${x.diff || ''}`).join('\n\n');
  else if (type === 'reasoning') text = [...(item.summary || []), ...(item.content || [])].map(x => typeof x === 'string' ? x : x?.text || '').join('\n');
  else text = item.text || JSON.stringify(item, null, 2);
  body.textContent = text + (item.truncated ? '\n\n[此条显示已截断，请在服务器查看完整记录。]' : '');
  let attachmentNode = prior?.attachmentNode;
  if (type === 'userMessage' && item.attachments?.length) {
    if (!attachmentNode) { attachmentNode = document.createElement('div'); attachmentNode.className = 'message-attachments'; node.append(attachmentNode); }
    attachmentNode.replaceChildren();
    for (const attachment of item.attachments) { const chip = document.createElement('div'); chip.className = 'sent-attachment'; const name = document.createElement('strong'), detail = document.createElement('small'); name.textContent = attachment.name || '附件'; detail.textContent = bytes(attachment.size); chip.append(name, detail); attachmentNode.append(chip); }
  }
  if (type === 'userMessage') body.hidden = !text.trim();
  node.dataset.itemId = item.id;
  node.hidden = type === 'reasoning' && !text.trim();
  state.items.set(item.id, { node, body, text, item, attachmentNode, turnId: turnId || prior?.turnId || null }); $('welcome').hidden = true;
  if (follow) scroll(true);
}
function renderThread(thread, historyCursor = null, activate = true, projectId = null, options = {}) {
  const targetChanged = state.thread?.id !== thread.id;
  if (targetChanged && !options.composerTransfer) clearDraftAttachments();
  if (targetChanged) state.composerContextError = '';
  const previous = options.preserve && state.thread?.id === thread.id ? [...state.items.values()] : [];
  const beforeTop = $('conversation').scrollTop, following = nearBottom();
  state.threadProjectId = catalogMode() ? thread.projectId ?? null : projectId || thread.projectId || state.session?.projects?.find(p => p.cwd === thread.cwd)?.id || (state.session?.capabilities?.library ? null : state.threadProjectId || state.projectId);
  state.thread = thread; state.turnId = sharedMode() ? thread.activeTurnId || null : null; state.busy = !!state.turnId || ['active', 'inProgress', 'working', 'waitingApproval'].includes(statusType(thread.status)) || thread.runtimes?.some(runtime => runtime.status === 'working') || false; clearMessages();
  syncComposerAuthority(thread, thread.id);
  state.historyCursor = historyCursor; $('older-messages').hidden = !historyCursor;
  rememberSelection();
  $('thread-title').textContent = thread.name || thread.preview || '新的会话';
  const incoming = [];
  for (const turn of thread.turns || []) { for (const item of turn.items || []) incoming.push({ item, turnId: turn.id }); if (turn.status === 'inProgress' && !state.terminalTurns.has(turnKey(thread.id, turn.id))) { state.turnId = turn.id; state.busy = true; } }
  state.suppressScroll = true;
  for (const entry of previous.length ? mergeMessageOrder(previous, incoming) : incoming) appendItem(entry.item, entry.turnId);
  state.suppressScroll = false;
  $('welcome').hidden = state.items.size > 0;
  activity(state.busy ? 'thinking' : 'idle', state.busy ? 'Codex 正在思考' : '会话已就绪。');
  for (const button of $('threads').querySelectorAll('button')) button.classList.toggle('active', button.dataset.threadId === thread.id);
  state.chatActionsOpen = false; if (catalogMode()) { renderSidebar(); renderChatActions(); }
  renderApprovals(); if (activate) showView('chat'); else renderView(); controls(); if (!previous.length || following) scroll(true); else { $('conversation').scrollTop = beforeTop; state.lastScrollTop = beforeTop; }
  if (targetChanged) { void refreshComposerContext(thread.id); void loadPermissionProfiles(thread.id); }
}
async function history(append = false) {
  const all = catalogMode() || state.session?.capabilities?.allThreads && state.historyScope === 'all';
  if (!state.projectId && !all) return;
  const epoch = append ? state.historyEpoch : ++state.historyEpoch;
  $('library-status').textContent = '正在读取对话…'; $('refresh-library').disabled = true;
  let result; const projectsRequest = refreshProjects();
  try { result = await api(`/api/threads?project=${catalogMode() ? encodeURIComponent(state.libraryProjectId || 'all') : all ? 'all' : encodeURIComponent(state.projectId)}${state.session?.capabilities?.library ? `&archived=${state.archived}` : ''}${catalogMode() && state.searchTerm ? `&search=${encodeURIComponent(state.searchTerm)}` : ''}${catalogMode() && state.includeInternal ? '&includeInternal=true' : ''}${append && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ''}`); }
  catch (failure) { if (epoch === state.historyEpoch) $('library-status').textContent = '读取失败，当前列表保留。可点击刷新重试。'; throw failure; }
  finally { await projectsRequest; if (epoch === state.historyEpoch) $('refresh-library').disabled = false; }
  if (epoch !== state.historyEpoch) return;
  state.libraryThreads = uniqueThreads(append ? [...state.libraryThreads, ...(result.data || [])] : result.data || []);
  const current = state.libraryThreads.find(thread => thread.id === state.thread?.id); if (current && Object.hasOwn(current, 'projectId')) { state.thread.projectId = current.projectId; state.threadProjectId = current.projectId; }
  if (catalogMode()) {
    state.cursor = result.nextCursor;
    if (!state.archived && !state.libraryProjectId && !state.searchTerm) { state.recentThreads = state.libraryThreads; state.recentCursor = result.nextCursor; }
    renderSidebar(); renderLibrary();
    if (!append && !state.searchTerm && !state.archived) await refreshPinned();
    return;
  }
  if (!append) $('threads').replaceChildren();
  if (!result.data?.length && !append) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '还没有会话，发一条消息开始。'; $('threads').append(p); }
  for (const thread of result.data || []) {
    const b = document.createElement('button'); b.className = `thread-button${state.thread?.id === thread.id ? ' active' : ''}`; b.dataset.threadId = thread.id;
    const title = document.createElement('strong'); title.textContent = thread.name || thread.preview || '未命名会话';
    const detail = document.createElement('small'); const updated = thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleDateString('zh-CN') : ''; const status = statusType(thread.status); detail.textContent = [thread.unavailable ? '文件夹不可用' : ['active', 'inProgress', 'working'].includes(status) ? '正在工作' : status === 'waitingApproval' ? '待你确认' : updated, thread.cwd || ''].filter(Boolean).join(' · '); b.append(title, detail); b.disabled = !!thread.unavailable; b.setAttribute('title', thread.cwd || '');
    b.addEventListener('click', () => run(() => openThread(thread))); $('threads').append(b);
  }
  state.cursor = result.nextCursor; $('older-threads').hidden = !state.cursor; renderLibrary();
}
function actionButton(label, action, className = 'secondary') { const button = document.createElement('button'); button.className = className; button.textContent = label; button.addEventListener('click', () => run(action)); return button; }
function runtimeThread(result) { return { ...result.thread, runtimes: result.runtime ? [...(result.thread.runtimes || []).filter(runtime => runtime.runtimeId !== result.runtime.runtimeId), result.runtime] : result.thread.runtimes || [] }; }
function renderLibrary() {
  $('library-pending').replaceChildren();
  for (const pending of state.session?.pendingArchiveOperations || []) { const row = document.createElement('div'); row.className = 'pending-archive-row'; const text = document.createElement('p'); text.textContent = `上次归档待核验 · ${pending.threadId}${pending.freezeRetained ? ' · 相关对话暂不能加入运行区' : ''}`; row.append(text, actionButton('核验归档结果', () => openPendingArchive(pending))); $('library-pending').append(row); }
  $('library-list').replaceChildren(); $('library-archived').value = String(state.archived);
  $('library-title').textContent = catalogMode() && state.searchTerm ? `搜索「${state.searchTerm}」` : catalogMode() && state.libraryProjectId ? state.libraryProjectId === 'unassigned' ? '未分配项目的对话' : state.session.projects.find(project => project.id === state.libraryProjectId)?.name || '项目对话' : sharedMode() ? '对话' : '对话库';
  $('library-status').textContent = state.libraryThreads.length ? `已显示 ${state.libraryThreads.length} 个${state.archived ? '已归档' : ''}对话` : state.archived ? '暂无已归档对话。' : catalogMode() ? state.searchTerm ? '没有匹配标题的对话。试试其他关键词。' : '暂无对话。可以直接新建对话，项目可选。' : '暂无对话。选择工作项目后，可新建会话。';
  for (const thread of state.libraryThreads.filter(matchesThreadFilter)) {
    const row = document.createElement('article'); row.className = 'library-row'; row.dataset.threadId = thread.id;
    const content = document.createElement('div'); content.className = 'library-thread';
    const title = document.createElement('h3'); title.textContent = thread.name || thread.preview || '未命名对话';
    const path = document.createElement('p'); path.className = 'runtime-path'; path.textContent = thread.cwd || '文件夹未知';
    const meta = document.createElement('p'); meta.className = 'library-meta';
    const runtimes = thread.runtimes || [], managed = managedRuntime(thread);
    meta.textContent = [catalogMode() ? threadStatus(thread) : thread.archived ? '已归档' : archiveFrozen(thread) ? '归档结果待核验' : managed ? runtimeLabels[managed.status] || '网页运行' : runtimes.length ? '终端运行 / 只读' : '历史对话', catalogMode() ? state.session.projects.find(project => project.id === thread.projectId)?.name || '未分配项目' : '', thread.parentThreadId ? `子对话 · 上级 ${thread.parentThreadId}` : '', thread.unavailable ? '文件夹不可用' : ''].filter(Boolean).join(' · ');
    content.append(title, path, meta);
    const actions = document.createElement('div'); actions.className = 'library-actions';
    const open = actionButton(sharedMode() ? '打开' : '查看', () => openThread(thread)); open.disabled = !!thread.unavailable && !sharedMode() && !state.session?.capabilities?.library; actions.append(open);
    if (!catalogMode() && state.session?.capabilities?.runtimeManagement && !thread.archived && !managed) { const join = actionButton('加入运行区', () => joinThread(thread)); join.disabled = !!thread.unavailable || state.joining || archiveFrozen(thread); actions.append(join); }
    if (catalogMode() && !thread.archived) actions.append(actionButton('整理', () => openThreadSettings(thread), 'text-button'), actionButton(thread.pinned ? '取消置顶' : '置顶', () => updateThreadMetadata(thread, { pinned: !thread.pinned }), 'text-button'));
    const runtime = managed || externalRuntime(thread);
    if (!sharedMode() && catalogMode() && runtime?.runtimeId) actions.append(actionButton(externalThread(thread) ? '安全停止外部运行' : '停止运行', () => previewOperation('close', { ...runtime, threadId: thread.id, name: threadName(thread) }), 'text-button'));
    if (state.session?.capabilities?.archiveManagement && !thread.archived) actions.append(actionButton('归档', () => previewOperation('archive', thread), 'text-button'));
    row.append(content, actions); $('library-list').append(row);
  }
  $('library-older').hidden = !state.cursor;
}
async function joinThread(thread = state.thread) {
  if (catalogMode() && externalThread(thread)) { const runtime = externalRuntime(thread); if (runtime?.runtimeId) await previewOperation('close', { ...runtime, threadId: thread.id, name: threadName(thread) }); return; }
  if (!thread || thread.archived || thread.unavailable || archiveFrozen(thread) || state.joining || state.posting) return;
  state.joining = true; controls(); renderLibrary();
  try {
    const projectId = await restoreThreadProject(thread.cwd, threadProject(thread));
    const result = await api('/api/runtimes/join', { threadId: thread.id || thread.threadId, projectId });
    const joined = runtimeThread(result);
    state.libraryThreads = state.libraryThreads.map(item => item.id === joined.id ? { ...item, ...joined } : item);
    renderThread(joined, null, true, projectId); sidebar(false);
  } finally { state.joining = false; controls(); renderLibrary(); }
}
async function previewOperation(kind, target, changed = false) {
  if (state.operation?.busy) return;
  const priorView = state.view === 'operation' ? state.operation.priorView : state.view;
  state.operation = { kind, target, priorView, busy: true, preview: null, result: null, error: changed ? '影响范围已变化。请重新检查下方清单，再确认。' : '' };
  showView('operation'); renderOperation(); $('operation-title').focus();
  try { state.operation.preview = await api(kind === 'archive' ? '/api/library/archive/preview' : '/api/runtimes/close/preview', kind === 'archive' ? { threadId: target.id || target.threadId } : { runtimeId: target.runtimeId }); }
  catch (failure) { state.operation.error = failure.message; }
  finally { state.operation.busy = false; renderOperation(); }
}
function operationList(title, items, describe) {
  const section = document.createElement('section'); section.className = 'operation-group'; const heading = document.createElement('h3'); heading.textContent = `${title}（${items.length}）`; const list = document.createElement('ul');
  for (const item of items) { const li = document.createElement('li'), name = document.createElement('strong'), detail = document.createElement('p'); name.textContent = item.name || item.title || item.id || item.paneId || '未命名'; detail.textContent = describe(item); li.append(name, detail); list.append(li); }
  section.append(heading, list); return section;
}
function renderOperation() {
  const op = state.operation; if (!op) return;
  if (op.kind.startsWith('project-')) { renderProjectOperation(); return; }
  $('project-associated-consent').hidden = true;
  const archive = op.kind === 'archive', preview = op.preview, result = op.result;
  $('operation-title').textContent = result ? archive ? '归档结果' : catalogMode() ? '停止结果' : '关闭结果' : archive ? '归档对话' : catalogMode() ? '停止运行' : '关闭运行环境';
  $('operation-description').textContent = result ? archive ? ({ complete: '已完成归档，逐项结果如下。', partial: '归档仅部分完成。请检查每个对话的结果。', failed: '归档未完成。', unknown: '归档结果尚未确认，请重新核验。' }[result.status] || '请检查逐项结果。') : result.status === 'closed' ? '运行环境已关闭，对话保留在对话库。' : '未能确认全部关闭，请检查结果后刷新运行区。' : op.busy ? '正在读取影响范围…' : archive ? '归档会停止相关的网页运行环境，并归档下列对话及子对话。确认前，请逐项检查。' : preview?.scope === 'process' ? '将停止此对话的外部 Codex 进程。其他终端与 tmux 会话保留；历史可读，再次发送时恢复原对话。' : preview?.scope === 'pane' ? `将关闭 tmux 窗格 ${preview?.pane?.target || ''} 中的运行，其他窗格保留。对话仍在对话库，不会归档。` : `将关闭 tmux 会话 ${preview?.session?.name || preview?.session?.id || ''}，停止其中的执行。对话仍保留，不会归档。`;
  if (catalogMode() && !archive && result?.status === 'closed') $('operation-description').textContent = '运行已停止，历史保留。再次发送消息会恢复原对话。';
  if (sharedMode() && archive && !result && !op.busy) $('operation-description').textContent = '归档下列对话及子对话。存在进行中的任务、审批或待回答问题时，需先处理完毕。确认前，请逐项检查。';
  $('operation-details').replaceChildren();
  const statuses = { archived: '已归档', alreadyArchived: '此前已归档', notArchived: '未归档', unknown: '结果未知' };
  if (archive && (result || preview)) {
    const admissionNotice = result?.atomicityMessage || preview?.atomicityMessage;
    if (typeof admissionNotice === 'string' && admissionNotice) { const notice = document.createElement('p'); notice.className = 'operation-blocked'; notice.textContent = admissionNotice; $('operation-details').append(notice); }
    $('operation-details').append(operationList('受影响对话', (result || preview).affected || [], item => [item.id, item.cwd, result ? statuses[item.status] || '结果未知' : item.archived ? '此前已归档' : '将归档', !result && item.writers?.length ? `${new Set(item.writers.map(writer => writer.runId).filter(Boolean)).size} 个关联运行环境` : ''].filter(Boolean).join(' · ')));
    for (const reason of preview?.blockedReasons || []) { const p = document.createElement('p'); p.className = 'operation-blocked'; p.textContent = reason.message; $('operation-details').append(p); }
  } else if (preview) {
    $('operation-details').append(operationList('同一运行环境中的对话', preview.affectedThreads || [], item => item.id || ''));
    if (preview.otherPanes?.length) $('operation-details').append(operationList('其他终端窗格', preview.otherPanes, pane => [pane.target, pane.paneId, pane.commandLabel || pane.label || pane.type].filter(Boolean).join(' · ')));
    if (preview.working) { const p = document.createElement('p'); p.className = 'operation-blocked'; p.textContent = '此运行环境中仍有任务正在执行，关闭将停止它们。'; $('operation-details').append(p); }
    if (result?.affected?.length) $('operation-details').append(operationList('关闭回执', result.affected, item => [item.status, item.message].filter(Boolean).join(' · ')));
  }
  for (const report of result?.reports || []) { const p = document.createElement('p'); p.className = 'operation-report'; p.textContent = [report.phase, report.status, report.message].filter(Boolean).join(' · '); $('operation-details').append(p); }
  $('operation-error').hidden = !op.error; $('operation-error').textContent = op.error;
  $('operation-back').disabled = op.busy;
  $('operation-confirm').hidden = !!result || !preview?.planId || (archive && !preview.canArchive) || !!op.needsPreview;
  $('operation-confirm').disabled = op.busy;
  $('operation-confirm').textContent = op.busy ? '正在处理…' : archive ? `确认归档 ${(preview?.affected || []).length} 个对话` : catalogMode() ? '确认停止运行' : '确认关闭运行环境';
  $('operation-repreview').hidden = !!result || (!op.needsPreview && !!preview); $('operation-repreview').disabled = op.busy;
  $('operation-recheck').hidden = !archive || !result?.operationId || result.status === 'complete'; $('operation-recheck').disabled = op.busy;
  $('operation-note').textContent = result?.freezeRetained ? '部分结果尚未确认，相关对话暂不能加入运行区。重新核验只读取结果，不会再次归档。' : result && archive && result.status !== 'complete' ? '未归档和未知项不会按成功处理。重新核验只读取结果，不会再次执行归档。' : '';
}
async function confirmOperation() {
  if (state.operation?.kind.startsWith('project-')) return confirmProjectOperation();
  const op = state.operation; if (!op?.preview?.planId || op.busy || op.result || op.needsPreview || (op.kind === 'archive' && !op.preview.canArchive)) return;
  op.busy = true; op.error = ''; renderOperation();
  try {
    op.result = await api(op.kind === 'archive' ? '/api/library/archive' : '/api/runtimes/close', { planId: op.preview.planId });
    applyOperationResult(op);
  } catch (failure) { op.error = failure.message; op.needsPreview = true; if (failure.code === 'archive_plan_changed' || failure.code === 'runtime_plan_changed' || failure.code === 'close_plan_changed') op.error = '影响范围已变化。请重新检查后再确认。'; }
  finally { op.busy = false; renderOperation(); controls(); }
}
function applyOperationResult(op) {
  if (op.kind === 'archive') {
    if (op.result.freezeRetained) state.archiveFreezes.set(op.result.operationId, new Set((op.result.affected || []).map(item => item.id)));
    else state.archiveFreezes.delete(op.result.operationId);
    state.session.pendingArchiveOperations = (state.session.pendingArchiveOperations || []).filter(item => item.operationId !== op.result.operationId);
    if (op.result.status !== 'complete') state.session.pendingArchiveOperations.push({ operationId: op.result.operationId, threadId: op.result.threadId, status: op.result.status, freezeRetained: op.result.freezeRetained });
    const archived = new Set((op.result.affected || []).filter(item => ['archived', 'alreadyArchived'].includes(item.status)).map(item => item.id));
    for (const thread of [...state.libraryThreads, ...state.recentThreads, ...state.pinnedThreads]) if (archived.has(thread.id)) thread.archived = true;
    if (state.thread && archived.has(state.thread.id)) state.thread.archived = true;
  } else if (op.result.status === 'closed') {
    const keep = runtime => runtime.runtimeId !== op.target.runtimeId && (['pane', 'process'].includes(op.preview.scope) || !op.preview.session?.id || runtime.tmux?.sessionId !== op.preview.session.id);
    for (const thread of [...state.libraryThreads, ...state.recentThreads, ...state.pinnedThreads, ...(state.thread ? [state.thread] : [])]) { thread.runtimes = (thread.runtimes || []).filter(keep); if (catalogMode() && !externalRuntime(thread)) { thread.readOnly = false; delete thread.readOnlyReason; thread.status = 'idle'; } }
    if (state.thread && !managedRuntime()) { state.busy = false; state.turnId = null; }
  }
  if (catalogMode()) { renderSidebar(); renderChatActions(); } renderLibrary(); renderView(); controls();
}
async function recheckOperation() {
  if (state.operation?.kind.startsWith('project-')) return recheckProjectOperation();
  const op = state.operation; if (op?.kind !== 'archive' || !op.result?.operationId || op.busy) return;
  op.busy = true; op.error = ''; renderOperation();
  try { op.result = await api('/api/library/archive/recheck', { operationId: op.result.operationId }); applyOperationResult(op); }
  catch (failure) { op.error = failure.message; }
  finally { op.busy = false; renderOperation(); }
}
async function openPendingArchive(pending) {
  if (state.operation?.busy) return;
  state.operation = { kind: 'archive', target: { id: pending.threadId }, priorView: 'library', busy: false, preview: null, result: { ...pending, affected: [] }, error: '' };
  showView('operation'); renderOperation(); await recheckOperation();
}
function clearUserInput(requestId) {
  const form = state.userInputForms.get(requestId);
  if (form) for (const field of form.fields.values()) { if (field.text) field.text.value = ''; for (const option of field.options) option.input.checked = false; }
  state.userInputForms.delete(requestId); state.userInputs.delete(requestId);
}
function syncUserInputs(requests) {
  const present = new Set((requests || []).map(request => request.id));
  for (const id of state.userInputs.keys()) if (!present.has(id)) clearUserInput(id);
  for (const request of requests || []) state.userInputs.set(request.id, request);
}
function userInputForm(request) {
  if (state.userInputForms.has(request.id)) return state.userInputForms.get(request.id).node;
  const node = document.createElement('form'); node.className = 'approval user-input'; node.setAttribute('autocomplete', 'off'); node.dataset.requestId = request.id;
  const heading = document.createElement('h2'); heading.textContent = request.params?.isBlocking ? 'Codex 正在等待你的回答' : 'Codex 想确认几个问题'; node.append(heading);
  const questions = request.params?.questions;
  const supported = Array.isArray(questions) && questions.length > 0 && questions.length <= 20 && new Set(questions.map(question => question?.id)).size === questions.length && questions.every(question => typeof question?.id === 'string' && typeof question.question === 'string' && (question.options == null || Array.isArray(question.options) && question.options.length <= 30 && question.options.every(option => typeof option?.label === 'string' && typeof option.description === 'string')));
  if (!supported) { const notice = document.createElement('p'); notice.textContent = '此问题的格式暂不受支持。请在官方 Codex 客户端回答后，再回到此对话。'; node.append(notice); return node; }
  const fields = new Map(), controls = [], entry = { node, fields, sending: false };
  const questionFields = document.createElement('div'); questionFields.className = 'question-fields'; node.append(questionFields);
  for (const question of questions) {
    const group = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = question.question; group.append(legend);
    const field = { options: [], text: null, other: null }; fields.set(question.id, field);
    for (const option of question.options || []) {
      const label = document.createElement('label'); label.className = 'question-option';
      const input = document.createElement('input'); input.type = 'radio'; input.name = question.id; input.value = option.label; controls.push(input); field.options.push({ input, label: option.label });
      const copy = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small'); title.textContent = option.label; description.textContent = option.description; copy.append(title, description); label.append(input, copy); group.append(label);
    }
    if (!question.options?.length || question.isOther) {
      if (question.options?.length) { const label = document.createElement('label'); label.className = 'question-option'; const input = document.createElement('input'); input.type = 'radio'; input.name = question.id; const copy = document.createElement('span'); copy.textContent = '自定义回答'; label.append(input, copy); group.append(label); field.other = input; controls.push(input); }
      const input = document.createElement('input'); input.className = 'question-answer'; input.type = question.isSecret ? 'password' : 'text'; input.autocomplete = 'off'; input.maxLength = 16000; input.setAttribute('aria-label', `${question.question}的回答`); input.placeholder = question.isSecret ? '输入私密回答' : '输入你的回答'; field.text = input; controls.push(input); group.append(input);
      input.addEventListener('input', () => { if (field.other) field.other.checked = true; });
    }
    questionFields.append(group);
  }
  const message = document.createElement('p'); message.className = 'question-error'; message.setAttribute('role', 'status'); message.hidden = true;
  const submit = document.createElement('button'); submit.className = 'primary'; submit.type = 'submit'; submit.textContent = '发送回答'; controls.push(submit); node.append(message, submit);
  node.addEventListener('submit', event => {
    event.preventDefault();
    if (entry.sending || !state.userInputs.has(request.id)) return;
    const answers = {};
    for (const [id, field] of fields) {
      const selected = field.options.find(option => option.input.checked);
      const value = field.other?.checked || !field.options.length ? field.text?.value.trim() : selected?.label;
      if (!value) { message.textContent = '请回答每个问题后再发送。'; message.hidden = false; return; }
      Object.defineProperty(answers, id, { value: { answers: [value] }, enumerable: true });
    }
    entry.sending = true; for (const control of controls) control.disabled = true; message.hidden = true;
    run(async () => {
      try { await api('/api/user-input', { requestId: request.id, answers }); clearUserInput(request.id); renderApprovals(); }
      catch (failure) { if (state.userInputs.has(request.id)) { entry.sending = false; for (const control of controls) control.disabled = false; message.textContent = '回答结果未确认。请先核对连接与当前问题，再决定是否重试。'; message.hidden = false; } throw failure; }
    });
  });
  state.userInputForms.set(request.id, entry); return node;
}
function renderApprovals() {
  $('approvals').replaceChildren();
  for (const request of state.approvals.values()) {
    if (request.params.threadId !== state.thread?.id) continue;
    const node = document.createElement('div'); node.className = 'approval';
    const h = document.createElement('h2'); h.textContent = request.method.includes('commandExecution') ? '这条命令需要你确认' : '这些文件改动需要你确认'; node.append(h);
    const p = document.createElement('p'); p.textContent = request.params.reason || 'Codex 已暂停这一步，等待你的决定。'; node.append(p);
    const pre = document.createElement('pre'); pre.textContent = [request.params.command, request.params.cwd ? `目录：${request.params.cwd}` : '', request.params.networkApprovalContext ? `网络目标：${request.params.networkApprovalContext.host || ''} ${request.params.networkApprovalContext.protocol || ''}` : '', request.params.grantRoot ? `授权目录：${request.params.grantRoot}` : ''].filter(Boolean).join('\n') || '请先检查对话中的文件改动详情。'; node.append(pre);
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    for (const [decision, text] of [['decline', '拒绝'], ['accept', '仅批准这一次']]) { const b = document.createElement('button'); b.textContent = text; if (decision === 'accept') b.className = 'accept'; b.addEventListener('click', () => run(async () => { for (const btn of actions.children) btn.disabled = true; try { await api('/api/approvals', { requestId: request.id, decision }); state.approvals.delete(request.id); renderApprovals(); } catch (e) { for (const btn of actions.children) btn.disabled = false; throw e; } })); actions.append(b); }
    node.append(actions); $('approvals').append(node);
  }
  if (sharedMode()) for (const request of state.userInputs.values()) if (request.params?.threadId === state.thread?.id) $('approvals').append(userInputForm(request));
  $('approvals').hidden = state.view !== 'chat' || !$('approvals').children.length;
  if ([...state.userInputs.values()].some(request => request.params?.threadId === state.thread?.id && request.params?.isBlocking)) activity('approval', '等待你回答问题');
  else if ([...state.approvals.values()].some(a => a.params.threadId === state.thread?.id)) activity('approval', '等待你确认操作');
  else if (state.activityPhase === 'approval' && state.busy) activity('thinking', 'Codex 正在继续');
  if (sharedMode()) renderSidebar();
}
function rpc({ method, params: p = {} }) {
  if (method === 'serverRequest/resolved') { state.approvals.delete(p.requestId); clearUserInput(p.requestId); renderApprovals(); return; }
  if (sharedMode() && p.threadId) {
    const changedStatus = method === 'turn/started' ? 'active' : method === 'turn/completed' ? p.turn?.status === 'failed' ? 'systemError' : 'idle' : method === 'thread/status/changed' ? p.status : null;
    if (changedStatus) { mergeThread({ id: p.threadId, status: changedStatus }); if (p.threadId !== state.thread?.id) renderSidebar(); if (state.view === 'library') renderLibrary(); }
    if (method === 'turn/completed') for (const [id, request] of state.userInputs) if (request.params?.threadId === p.threadId && request.params?.turnId === p.turn?.id) clearUserInput(id);
  }
  if (p.threadId && p.threadId !== state.thread?.id) return;
  if (method === 'thread/tokenUsage/updated' && state.thread) { state.thread = { ...state.thread, tokenUsage: p.tokenUsage, context: null }; renderComposer(); }
  if (method === 'turn/started') { state.busy = true; state.turnId = p.turn.id; activity('thinking', 'Codex 正在思考'); void refreshComposerContext(state.thread?.id, { force: true }); }
  if (method === 'item/started' || method === 'item/completed') { appendItem(p.item, p.turnId); if (state.busy && method === 'item/started') activity(p.item?.type === 'reasoning' ? 'thinking' : p.item?.type === 'agentMessage' ? 'responding' : 'tool', p.item?.type === 'reasoning' ? 'Codex 正在思考' : p.item?.type === 'agentMessage' ? 'Codex 正在回复' : ({ commandExecution: '正在执行命令', fileChange: '正在修改文件', webSearch: '正在检索网页', mcpToolCall: '正在调用工具' })[p.item?.type] || 'Codex 正在执行'); }
  if (method === 'item/agentMessage/delta') { const old = state.items.get(p.itemId); appendItem({ id: p.itemId, type: 'agentMessage', text: (old?.text || '') + p.delta }); if (state.busy) activity('responding', 'Codex 正在回复'); }
  if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) { const old = state.items.get(p.itemId); const key = method.includes('summaryTextDelta') ? 'summary' : 'content'; const segments = [...(old?.item?.[key] || [])]; const index = Math.min(100, Math.max(0, p.summaryIndex ?? p.contentIndex ?? 0)); segments[index] = (typeof segments[index] === 'string' ? segments[index] : segments[index]?.text || '') + (p.delta || ''); appendItem({ ...old?.item, id: p.itemId, type: 'reasoning', [key]: segments }); if (state.busy) activity('thinking', 'Codex 正在思考'); }
  if (method === 'item/plan/delta') { const old = state.items.get(p.itemId); appendItem({ ...old?.item, id: p.itemId, type: 'plan', text: (old?.text || '') + (p.delta || '') }); }
  if (method === 'turn/plan/updated') appendItem({ id: `plan-${p.turnId}`, type: 'plan', text: [p.explanation, ...(p.plan || []).map(step => `${({ pending: '待执行', inProgress: '进行中', completed: '已完成' })[step.status] || '待执行'} · ${step.step}`)].filter(Boolean).join('\n') });
  if (method === 'item/commandExecution/outputDelta') { const old = state.items.get(p.itemId); if (old) appendItem({ ...old.item, aggregatedOutput: (old.item.aggregatedOutput || '') + p.delta }); }
  if (method === 'turn/completed') { for (const item of p.turn.items || []) appendItem(item, p.turn.id); rememberTerminalTurn(p.threadId || state.thread?.id, p.turn.id); state.busy = false; state.turnId = null; activity(p.turn.status || 'completed', labels[p.turn.status] || '任务已结束。'); for (const [id, a] of state.approvals) if (a.params.turnId === p.turn.id) state.approvals.delete(id); renderApprovals(); run(() => history()); if (sharedMode() && !state.replayingSnapshot && !state.hydrating && (!(p.turn.items || []).length || p.turn.itemsView === 'notLoaded')) run(refreshLatestMessages); }
  if (method === 'thread/status/changed' && p.status) { const status = statusType(p.status); if (status === 'active' && !state.busy) { state.busy = true; activity('thinking', 'Codex 正在工作'); } else if (['idle', 'notLoaded', 'systemError'].includes(status) && state.busy && !state.posting) { state.busy = false; state.turnId = null; activity(status === 'systemError' ? 'failed' : 'idle', status === 'systemError' ? '执行状态异常，请查看当前会话。' : '会话已就绪。'); } }
  if (method === 'error') error('服务器上的 Codex 报告执行错误，请检查当前任务。');
  controls();
  if (sharedMode() && ['turn/started', 'turn/completed', 'thread/status/changed'].includes(method)) renderSidebar();
}
function stopSubscription() {
  stopActivityClock();
  state.transportEpoch++; clearTimeout(state.transportTimer); state.transportTimer = null;
  state.events?.close(); state.events = null; state.pollAbort?.abort(); state.pollAbort = null;
}
const closedRuntimeEvents = new Set();
function updateClosedRuntimes(closedRuntimes, { superseded = false } = {}) {
  const closed = closedRuntimes.filter(runtime => typeof runtime?.runtimeId === 'string' && runtime.runtimeId && typeof runtime.threadId === 'string');
  const ids = new Set(closed.map(runtime => runtime.runtimeId)), stoppedThreads = new Set();
  const currentClosed = state.thread?.runtimes?.some(runtime => ids.has(runtime.runtimeId)) || false;
  let fresh = false;
  for (const runtimeId of ids) { if (!closedRuntimeEvents.has(runtimeId)) fresh = true; closedRuntimeEvents.add(runtimeId); }
  while (closedRuntimeEvents.size > 256) closedRuntimeEvents.delete(closedRuntimeEvents.values().next().value);
  const threads = new Set([...state.libraryThreads, ...state.recentThreads, ...state.pinnedThreads, ...(state.thread ? [state.thread] : [])]);
  for (const thread of threads) {
    if (!(thread.runtimes || []).some(runtime => ids.has(runtime.runtimeId))) continue;
    thread.runtimes = thread.runtimes.filter(runtime => !ids.has(runtime.runtimeId));
    if (!thread.runtimes.some(runtime => runtime.status !== 'closed')) {
      thread.status = superseded ? 'unknown' : 'idle';
      if (!superseded) { stoppedThreads.add(thread.id); thread.readOnly = false; delete thread.readOnlyReason; }
    }
  }
  for (const thread of threads) if (thread.runtimes?.some(runtime => runtime.status !== 'closed')) stoppedThreads.delete(thread.id);
  if (state.thread?.runtimes?.some(runtime => runtime.status !== 'closed')) mergeThread(state.thread);
  const invalidApproval = (approval, id = approval.id) => closed.some(runtime => approval.params?.threadId === runtime.threadId && (String(id).startsWith(`${runtime.runtimeId}:`) || stoppedThreads.has(runtime.threadId)));
  for (const [id, approval] of state.approvals) if (invalidApproval(approval, id)) state.approvals.delete(id);
  if (state.session?.pendingApprovals) state.session.pendingApprovals = state.session.pendingApprovals.filter(approval => !invalidApproval(approval));
  if (currentClosed && !superseded && !state.thread.runtimes.some(runtime => runtime.status !== 'closed')) {
    if (state.turnId) rememberTerminalTurn(state.thread.id, state.turnId);
    state.busy = false; state.turnId = null; activity('closed', '运行已断开；历史保留，本轮结果请核对。');
  }
  if (state.overview?.agents) renderOverview({ ...state.overview, agents: state.overview.agents.filter(runtime => !ids.has(runtime.runtimeId)) });
  renderApprovals(); renderSidebar(); renderLibrary(); renderChatActions(); renderView(); controls();
  if (state.view === 'home' && fresh) { stopOverview(); void refreshOverview(); }
  if (currentClosed && superseded && !state.thread.runtimes.length) run(() => hydrate(true));
}
function refreshClosedRuntimeState() {
  if (state.view === 'home') { stopOverview(); void refreshOverview(); }
  run(() => hydrate(true));
}
function handleEvent(event, data, id) {
  const control = event === 'relay' && ['connected', 'idle', 'closed', 'reset', 'replay-reset', 'resync'].includes(data.status);
  if (!control && Number.isSafeInteger(id) && state.eventCursor !== null && id <= state.eventCursor) return;
  if (Number.isSafeInteger(id)) state.eventCursor = Math.max(state.eventCursor || 0, id);
  if (event === 'rpc') rpc(data);
  if (event === 'approval') { state.approvals.set(data.id, data); renderApprovals(); }
  if (event === 'relay') {
    if (data.status === 'user-input') { const request = data.request || data.userInput || data; if (request.id && request.params) { state.userInputs.set(request.id, request); renderApprovals(); } return; }
    if (data.status === 'user-input-resolved') { clearUserInput(data.requestId); renderApprovals(); return; }
    if (['connected', 'idle'].includes(data.status)) upstream(data.status);
    if (['disconnected', 'error', 'closed'].includes(data.status)) upstream('closed');
    if (data.status === 'approval-resolved') { state.approvals.delete(data.requestId); renderApprovals(); }
    if (data.status === 'runtime-closed') { if (data.runtimeId) updateClosedRuntimes([data], { superseded: data.superseded === true }); else refreshClosedRuntimeState(); return; }
    if (data.status === 'runtime-cleaned') { if (Array.isArray(data.closedRuntimes) && data.closedRuntimes.length) updateClosedRuntimes(data.closedRuntimes); else refreshClosedRuntimeState(); return; }
    if (['reset', 'replay-reset', 'resync'].includes(data.status)) { run(() => hydrate(true)); return; }
    if (data.message) activity(state.activityPhase, data.message);
  }
}
async function pollEvents(epoch) {
  if (epoch !== state.transportEpoch || !state.session?.authenticated || state.upstreamStatus === 'closed' || document.visibilityState === 'hidden') return;
  const abort = new AbortController(); state.pollAbort = abort;
  try {
    state.transportTimer = setTimeout(() => abort.abort(), 25000);
    const response = await fetch(`/api/poll?cursor=${state.eventCursor || 0}&wait=20000`, { credentials: requestCredentials(), headers: authHeaders(), signal: abort.signal });
    const page = await response.json();
    if (epoch !== state.transportEpoch) return;
    if (!response.ok) { const failure = new Error(page.error?.message || '事件连接未完成。'); failure.status = response.status; throw failure; }
    if (!Array.isArray(page.events) || !Number.isSafeInteger(page.cursor) || typeof page.resync !== 'boolean' || !['idle', 'connected', 'closed'].includes(page.upstreamStatus)) throw new Error('事件响应无效。');
    clearTimeout(state.transportTimer); state.transportTimer = null; state.pollAbort = null; state.eventFailures = 0;
    if (page.resync) { state.eventCursor = page.cursor; upstream(page.upstreamStatus); if (page.upstreamStatus !== 'closed') await hydrate(true); return; }
    for (const entry of page.events) { handleEvent(entry.event, entry.data, entry.id); if (epoch !== state.transportEpoch) return; }
    state.eventCursor = Math.max(state.eventCursor || 0, page.cursor);
    upstream(page.upstreamStatus); if (epoch !== state.transportEpoch) return;
    state.transportTimer = setTimeout(() => pollEvents(epoch), 0);
  } catch (failure) {
    if (epoch !== state.transportEpoch) return;
    clearTimeout(state.transportTimer); state.transportTimer = null; state.pollAbort = null;
    if (failure.status === 401 || failure.status === 403) { if (failure.status === 401) rememberToken(''); connection(false, failure.status === 401 ? '等待登录' : '连接被拒绝'); setAuthenticated(false); if (failure.status === 401 && state.session?.capabilities?.deviceAuthentication) scheduleDeviceRecovery(); else error(failure.message); return; }
    connection(false, '正在重连'); activity('reconnecting', '连接暂时中断，正在重连；不会自动重发消息。');
    state.eventFailures++; state.transportTimer = setTimeout(() => pollEvents(epoch), Math.min(1000 * 2 ** Math.min(state.eventFailures - 1, 4), 15000));
  }
}
function subscribe() {
  stopSubscription();
  if (!state.session?.authenticated || state.upstreamStatus === 'closed' || document.visibilityState === 'hidden') return;
  renderActivity();
  const epoch = state.transportEpoch;
  if (state.session.authTransport === 'bearer' || state.transportMode === 'poll' || typeof EventSource === 'undefined') { state.transportMode = 'poll'; pollEvents(epoch); return; }
  const es = new EventSource(`/api/events${state.eventCursor === null ? '' : `?cursor=${state.eventCursor}`}`); state.events = es;
  const fallback = () => { if (epoch !== state.transportEpoch) return; state.transportMode = 'poll'; subscribe(); };
  state.transportTimer = setTimeout(fallback, 12000);
  es.onopen = () => { if (epoch === state.transportEpoch) controls(); };
  es.onerror = () => { if (epoch !== state.transportEpoch) return; connection(false, '正在重连'); activity('reconnecting', '连接暂时中断，正在重连；不会自动重发消息。'); if (++state.eventFailures >= 2) fallback(); };
  for (const name of ['rpc', 'approval', 'relay']) es.addEventListener(name, event => {
    if (epoch !== state.transportEpoch) return;
    try { clearTimeout(state.transportTimer); state.transportTimer = null; if (name !== 'relay') state.eventFailures = 0; handleEvent(name, JSON.parse(event.data), event.lastEventId ? Number(event.lastEventId) : undefined); }
    catch { error('收到无法显示的消息，请重新打开会话。'); }
  });
  es.addEventListener('reset', () => { if (epoch === state.transportEpoch) run(() => hydrate(true)); });
}
function hydrate(recover = false) {
  if (state.hydrating) return state.hydrating;
  stopSubscription();
  const work = hydrateSession(recover).finally(() => { state.hydrating = null; if (state.session?.authenticated) { subscribe(); if (state.view === 'home') startOverview(); } });
  state.hydrating = work; return work;
}
async function hydrateSession(recover = false) {
  const loadEpoch = ++state.threadLoadEpoch, baselineCursor = state.eventCursor;
  const priorItems = recover && state.busy ? [...state.items.values()].map(entry => entry.item) : [];
  state.session = await api('/api/session');
  if (state.session.projectView) state.projectView = state.session.projectView;
  if (loadEpoch !== state.threadLoadEpoch) return;
  if (!state.session.authenticated && state.session.capabilities?.deviceAuthentication) { setAuthenticated(false); await authenticateTrustedDevice(); }
  if (state.session.eventTransport === 'poll') state.transportMode = 'poll';
  if (!sharedMode()) state.eventCursor = state.session.eventCursor;
  $('mode-banner').hidden = state.session.mode !== 'mock'; $('examples').hidden = state.session.mode !== 'mock';
  $('server-label').textContent = state.session.mode === 'mock' ? '本地模拟环境' : '服务器现有 Codex';
  setAuthenticated(state.session.authenticated);
  if (!state.session.authenticated) { connection(false, '等待登录'); return; }
  const projects = state.session.projects || []; const oldProject = state.projectId;
  state.projectId = projects.some(x => x.id === oldProject) ? oldProject : projects.some(x => x.id === savedSelection?.projectId) ? savedSelection.projectId : catalogMode() ? null : projects[0]?.id;
  if (catalogMode() && !state.thread && !savedSelection?.threadId && !savedSelection?.view) state.view = 'chat';
  if (sharedMode() && !state.sharedInitialized) { state.sharedInitialized = true; if (state.view === 'home') state.view = 'chat'; }
  renderProjects();
  state.approvals.clear(); for (const a of state.session.pendingApprovals || []) state.approvals.set(a.id, a);
  syncUserInputs(state.session.pendingUserInputs);
  upstream(state.session.upstreamStatus); if (state.upstreamStatus === 'closed') return;
  if (state.thread) { const independent = sharedMode() || state.session.capabilities?.library; const projectId = independent ? null : await restoreThreadProject(state.thread.cwd, activeProjectId()); const result = await api('/api/resume', independent ? { threadId: state.thread.id } : { projectId, threadId: state.thread.id }); if (loadEpoch !== state.threadLoadEpoch) return; if (sharedMode()) await installSharedSnapshot(result, { loadEpoch, preserve: recover, baselineCursor }); else { renderThread(result.thread, result.nextCursor, false, result.thread.projectId || projectId); state.eventCursor = result.eventCursor; } }
  else if (savedSelection?.threadId) { const selection = savedSelection; savedSelection = null; try { const independent = sharedMode() || state.session.capabilities?.library; const projectId = independent ? null : await restoreThreadProject(selection.threadCwd, selection.threadProjectId || selection.projectId); const result = await api('/api/resume', independent ? { threadId: selection.threadId } : { projectId, threadId: selection.threadId }); if (loadEpoch !== state.threadLoadEpoch) return; if (sharedMode()) await installSharedSnapshot(result, { loadEpoch }); else { renderThread(result.thread, result.nextCursor, false, result.thread.projectId || projectId); state.eventCursor = result.eventCursor; } } catch (e) { rememberSelection(); error(e.message); } }
  else if (sharedMode()) state.eventCursor = state.session.eventCursor;
  for (const item of sharedMode() ? [] : priorItems) {
    const current = state.items.get(item.id)?.item;
    if (item.type === 'agentMessage' && (!current || (item.text || '').startsWith(current.text || ''))) appendItem(item);
    if (item.type === 'commandExecution' && (!current || (item.aggregatedOutput || '').startsWith(current.aggregatedOutput || ''))) appendItem(item);
  }
  if (loadEpoch !== state.threadLoadEpoch) return;
  await history();
  const latest = await api('/api/session'); if (loadEpoch !== state.threadLoadEpoch) return; state.session = latest; if (latest.projectView) state.projectView = latest.projectView;
  if (!latest.authenticated) { setAuthenticated(false); connection(false, '等待登录'); scheduleDeviceRecovery(); return; }
  state.deviceAutoAttempted = false; renderDeviceAuth();
  renderProjects(); renderLibrary();
  state.approvals.clear(); for (const a of latest.pendingApprovals || []) state.approvals.set(a.id, a);
  syncUserInputs(latest.pendingUserInputs);
  upstream(latest.upstreamStatus);
  renderApprovals(); renderView(); controls();
  if (runtimePresence.failed) void syncRuntimePresence({ force: true });
}
async function run(fn) { try { await fn(); } catch (e) { error(e.message); } }
$('dismiss-error').addEventListener('click', () => $('error').hidden = true);
$('open-sidebar').addEventListener('click', () => sidebar(true)); $('close-sidebar').addEventListener('click', () => sidebar(false)); $('scrim').addEventListener('click', () => sidebar(false));
$('toggle-projects').addEventListener('click', () => { state.projectsCollapsed = !state.projectsCollapsed; closeProjectMenu(); $('sidebar-projects').hidden = state.projectsCollapsed; $('toggle-projects').setAttribute('aria-expanded', String(!state.projectsCollapsed)); });
$('sidebar-history').addEventListener('scroll', closeProjectMenu);
$('project-menu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('project-menu').querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].filter(button => !button.disabled && !button.closest?.('[hidden]'));
  if (!buttons.length) return; event.preventDefault(); const current = buttons.indexOf(document.activeElement), index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[index].focus();
});
window.addEventListener('resize', () => { if (state.projectMenu) positionProjectMenu(state.projectMenu.anchor); });
for (const id of ['nav-home', 'mobile-home', 'brand-home']) $(id).addEventListener('click', e => { e.preventDefault(); showView(sharedMode() && id === 'brand-home' ? 'chat' : 'home'); sidebar(false); });
$('open-server').addEventListener('click', () => { showView(state.view === 'home' ? 'chat' : 'home'); sidebar(false); });
$('reconnect').addEventListener('click', () => run(async () => { if (state.reconnecting || state.posting) return; state.reconnecting = true; controls(); try { await api('/api/connect', {}); await hydrate(true); } finally { state.reconnecting = false; controls(); } }));
$('thread-state-filter').addEventListener('change', () => { state.threadFilter = $('thread-state-filter').value; renderSidebar(); renderLibrary(); });
$('include-internal').addEventListener('change', () => run(async () => { state.includeInternal = $('include-internal').checked; state.cursor = null; state.pinnedCursor = null; state.recentCursor = null; state.libraryThreads = []; state.recentThreads = []; state.pinnedThreads = []; renderSidebar(); await history(); }));
for (const id of ['nav-chat', 'mobile-chat', 'runtime-library', 'chat-back-library']) $(id).addEventListener('click', () => { if (catalogMode()) openProjectLibrary(null); else { showView('library'); sidebar(false); } });
$('return-chat').addEventListener('click', () => { showView('chat'); sidebar(false); });
$('chat-back-runtime').addEventListener('click', () => showView('home'));
$('join-thread').addEventListener('click', () => run(() => joinThread()));
$('chat-archive').addEventListener('click', () => run(() => previewOperation('archive', state.thread)));
$('operation-back').addEventListener('click', () => { if (state.operation?.busy) return; const prior = state.operation?.priorView || 'home'; state.operation = null; showView(prior); });
$('operation-confirm').addEventListener('click', () => run(confirmOperation));
$('operation-recheck').addEventListener('click', () => run(recheckOperation));
$('operation-repreview').addEventListener('click', () => { if (state.operation) run(() => state.operation.kind.startsWith('project-') ? previewProjectOperation(state.operation.kind, state.operation.target, true) : previewOperation(state.operation.kind, state.operation.target, true)); });
$('include-associated-project-chats').addEventListener('change', () => { if (!state.operation?.kind.startsWith('project-')) return; state.operation.includeAssociated = $('include-associated-project-chats').checked; renderProjectOperation(); });
for (const id of ['refresh-overview', 'retry-overview']) $(id).addEventListener('click', () => void refreshOverview());
$('directory-form').addEventListener('submit', e => { e.preventDefault(); run(() => browseDirectory($('directory-path').value.trim())); });
$('directory-up').addEventListener('click', () => { if (state.directory?.parent) run(() => browseDirectory(state.directory.parent)); });
$('cancel-directory').addEventListener('click', () => { if (state.projectSaving) return; state.directoryEpoch++; showView(state.priorView); });
$('directory-path').addEventListener('input', () => { state.directoryEpoch++; state.directoryLoading = false; state.directory = null; controls(); $('directory-status').textContent = catalogMode() ? '保存时会检查目录；留空使用工作台默认目录。' : '点击「打开」验证此路径后，即可保存。'; });
$('select-directory').addEventListener('click', () => run(saveProject));
$('copy-directory').addEventListener('click', () => run(async () => { if (!state.directory?.cwd) return; try { if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('复制不可用'); await navigator.clipboard.writeText(state.directory.cwd); $('directory-copy-status').textContent = '路径已复制'; } catch { $('directory-copy-status').textContent = '浏览器未允许复制，请选中上方路径手动复制。'; } }));
$('add-project').addEventListener('click', () => run(() => openProjectEditor()));
$('edit-project').addEventListener('click', () => run(() => openProjectEditor(true)));
$('reload-project').addEventListener('click', () => run(reloadProject));
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (state.projectMenu) { const anchor = state.projectMenu.anchor; closeProjectMenu(); anchor?.focus(); return; } if ($('sidebar').classList.contains('open')) sidebar(false); $('model-picker').open = false; $('permissions-picker').open = false; state.contextOpen = false; $('context-meter').classList.toggle('open', false); $('context-toggle').setAttribute('aria-expanded', 'false'); });
$('refresh-history').addEventListener('click', () => run(() => history())); $('older-threads').addEventListener('click', () => catalogMode() ? openProjectLibrary(null) : run(() => history(true)));
$('refresh-library').addEventListener('click', () => run(() => history())); $('library-older').addEventListener('click', () => run(() => history(true)));
$('library-archived').addEventListener('change', () => run(async () => { state.archived = $('library-archived').value === 'true'; await history(); }));
$('older-messages').addEventListener('click', () => run(loadOlderMessages));
$('conversation').addEventListener('wheel', event => { if (event.deltaY < 0) state.userScrollArmed = true; }, { passive: true });
$('conversation').addEventListener('touchstart', event => { state.lastTouchY = event.touches?.[0]?.clientY; }, { passive: true });
$('conversation').addEventListener('touchmove', event => { const y = event.touches?.[0]?.clientY; if (typeof y === 'number' && y > state.lastTouchY) state.userScrollArmed = true; state.lastTouchY = y; }, { passive: true });
$('conversation').addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) state.userScrollArmed = true; });
$('conversation').addEventListener('pointerdown', () => { state.userScrollArmed = true; });
$('conversation').addEventListener('scroll', () => {
  const top = $('conversation').scrollTop, upward = top < state.lastScrollTop; state.lastScrollTop = top;
  if (sharedMode() && state.historyPagingMode === 'items' && state.userScrollArmed && upward && top < 160 && state.view === 'chat') run(loadOlderMessages);
});
$('project').addEventListener('change', () => run(async () => { state.projectId = $('project').value || null; if (catalogMode()) state.draftCwd = projectCwd(selectedProject()); renderProjects(); rememberSelection(); renderView(); if (!catalogMode()) await history(); }));
$('history-scope').addEventListener('change', () => run(async () => { if (catalogMode()) { state.libraryProjectId = $('history-scope').value === 'all' ? null : $('history-scope').value; renderProjects(); await history(); return; } state.historyScope = $('history-scope').value === 'project' ? 'project' : 'all'; renderProjects(); rememberSelection(); await history(); }));
async function createThread({ transferComposer = false } = {}) { const projectId = state.projectId, loadEpoch = state.threadLoadEpoch; const result = await api('/api/threads', catalogMode() ? { cwd: state.draftCwd || $('draft-cwd').value.trim() || defaultCwd(), projectId: projectId || null } : { projectId }); const thread = runtimeThread(result); if (loadEpoch !== state.threadLoadEpoch) return thread; state.pending = null; renderThread(thread, null, true, projectId, { composerTransfer: transferComposer }); if (catalogMode()) await run(() => history()); else await history(); return thread; }
for (const id of ['new-thread', 'top-new-thread', 'welcome-new-thread']) $(id).addEventListener('click', () => run(openNewThread));
$('draft-cwd').addEventListener('input', () => { state.draftCwd = $('draft-cwd').value.trim(); controls(); });
$('sidebar-search-form').addEventListener('submit', e => { e.preventDefault(); state.searchTerm = $('sidebar-search').value.trim(); state.libraryProjectId = null; state.archived = false; showView('library'); sidebar(false); });
$('chat-menu').addEventListener('click', () => { state.chatActionsOpen = !state.chatActionsOpen; renderChatActions(); renderView(); $('chat-menu').setAttribute('aria-expanded', String(state.chatActionsOpen)); });
$('thread-settings-back').addEventListener('click', () => { if (state.metadataSaving) return; const prior = state.threadEdit?.priorView || 'library'; state.threadEdit = null; showView(prior); });
$('thread-settings-form').addEventListener('submit', e => { e.preventDefault(); run(saveThreadSettings); });
$('keep-running').addEventListener('change', () => run(async () => { try { await setKeepRunning(state.thread, $('keep-running').checked); } finally { renderView(); } }));
$('attach-files').addEventListener('click', () => $('attachment-file').click?.());
$('attachment-file').addEventListener('change', event => { const files = Array.from(event.target?.files || $('attachment-file').files || []); $('attachment-file').value = ''; run(() => addAttachments(files)); });
$('composer').addEventListener('dragover', event => { if (state.session?.capabilities?.attachments && event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
$('composer').addEventListener('drop', event => { if (state.session?.capabilities?.attachments && event.dataTransfer?.files?.length) { event.preventDefault(); run(() => addAttachments(event.dataTransfer.files)); } });
$('composer-model-select').addEventListener('change', () => {
  const effort = currentComposerEffort(), selected = $('composer-model-select').value;
  if (selected && !state.models.some(model => model.model === selected)) return;
  state.modelSelection = selected || null; state.effortSelection = null;
  if (selected) { state.modelChoiceRequired = !supportedEfforts().some(option => option.reasoningEffort === effort); if (!state.modelChoiceRequired) state.effortSelection = effort; } else state.modelChoiceRequired = false;
  renderComposer(); controls();
});
function selectComposerEffort() { const option = supportedEfforts()[Number($('composer-effort').value)]; if (option) { state.effortSelection = option.reasoningEffort; state.modelChoiceRequired = false; renderComposer(); controls(); } }
for (const event of ['input', 'change', 'pointerup']) $('composer-effort').addEventListener(event, selectComposerEffort);
$('reset-composer-model').addEventListener('click', () => { state.modelSelection = null; state.effortSelection = null; state.modelChoiceRequired = false; renderComposer(); controls(); void refreshComposerContext(state.thread?.id, { force: true }); });
$('model-picker').addEventListener('toggle', () => { if ($('model-picker').open) { $('permissions-picker').open = false; void loadComposerCatalog(); void refreshComposerContext(state.thread?.id, { force: true }); } });
$('permissions-picker').addEventListener('toggle', () => { if ($('permissions-picker').open) { $('model-picker').open = false; void loadPermissionProfiles(); } });
$('context-toggle').addEventListener('click', () => { state.contextOpen = !state.contextOpen; $('context-meter').classList.toggle('open', state.contextOpen); $('context-toggle').setAttribute('aria-expanded', String(state.contextOpen)); });
document.addEventListener('click', event => { if (!event.target?.closest?.('.project-menu,.project-more')) closeProjectMenu(); if (!event.target?.closest?.('.composer-picker,.context-meter')) { $('model-picker').open = false; $('permissions-picker').open = false; state.contextOpen = false; $('context-meter').classList.toggle('open', false); $('context-toggle').setAttribute('aria-expanded', 'false'); } });
$('prompt').addEventListener('input', () => { controls(); const prompt = $('prompt'); if (prompt.style) { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; } }); $('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } });
$('composer').addEventListener('submit', e => { e.preventDefault(); if (!$('send').disabled) run(sendMessage); });
async function sendMessage() {
  const text = $('prompt').value.trim(), steering = sharedMode() && state.busy, expectedTurnId = state.turnId;
  const attachmentEpoch = state.attachmentEpoch, attachmentIds = state.attachments.filter(attachment => attachment.status === 'ready').map(attachment => attachment.id), overrides = steering ? {} : composerOverrides();
  state.posting = true; activity('sending', steering ? '正在补充消息' : '正在发送', !steering); controls();
  try {
    if (!state.thread) { const created = await createThread({ transferComposer: true }); if (state.thread?.id !== created.id) throw new Error('当前对话已切换，未发送这条消息。'); activity('sending', '正在发送', true); }
    if (attachmentEpoch !== state.attachmentEpoch) throw new Error('当前草稿已切换，未发送这条消息。');
    const fields = { text, threadId: state.thread.id, ...(steering ? { turnId: expectedTurnId } : {}), ...overrides, ...(attachmentIds.length ? { attachmentIds } : {}) }, previous = { ...state.pending }; delete previous.submissionId;
    if (!state.pending || JSON.stringify(previous) !== JSON.stringify(fields)) state.pending = { ...fields, submissionId: submissionId() };
    const submittedThreadId = state.pending.threadId, existingIds = new Set(state.items.keys());
    const result = await api(steering ? '/api/steer' : '/api/turns', { ...(!catalogMode() ? { projectId: activeProjectId() } : {}), ...state.pending });
    const staleRuntime = result.runtime && closedRuntimeEvents.has(result.runtime.runtimeId || result.runtime.id) || result.thread?.runtimes?.some(runtime => closedRuntimeEvents.has(runtime.runtimeId || runtime.id));
    if (catalogMode() && !staleRuntime && result.thread) mergeThread(runtimeThread(result));
    else if (catalogMode() && !staleRuntime && result.runtime && state.thread?.id === submittedThreadId) mergeThread({ ...state.thread, runtimes: [result.runtime] });
    state.pending = null;
    if (state.thread?.id !== submittedThreadId) return;
    if (!steering) { if (result.thread) syncComposerAuthority(result.thread, submittedThreadId); resetComposerChoices(); }
    state.attachments = state.attachments.filter(attachment => !attachmentIds.includes(attachment.id)); state.attachmentNotice = ''; renderAttachments();
    if (result.turn) { acceptTurnItems(result.turn, existingIds); acceptTurnStatus(submittedThreadId, result.turn); }
    else if (steering) activity('thinking', '已补充消息，Codex 继续执行。');
    if ($('prompt').value.trim() === text) { $('prompt').value = ''; if ($('prompt').style) $('prompt').style.height = 'auto'; }
    renderSidebar();
  } catch (failure) {
    if (state.session?.authenticated) activity('failed', '发送结果未确认，输入已保留。先重连并核对对话，再决定是否重试。');
    throw failure;
  } finally {
    state.posting = false;
    if (!state.session?.authenticated || state.upstreamStatus === 'closed') { state.busy = false; state.turnId = null; }
    renderActivity(); controls();
  }
}
$('interrupt').addEventListener('click', () => run(async () => { $('interrupt').disabled = true; await api('/api/interrupt', { threadId: state.thread.id, turnId: state.turnId }); activity('tool', '已请求中断，等待 Codex 确认。'); }));
$('login-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { const field = $('secret'); try { await establishAuthSession(); await api('/api/login', { secret: field.value }); } finally { field.value = ''; } state.deviceError = false; state.deviceStatus = ''; $('error').hidden = true; await hydrate(); }); });
for (const id of ['trust-browser', 'trust-browser-sidebar']) $(id).addEventListener('click', () => run(enrollTrustedDevice));
$('revoke-device').addEventListener('click', () => run(revokeTrustedDevice));
$('show-recovery').addEventListener('click', () => { state.deviceRecovery = true; renderDeviceAuth(); $('secret').focus(); });
$('device-retry').addEventListener('click', () => run(async () => { state.deviceSuppressed = false; state.deviceAutoAttempted = false; await hydrate(true); }));
$('logout').addEventListener('click', () => run(async () => { await releaseRuntimePresence(); stopSubscription(); if (state.session?.capabilities?.deviceAuthentication) state.deviceSuppressed = true; await api('/api/logout', {}); state.thread = null; state.threadProjectId = null; state.pending = null; savedSelection = null; rememberSelection(); state.approvals.clear(); clearMessages(); await hydrate(); }));
for (const button of $('examples').querySelectorAll('button')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; controls(); $('prompt').focus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { void syncRuntimePresence(); stopSubscription(); stopOverview(); stopProjectRefresh(); closeProjectMenu(); }
  else if (state.session?.authenticated) {
    if (state.posting) { subscribe(); void syncRuntimePresence({ force: true }); }
    else run(() => hydrate(true));
    if (state.view === 'home') startOverview();
  }
});
window.addEventListener('pagehide', () => { runtimePresence.pageLeaving = true; void syncRuntimePresence(); stopSubscription(); stopOverview(); stopProjectRefresh(); });
window.addEventListener('pageshow', () => { runtimePresence.pageLeaving = false; void syncRuntimePresence({ force: true }); });
if (window.visualViewport) { const updateViewport = () => { const height = Math.round(window.visualViewport.height); document.documentElement.style.setProperty('--viewport-height', `${height}px`); document.querySelector('.workspace').classList.toggle('keyboard-open', window.innerHeight - height > 150); }; window.visualViewport.addEventListener('resize', updateViewport); updateViewport(); }
run(() => hydrate());
