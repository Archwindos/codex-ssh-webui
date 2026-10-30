const $ = (id) => document.getElementById(id);
const state = { session: null, projectId: null, threadProjectId: null, thread: null, turnId: null, terminalTurns: new Set(), events: null, eventCursor: null, upstreamStatus: 'idle', transportMode: 'sse', transportEpoch: 0, transportTimer: null, pollAbort: null, eventFailures: 0, hydrating: null, approvals: new Map(), items: new Map(), cursor: null, historyScope: 'all', historyEpoch: 0, historyCursor: null, busy: false, posting: false, connected: false, pending: null, view: 'home', priorView: 'home', directory: null, directoryEpoch: 0, directoryLoading: false, projectEdit: null, projectSaving: false, projectConflict: false, overviewTimer: null, overviewRequest: null, overviewEpoch: 0, overview: null, activityPhase: 'idle', activitySince: null, activityTimer: null, activityMessage: '准备好后，发送你的任务。' };
Object.assign(state, { libraryThreads: [], archived: false, joining: false, operation: null, archiveFreezes: new Map() });
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
let savedSelection;
try { savedSelection = JSON.parse(sessionStorage.getItem('relay-selection') || 'null'); } catch { /* Unavailable storage does not block the workspace. */ }
if (['chat', 'library'].includes(savedSelection?.view)) state.view = savedSelection.view;
if (savedSelection?.historyScope === 'project') state.historyScope = 'project';
function rememberSelection() { try { sessionStorage.setItem('relay-selection', JSON.stringify({ projectId: state.projectId, threadId: state.thread?.id, threadProjectId: state.threadProjectId, threadCwd: state.thread?.cwd, historyScope: state.historyScope, view: state.view === 'directory' ? state.priorView : state.view === 'operation' ? state.operation?.priorView : state.view })); } catch { /* No secrets or message content are stored. */ } }
const labels = { completed: '已完成', interrupted: '已中断', failed: '执行失败', inProgress: '正在执行' };

function error(message) { $('error-text').textContent = message; $('error').hidden = false; }
async function api(path, data, signal) {
  const requestToken = sessionToken;
  const authenticationAttempt = ['/api/login', '/api/device/challenge', '/api/device/verify'].includes(path);
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: requestCredentials(), headers: { ...authHeaders(), ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session?.csrf || '' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(signal ? { signal } : {}) });
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
function managedRuntime(thread = state.thread) { return thread?.runtimes?.find(runtime => runtime.managed && runtime.status !== 'closed'); }
function archiveFrozen(thread = state.thread) { return !!thread && (!!thread.archiveFrozen || !!thread.freezeRetained || [...state.archiveFreezes.values()].some(ids => ids.has(thread.id)) || (state.session?.pendingArchiveOperations || []).some(operation => operation.freezeRetained && operation.threadId === thread.id)); }
function admissionText(thread = state.thread) { return thread?.archived ? '此对话已归档，可阅读历史。' : archiveFrozen(thread) ? '上次归档结果待核验，此对话暂不能加入运行区或发送消息。请在对话库核验结果。' : thread?.unavailable ? '原文件夹不可用，可阅读历史；暂不能加入运行区。' : thread?.runtimes?.some(runtime => !runtime.managed) || thread?.readOnly ? '此对话正在原终端中运行，只读。关闭原 Codex 终端后，可加入运行区继续。' : '正在查看历史。加入运行区后，可在独立的运行环境中继续此对话。'; }
function renderActivity() {
  stopActivityClock();
  if (state.session?.capabilities?.runtimeManagement && state.thread && (state.thread.archived || archiveFrozen() || !managedRuntime())) { $('run-state').dataset.active = 'false'; $('run-state').dataset.phase = 'readonly'; $('run-state-text').textContent = admissionText(); $('run-elapsed').textContent = ''; return; }
  if (state.thread?.readOnly && state.session?.authenticated && state.upstreamStatus !== 'closed') { $('run-state').dataset.phase = 'readonly'; $('run-state').dataset.active = 'false'; $('run-state-text').textContent = '此会话仍在原 Codex 客户端中打开。请先关闭原客户端，再重新打开会话。'; $('run-elapsed').textContent = ''; return; }
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
  if (status === 'closed') { stopSubscription(); stopOverview(); state.busy = false; state.turnId = null; state.approvals.clear(); renderApprovals(); activity('closed', '连接已关闭；请重启 relay。不会自动重发消息。'); }
}
function controls() {
  const ready = !!state.session?.authenticated && state.connected;
  const readOnly = !!state.thread?.readOnly || !!state.thread?.archived || archiveFrozen() || !!(state.thread && state.session?.capabilities?.runtimeManagement && (!managedRuntime() || state.thread.unavailable));
  $('prompt').disabled = !ready || readOnly;
  $('send').disabled = !ready || readOnly || state.posting || state.busy || !$('prompt').value.trim();
  for (const id of ['new-thread', 'top-new-thread', 'welcome-new-thread']) $(id).disabled = !ready || state.posting || !!state.operation?.busy || (state.busy && !state.session?.capabilities?.runtimeManagement) || state.projectSaving;
  $('join-thread').disabled = !ready || state.joining || state.posting || !!state.thread?.archived || !!state.thread?.unavailable || archiveFrozen();
  $('join-thread').textContent = state.joining ? '正在加入…' : '加入运行区';
  $('project').disabled = !ready || !state.session?.projects?.length;
  $('add-project').disabled = !ready || state.projectSaving;
  $('edit-project').disabled = !ready || state.projectSaving || !selectedProject();
  $('cancel-directory').disabled = state.projectSaving;
  $('project-name').disabled = state.projectSaving;
  $('directory-path').disabled = state.projectSaving;
  $('browse-directory').disabled = state.projectSaving;
  $('select-directory').disabled = state.projectSaving || state.directoryLoading || !state.directory || state.projectConflict;
  if (!state.thread && state.session?.capabilities?.workspaceBrowser && (!state.session?.capabilities?.runtimeManagement || !selectedProject())) { $('prompt').disabled = true; $('send').disabled = true; }
  $('interrupt').hidden = !state.busy || readOnly;
  $('interrupt').disabled = !ready || readOnly || !state.turnId;
  renderActivity();
}
function setAuthenticated(value) {
  if (state.session) state.session.authenticated = value;
  $('login').hidden = value;
  $('logout').hidden = !value || state.session?.mode === 'mock';
  if (!value) { stopSubscription(); stopOverview(); state.busy = false; state.turnId = null; activity('idle', '登录后继续会话。'); $('approvals').hidden = true; }
  renderView();
  renderDeviceAuth();
  controls();
}
function renderView() {
  const authenticated = !!state.session?.authenticated;
  $('home-view').hidden = !authenticated || state.view !== 'home';
  $('library-view').hidden = !authenticated || state.view !== 'library';
  $('operation-view').hidden = !authenticated || state.view !== 'operation';
  $('directory-view').hidden = !authenticated || state.view !== 'directory';
  $('conversation').hidden = !authenticated || state.view !== 'chat';
  $('composer-area').hidden = !authenticated || state.view !== 'chat';
  $('mobile-tabs').hidden = !authenticated || ['directory', 'operation'].includes(state.view);
  $('thread-title').textContent = state.view === 'home' ? '运行区' : state.view === 'library' ? '对话库' : state.view === 'operation' ? '操作确认与结果' : state.view === 'directory' ? state.projectEdit ? '编辑工作项目' : '新增工作项目' : state.thread?.name || state.thread?.preview || '新会话';
  for (const [id, view] of [['nav-home', 'home'], ['nav-chat', 'library'], ['mobile-home', 'home'], ['mobile-chat', 'library']]) { $(id).classList.toggle('active', state.view === view); $(id).setAttribute('aria-current', state.view === view ? 'page' : 'false'); }
  $('runtime-help').hidden = !state.session?.capabilities?.runtimeManagement;
  $('thread-admission').hidden = !authenticated || state.view !== 'chat' || !state.thread || !state.session?.capabilities?.runtimeManagement || (!!managedRuntime() && !state.thread.archived && !state.thread.readOnly && !state.thread.unavailable && !archiveFrozen());
  $('thread-admission-text').textContent = admissionText(); $('join-thread').hidden = !!state.thread?.archived;
  $('chat-archive').hidden = !state.session?.capabilities?.archiveManagement || !state.thread || !!state.thread.archived;
  const cwd = state.thread?.cwd || selectedProject()?.cwd || '';
  $('chat-project-path').textContent = cwd; $('chat-project').hidden = !cwd;
  $('welcome-project').textContent = state.thread ? (cwd || '会话已就绪，发送你的任务。') : selectedProject() ? `新会话将使用「${selectedProject().name}」：${cwd}` : '先新增工作项目，选择服务器上的文件夹。';
  $('welcome-new-thread').textContent = selectedProject() ? '新建会话' : '新增工作项目';
  $('composer-note').textContent = state.session?.capabilities?.runtimeManagement && !state.thread ? '发送首条任务后创建会话；空白草稿不保存到 Codex 历史。' : '需要权限时，由你确认后继续。';
  $('welcome-new-thread').hidden = !!state.thread || !state.session?.capabilities?.workspaceBrowser || (!!state.session?.capabilities?.runtimeManagement && !!selectedProject());
  $('return-chat').hidden = !state.thread;
  $('return-chat-title').textContent = state.thread?.name || state.thread?.preview || '上次会话';
  $('approvals').hidden = state.view !== 'chat' || !$('approvals').children.length;
}
function showView(view) { if (state.view === 'operation' && state.operation?.busy && view !== 'operation') return; state.view = view; rememberSelection(); renderView(); if (view === 'home') startOverview(); else stopOverview(); if (view === 'chat') renderActivity(); if (view === 'library') run(() => history()); }
function sidebar(open) { $('sidebar').classList.toggle('open', open); $('scrim').hidden = !open; $('open-sidebar').setAttribute('aria-expanded', String(open)); if (open) $('close-sidebar').focus(); else $('open-sidebar').focus(); }
const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => finite(value) && value >= 0 && value <= 100 ? `${Math.round(value)}%` : '暂不可用';
const usage = value => finite(value) && value >= 0 && value <= 100 ? value : null;
const ratio = (used, total) => finite(used) && finite(total) && total > 0 && used >= 0 && used <= total ? used / total * 100 : null;
function bytes(value) { if (!finite(value) || value < 0) return '未知'; if (value < 1024) return `${Math.round(value)} B`; const unit = value >= 1024 ** 4 ? 'TB' : value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : 'KB'; const divisor = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024 }[unit]; return `${Number((value / divisor).toFixed(1))} ${unit}`; }
function statusType(status) { return typeof status === 'string' ? status : status?.type || 'unknown'; }
function threadProject(thread) { return thread.projectId || state.session?.projects?.find(p => p.cwd === thread.cwd)?.id || (!state.session?.capabilities?.allThreads ? state.projectId : null); }
function selectedProject() { return state.session?.projects?.find(p => p.id === state.projectId); }
function activeProjectId() { return state.threadProjectId || threadProject(state.thread || {}) || state.projectId; }
async function restoreThreadProject(cwd, fallbackId) {
  if (!cwd) return fallbackId;
  const existing = state.session.projects.find(p => p.cwd === cwd); if (existing) return existing.id;
  const result = await api(`/api/projects?cwd=${encodeURIComponent(cwd)}`);
  state.session.projects = [...new Map([...state.session.projects, ...result.projects, result.project].map(project => [project.id, project])).values()];
  renderProjects();
  return result.project.id;
}
function renderProjects() {
  const projects = state.session?.projects || [];
  if (!projects.some(p => p.id === state.projectId)) state.projectId = projects[0]?.id || null;
  $('project').replaceChildren();
  for (const project of projects) { const option = document.createElement('option'); option.value = project.id; option.textContent = project.name; $('project').append(option); }
  if (!projects.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '尚无工作项目'; $('project').append(option); }
  $('project').value = state.projectId || ''; $('project-field').hidden = false;
  $('project-path').textContent = selectedProject()?.cwd || '新增项目后，可直接新建会话。';
  $('project-path').setAttribute('title', selectedProject()?.cwd || '');
  $('project-management').hidden = !state.session?.capabilities?.projectManagement;
  $('history-filter').hidden = !state.session?.capabilities?.allThreads;
  $('sidebar-history').hidden = !!state.session?.capabilities?.library;
  $('archive-filter').hidden = !state.session?.capabilities?.library;
  $('history-scope').value = state.historyScope;
  $('history-title').textContent = state.session?.capabilities?.allThreads && state.historyScope === 'all' ? '全部会话' : '会话历史';
  controls();
}
async function openThread(thread) {
  if (state.session?.capabilities?.library) {
    const result = await api('/api/resume', { threadId: thread.threadId || thread.id });
    renderThread({ ...thread, ...result.thread, runtimes: result.thread.runtimes || thread.runtimes || [] }, result.nextCursor, true, result.thread.projectId || state.session.projects.find(project => project.cwd === result.thread.cwd)?.id); sidebar(false); return;
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
  const context = document.createElement('span'); context.textContent = detail; line.append(strong, context); reading.append(line);
  for (const [index, amount] of meters.entries()) {
    const track = document.createElement('div'); track.className = `resource-meter${index ? ' memory-meter' : ''}`; track.setAttribute('aria-hidden', 'true'); track.dataset.known = String(finite(amount));
    if (finite(amount)) { const fill = document.createElement('span'); fill.style?.setProperty('--usage', `${Math.max(0, Math.min(100, amount))}%`); fill.dataset.percent = String(amount); track.append(fill); }
    reading.append(track);
  }
  row.append(name, reading); return row;
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
  const agents = allAgents.filter(agent => runtimeMode ? agent.tmuxState === 'attached' && (agent.runtimeId || agent.threadId) : agent.status === 'working' && typeof agent.threadId === 'string' && agent.threadId.trim()).sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
  const incomplete = value.coverage?.externalComplete === false || allAgents.some(agent => agent.status === 'unknown');
  $('agent-summary').hidden = !agents.length && !incomplete;
  $('agent-summary').textContent = [agents.length ? runtimeMode ? `${agents.length} 个运行环境 · ${agents.filter(agent => agent.status === 'working').length} 个正在工作` : `${agents.length} 个对话正在运行` : '', incomplete ? '部分会话状态暂不可确认' : ''].filter(Boolean).join(' · ');
  $('agents').replaceChildren();
  if (!agents.length) { const empty = document.createElement('p'); empty.className = 'empty-agents'; empty.textContent = runtimeMode ? '暂无 Codex 运行环境。可从对话库加入，或新建会话。' : incomplete ? '暂未发现正在工作的对话。' : '暂无正在工作的对话。'; $('agents').append(empty); }
  for (const agent of agents) {
    if (runtimeMode) {
      const row = document.createElement('article'); row.className = 'working-card runtime-card'; row.dataset.threadId = agent.threadId || ''; row.dataset.runtimeId = agent.runtimeId; row.dataset.status = agent.status;
      const heading = document.createElement('div'); heading.className = 'working-card-heading';
      const title = document.createElement('strong'); title.className = 'working-name'; title.textContent = agent.name || 'Codex 运行环境';
      const status = document.createElement('span'); status.className = 'working-state'; status.textContent = runtimeLabels[agent.status] || runtimeLabels.unknown; heading.append(title, status);
      const path = document.createElement('p'); path.className = 'runtime-path'; path.textContent = agent.cwd || '文件夹未知';
      const foot = document.createElement('div'); foot.className = 'working-card-foot'; const tmux = document.createElement('span'); tmux.className = 'working-tmux'; tmux.textContent = `${tmuxLabel(agent)} · ${agent.managed ? '网页运行' : '终端运行 / 只读'}`; foot.append(tmux);
      const actions = document.createElement('div'); actions.className = 'runtime-actions';
      if (agent.canOpen && agent.threadId) actions.append(actionButton('打开对话', () => openThread(agent), 'text-button'));
      if (agent.runtimeId) actions.append(actionButton('关闭运行环境', () => previewOperation('close', agent), 'text-button close-runtime'));
      row.append(heading, path, foot, actions); $('agents').append(row); continue;
    }
    const row = document.createElement(agent.canOpen ? 'button' : 'div'); row.className = 'working-card'; row.dataset.threadId = agent.threadId;
    const heading = document.createElement('div'); heading.className = 'working-card-heading';
    const title = document.createElement('strong'); title.className = 'working-name'; title.textContent = agent.name || '未命名会话'; title.setAttribute('title', title.textContent);
    const status = document.createElement('span'); status.className = 'working-state'; status.textContent = '运行中'; heading.append(title, status);
    const project = document.createElement('p'); project.className = 'working-project'; project.textContent = state.session?.projects?.find(p => p.id === agent.projectId)?.name || agent.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '项目未知'; project.setAttribute('title', agent.cwd || '');
    const foot = document.createElement('div'); foot.className = 'working-card-foot'; const tmux = document.createElement('span'); tmux.className = 'working-tmux'; tmux.textContent = tmuxLabel(agent); foot.append(tmux);
    if (agent.canOpen) { const open = document.createElement('span'); open.className = 'working-open'; open.textContent = '查看会话'; foot.append(open); row.setAttribute('aria-label', `${title.textContent}，${project.textContent}，运行中，${tmux.textContent}`); row.addEventListener('click', () => run(() => openThread(agent))); }
    row.append(heading, project, foot);
    $('agents').append(row);
  }
  const metrics = value.metrics || {}, cpu = metrics.cpu || {}, memory = metrics.memory || {};
  $('resource-list').replaceChildren(resourceRow('CPU', percent(cpu.percent), '', [usage(cpu.percent)]), resourceRow('内存', ratio(memory.usedBytes, memory.totalBytes) !== null ? `${bytes(memory.usedBytes)} / ${bytes(memory.totalBytes)}` : '暂不可用', '', [ratio(memory.usedBytes, memory.totalBytes)]));
  const gpus = metrics.gpus || [];
  if (!gpus.length) $('resource-list').append(resourceRow('GPU', '暂不可用'));
  for (const [index, gpu] of gpus.entries()) $('resource-list').append(resourceRow(gpus.length > 1 ? `GPU ${gpu.index ?? index}` : 'GPU', percent(gpu.utilizationPercent), ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes) !== null ? `显存 ${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}` : '显存未知', [usage(gpu.utilizationPercent), ratio(gpu.memoryUsedBytes, gpu.memoryTotalBytes)]));
  const storage = metrics.storage || [];
  if (!storage.length) $('resource-list').append(resourceRow('储存', '暂不可用'));
  for (const disk of storage) { const used = finite(disk.usedBytes) ? disk.usedBytes : finite(disk.totalBytes) && finite(disk.availableBytes) ? disk.totalBytes - disk.availableBytes : null; $('resource-list').append(resourceRow(disk.path || '储存', ratio(used, disk.totalBytes) !== null ? `${bytes(used)} / ${bytes(disk.totalBytes)}` : '暂不可用', finite(disk.availableBytes) && disk.availableBytes >= 0 ? `${bytes(disk.availableBytes)} 可用` : '可用空间未知', [ratio(used, disk.totalBytes)])); }
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
    $('directory-status').textContent = directory.entries?.length ? directory.limited ? '仅显示部分文件夹，可输入完整路径打开。' : '选择子文件夹，或将当前文件夹绑定到项目。' : '这个文件夹没有可浏览的子文件夹，可直接绑定。';
  } catch (failure) { if (epoch === state.directoryEpoch) { $('directory-status').textContent = `${failure.message} 请检查路径后重试。`; } }
  finally { if (epoch === state.directoryEpoch) { state.directoryLoading = false; controls(); } }
}
async function openProjectEditor(edit = false) {
  if (state.projectSaving || !state.session?.capabilities?.projectManagement) return;
  const project = edit ? selectedProject() : null; if (edit && !project) return;
  state.projectEdit = project ? { ...project } : null; state.projectConflict = false;
  $('project-save-error').hidden = true; $('reload-project').hidden = true;
  $('project-name').value = project?.name || '';
  $('project-name').placeholder = project ? '输入项目名称' : '留空使用文件夹名称';
  $('directory-title').textContent = project ? '编辑工作项目' : '新增工作项目';
  $('directory-help').textContent = project ? '名称和绑定文件夹用于之后的新会话；已有会话继续使用原文件夹。' : '保存后，新会话直接使用此文件夹。';
  $('select-directory').textContent = '保存项目';
  state.priorView = state.view === 'directory' ? state.priorView : state.view;
  sidebar(false); showView('directory');
  await browseDirectory(project?.cwd || selectedProject()?.cwd || state.session?.workspace?.defaultCwd);
}
async function saveProject() {
  if (!state.directory || state.directoryLoading || state.projectSaving || state.projectConflict) return;
  const data = { cwd: state.directory.cwd }, name = $('project-name').value.trim(); if (name) data.name = name;
  if (state.projectEdit && !name) { $('project-save-error-text').textContent = '请输入项目名称后保存。'; $('project-save-error').hidden = false; $('project-name').focus(); return; }
  if (state.projectEdit) Object.assign(data, { projectId: state.projectEdit.id, revision: state.projectEdit.revision });
  state.projectSaving = true; $('project-save-error').hidden = true; $('select-directory').textContent = '正在保存…'; controls();
  try {
    const result = await api(state.projectEdit ? '/api/projects/update' : '/api/projects', data);
    state.session.projects = result.projects || [...state.session.projects.filter(p => p.id !== result.project.id), result.project];
    if (state.thread?.cwd && result.previousProject?.cwd === state.thread.cwd) state.threadProjectId = result.previousProject.id;
    else if (state.thread?.cwd) state.threadProjectId = state.session.projects.find(p => p.cwd === state.thread.cwd)?.id || state.threadProjectId;
    state.projectId = result.project.id; renderProjects(); rememberSelection();
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
  $('project-save-error').hidden = true; $('reload-project').hidden = true; await browseDirectory(project.cwd);
}
async function openNewThread() {
  if (state.posting || state.operation?.busy || (state.busy && !state.session?.capabilities?.runtimeManagement) || state.projectSaving) return;
  if (!selectedProject() && state.session?.capabilities?.projectManagement) return openProjectEditor();
  if (state.session?.capabilities?.runtimeManagement) {
    state.thread = null; state.threadProjectId = null; state.pending = null; state.historyCursor = null; state.busy = false; state.turnId = null;
    clearMessages(); $('older-messages').hidden = true; $('welcome').hidden = false; $('prompt').value = '';
    sidebar(false); showView('chat'); activity('idle', '发送第一条任务时创建独立运行环境并保存对话。'); controls(); $('prompt').focus(); return;
  }
  sidebar(false); state.posting = true; controls();
  try { await createThread(); $('prompt').focus(); } finally { state.posting = false; controls(); renderActivity(); }
}
function nearBottom() { const c = $('conversation'); return c.scrollHeight - c.scrollTop - c.clientHeight < 100; }
function scroll(force = false) { if (force || nearBottom()) $('conversation').scrollTop = $('conversation').scrollHeight; }
function clearMessages() { $('messages').replaceChildren(); state.items.clear(); }
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
function appendItem(item) {
  if (!item?.id) return;
  const prior = state.items.get(item.id);
  const follow = nearBottom();
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
  state.items.set(item.id, { node, body, text, item }); $('welcome').hidden = true;
  if (follow) scroll(true);
}
function renderThread(thread, historyCursor = null, activate = true, projectId = null) {
  state.threadProjectId = projectId || thread.projectId || state.session?.projects?.find(p => p.cwd === thread.cwd)?.id || (state.session?.capabilities?.library ? null : state.threadProjectId || state.projectId);
  state.thread = thread; state.turnId = null; state.busy = statusType(thread.status) === 'active' || thread.runtimes?.some(runtime => runtime.status === 'working') || false; clearMessages();
  state.historyCursor = historyCursor; $('older-messages').hidden = !historyCursor;
  rememberSelection();
  $('thread-title').textContent = thread.name || thread.preview || '新的会话';
  for (const turn of thread.turns || []) { for (const item of turn.items || []) appendItem(item); if (turn.status === 'inProgress') { state.turnId = turn.id; state.busy = true; } }
  $('welcome').hidden = state.items.size > 0;
  activity(state.busy ? 'thinking' : 'idle', state.busy ? 'Codex 正在思考' : '会话已就绪。');
  for (const button of $('threads').querySelectorAll('button')) button.classList.toggle('active', button.dataset.threadId === thread.id);
  renderApprovals(); if (activate) showView('chat'); else renderView(); controls(); scroll(true);
}
async function history(append = false) {
  const all = state.session?.capabilities?.allThreads && state.historyScope === 'all';
  if (!state.projectId && !all) return;
  const epoch = append ? state.historyEpoch : ++state.historyEpoch;
  $('library-status').textContent = '正在读取对话…'; $('refresh-library').disabled = true;
  let result;
  try { result = await api(`/api/threads?project=${all ? 'all' : encodeURIComponent(state.projectId)}${state.session?.capabilities?.library ? `&archived=${state.archived}` : ''}${append && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ''}`); }
  catch (failure) { if (epoch === state.historyEpoch) $('library-status').textContent = '读取失败，当前列表保留。可点击刷新重试。'; throw failure; }
  finally { if (epoch === state.historyEpoch) $('refresh-library').disabled = false; }
  if (epoch !== state.historyEpoch) return;
  state.libraryThreads = append ? [...state.libraryThreads, ...(result.data || [])] : result.data || [];
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
  $('library-status').textContent = state.libraryThreads.length ? `已显示 ${state.libraryThreads.length} 个${state.archived ? '已归档' : ''}对话` : state.archived ? '暂无已归档对话。' : '暂无对话。选择工作项目后，可新建会话。';
  for (const thread of state.libraryThreads) {
    const row = document.createElement('article'); row.className = 'library-row'; row.dataset.threadId = thread.id;
    const content = document.createElement('div'); content.className = 'library-thread';
    const title = document.createElement('h3'); title.textContent = thread.name || thread.preview || '未命名对话';
    const path = document.createElement('p'); path.className = 'runtime-path'; path.textContent = thread.cwd || '文件夹未知';
    const meta = document.createElement('p'); meta.className = 'library-meta';
    const runtimes = thread.runtimes || [], managed = managedRuntime(thread);
    meta.textContent = [thread.archived ? '已归档' : archiveFrozen(thread) ? '归档结果待核验' : managed ? runtimeLabels[managed.status] || '网页运行' : runtimes.length ? '终端运行 / 只读' : '历史对话', thread.parentThreadId ? `子对话 · 上级 ${thread.parentThreadId}` : '', thread.unavailable ? '文件夹不可用' : ''].filter(Boolean).join(' · ');
    content.append(title, path, meta);
    const actions = document.createElement('div'); actions.className = 'library-actions';
    const open = actionButton('查看', () => openThread(thread)); open.disabled = !!thread.unavailable && !state.session?.capabilities?.library; actions.append(open);
    if (state.session?.capabilities?.runtimeManagement && !thread.archived && !managed) { const join = actionButton('加入运行区', () => joinThread(thread)); join.disabled = !!thread.unavailable || state.joining || archiveFrozen(thread); actions.append(join); }
    if (state.session?.capabilities?.archiveManagement && !thread.archived) actions.append(actionButton('归档', () => previewOperation('archive', thread), 'text-button'));
    row.append(content, actions); $('library-list').append(row);
  }
  $('library-older').hidden = !state.cursor;
}
async function joinThread(thread = state.thread) {
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
  const archive = op.kind === 'archive', preview = op.preview, result = op.result;
  $('operation-title').textContent = result ? archive ? '归档结果' : '关闭结果' : archive ? '归档对话' : '关闭运行环境';
  $('operation-description').textContent = result ? archive ? ({ complete: '已完成归档，逐项结果如下。', partial: '归档仅部分完成。请检查每个对话的结果。', failed: '归档未完成。', unknown: '归档结果尚未确认，请重新核验。' }[result.status] || '请检查逐项结果。') : result.status === 'closed' ? '运行环境已关闭，对话保留在对话库。' : '未能确认全部关闭，请检查结果后刷新运行区。' : op.busy ? '正在读取影响范围…' : archive ? '归档会停止相关的网页运行环境，并归档下列对话及子对话。确认前，请逐项检查。' : preview?.scope === 'pane' ? `将关闭 tmux 窗格 ${preview?.pane?.target || ''} 中的运行，其他窗格保留。对话仍在对话库，不会归档。` : `将关闭 tmux 会话 ${preview?.session?.name || preview?.session?.id || ''}，停止其中的执行。对话仍保留，不会归档。`;
  $('operation-details').replaceChildren();
  const statuses = { archived: '已归档', alreadyArchived: '此前已归档', notArchived: '未归档', unknown: '结果未知' };
  if (archive && (result || preview)) {
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
  $('operation-confirm').textContent = op.busy ? '正在处理…' : archive ? `确认归档 ${(preview?.affected || []).length} 个对话` : '确认关闭运行环境';
  $('operation-repreview').hidden = !!result || (!op.needsPreview && !!preview); $('operation-repreview').disabled = op.busy;
  $('operation-recheck').hidden = !archive || !result?.operationId || result.status === 'complete'; $('operation-recheck').disabled = op.busy;
  $('operation-note').textContent = result?.freezeRetained ? '部分结果尚未确认，相关对话暂不能加入运行区。重新核验只读取结果，不会再次归档。' : result && archive && result.status !== 'complete' ? '未归档和未知项不会按成功处理。重新核验只读取结果，不会再次执行归档。' : '';
}
async function confirmOperation() {
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
    for (const thread of state.libraryThreads) if (archived.has(thread.id)) thread.archived = true;
    if (state.thread && archived.has(state.thread.id)) state.thread.archived = true;
  } else if (op.result.status === 'closed') {
    const keep = runtime => runtime.runtimeId !== op.target.runtimeId && (op.preview.scope === 'pane' || !op.preview.session?.id || runtime.tmux?.sessionId !== op.preview.session.id);
    for (const thread of [...state.libraryThreads, ...(state.thread ? [state.thread] : [])]) thread.runtimes = (thread.runtimes || []).filter(keep);
    if (state.thread && !managedRuntime()) { state.busy = false; state.turnId = null; }
  }
  renderLibrary(); renderView(); controls();
}
async function recheckOperation() {
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
  $('approvals').hidden = state.view !== 'chat' || !$('approvals').children.length;
  if ([...state.approvals.values()].some(a => a.params.threadId === state.thread?.id)) activity('approval', '等待你确认操作');
  else if (state.activityPhase === 'approval' && state.busy) activity('thinking', 'Codex 正在继续');
}
function rpc({ method, params: p = {} }) {
  if (method === 'serverRequest/resolved') { state.approvals.delete(p.requestId); renderApprovals(); return; }
  if (p.threadId && p.threadId !== state.thread?.id) return;
  if (method === 'turn/started') { state.busy = true; state.turnId = p.turn.id; activity('thinking', 'Codex 正在思考'); }
  if (method === 'item/started' || method === 'item/completed') { appendItem(p.item); if (state.busy && method === 'item/started') activity(p.item?.type === 'reasoning' ? 'thinking' : p.item?.type === 'agentMessage' ? 'responding' : 'tool', p.item?.type === 'reasoning' ? 'Codex 正在思考' : p.item?.type === 'agentMessage' ? 'Codex 正在回复' : ({ commandExecution: '正在执行命令', fileChange: '正在修改文件', webSearch: '正在检索网页', mcpToolCall: '正在调用工具' })[p.item?.type] || 'Codex 正在执行'); }
  if (method === 'item/agentMessage/delta') { const old = state.items.get(p.itemId); appendItem({ id: p.itemId, type: 'agentMessage', text: (old?.text || '') + p.delta }); if (state.busy) activity('responding', 'Codex 正在回复'); }
  if (['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)) { const old = state.items.get(p.itemId); const key = method.includes('summaryTextDelta') ? 'summary' : 'content'; const segments = [...(old?.item?.[key] || [])]; const index = Math.min(100, Math.max(0, p.summaryIndex ?? p.contentIndex ?? 0)); segments[index] = (typeof segments[index] === 'string' ? segments[index] : segments[index]?.text || '') + (p.delta || ''); appendItem({ ...old?.item, id: p.itemId, type: 'reasoning', [key]: segments }); if (state.busy) activity('thinking', 'Codex 正在思考'); }
  if (method === 'item/plan/delta') { const old = state.items.get(p.itemId); appendItem({ ...old?.item, id: p.itemId, type: 'plan', text: (old?.text || '') + (p.delta || '') }); }
  if (method === 'turn/plan/updated') appendItem({ id: `plan-${p.turnId}`, type: 'plan', text: [p.explanation, ...(p.plan || []).map(step => `${({ pending: '待执行', inProgress: '进行中', completed: '已完成' })[step.status] || '待执行'} · ${step.step}`)].filter(Boolean).join('\n') });
  if (method === 'item/commandExecution/outputDelta') { const old = state.items.get(p.itemId); if (old) appendItem({ ...old.item, aggregatedOutput: (old.item.aggregatedOutput || '') + p.delta }); }
  if (method === 'turn/completed') { rememberTerminalTurn(p.threadId || state.thread?.id, p.turn.id); state.busy = false; state.turnId = null; activity(p.turn.status || 'completed', labels[p.turn.status] || '任务已结束。'); for (const [id, a] of state.approvals) if (a.params.turnId === p.turn.id) state.approvals.delete(id); renderApprovals(); run(() => history()); }
  if (method === 'thread/status/changed' && p.status) { const status = statusType(p.status); if (status === 'active' && !state.busy) { state.busy = true; activity('thinking', 'Codex 正在工作'); } else if (['idle', 'notLoaded', 'systemError'].includes(status) && state.busy && !state.posting) { state.busy = false; state.turnId = null; activity(status === 'systemError' ? 'failed' : 'idle', status === 'systemError' ? '执行状态异常，请查看当前会话。' : '会话已就绪。'); } }
  if (method === 'error') error('服务器上的 Codex 报告执行错误，请检查当前任务。');
  controls();
}
function stopSubscription() {
  stopActivityClock();
  state.transportEpoch++; clearTimeout(state.transportTimer); state.transportTimer = null;
  state.events?.close(); state.events = null; state.pollAbort?.abort(); state.pollAbort = null;
}
function handleEvent(event, data, id) {
  const control = event === 'relay' && ['connected', 'idle', 'closed', 'reset', 'replay-reset', 'resync'].includes(data.status);
  if (!control && Number.isSafeInteger(id) && state.eventCursor !== null && id <= state.eventCursor) return;
  if (Number.isSafeInteger(id)) state.eventCursor = Math.max(state.eventCursor || 0, id);
  if (event === 'rpc') rpc(data);
  if (event === 'approval') { state.approvals.set(data.id, data); renderApprovals(); }
  if (event === 'relay') {
    if (['connected', 'idle'].includes(data.status)) upstream(data.status);
    if (['disconnected', 'error', 'closed'].includes(data.status)) upstream('closed');
    if (data.status === 'approval-resolved') { state.approvals.delete(data.requestId); renderApprovals(); }
    if (data.status === 'runtime-closed') { if (state.thread?.id === data.threadId) { state.thread.runtimes = []; state.busy = false; state.turnId = null; renderActivity(); controls(); } if (state.view === 'home') void refreshOverview(); return; }
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
    state.eventCursor = page.cursor;
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
  const priorItems = recover && state.busy ? [...state.items.values()].map(entry => entry.item) : [];
  state.session = await api('/api/session');
  if (!state.session.authenticated && state.session.capabilities?.deviceAuthentication) { setAuthenticated(false); await authenticateTrustedDevice(); }
  if (state.session.eventTransport === 'poll') state.transportMode = 'poll';
  state.eventCursor = state.session.eventCursor;
  $('mode-banner').hidden = state.session.mode !== 'mock'; $('examples').hidden = state.session.mode !== 'mock';
  $('server-label').textContent = state.session.mode === 'mock' ? '本地模拟环境' : '服务器现有 Codex';
  setAuthenticated(state.session.authenticated);
  if (!state.session.authenticated) { connection(false, '等待登录'); return; }
  const projects = state.session.projects || []; const oldProject = state.projectId;
  state.projectId = projects.some(x => x.id === oldProject) ? oldProject : projects.some(x => x.id === savedSelection?.projectId) ? savedSelection.projectId : projects[0]?.id;
  renderProjects();
  state.approvals.clear(); for (const a of state.session.pendingApprovals || []) state.approvals.set(a.id, a);
  upstream(state.session.upstreamStatus); if (state.upstreamStatus === 'closed') return;
  if (state.thread) { const projectId = state.session.capabilities?.library ? null : await restoreThreadProject(state.thread.cwd, activeProjectId()); const result = await api('/api/resume', state.session.capabilities?.library ? { threadId: state.thread.id } : { projectId, threadId: state.thread.id }); renderThread(result.thread, result.nextCursor, false, result.thread.projectId || projectId); state.eventCursor = result.eventCursor; }
  else if (savedSelection?.threadId) { const selection = savedSelection; savedSelection = null; try { const projectId = state.session.capabilities?.library ? null : await restoreThreadProject(selection.threadCwd, selection.threadProjectId || selection.projectId); const result = await api('/api/resume', state.session.capabilities?.library ? { threadId: selection.threadId } : { projectId, threadId: selection.threadId }); renderThread(result.thread, result.nextCursor, false, result.thread.projectId || projectId); state.eventCursor = result.eventCursor; } catch (e) { rememberSelection(); error(e.message); } }
  for (const item of priorItems) {
    const current = state.items.get(item.id)?.item;
    if (item.type === 'agentMessage' && (!current || (item.text || '').startsWith(current.text || ''))) appendItem(item);
    if (item.type === 'commandExecution' && (!current || (item.aggregatedOutput || '').startsWith(current.aggregatedOutput || ''))) appendItem(item);
  }
  await history();
  const latest = await api('/api/session'); state.session = latest;
  if (!latest.authenticated) { setAuthenticated(false); connection(false, '等待登录'); scheduleDeviceRecovery(); return; }
  state.deviceAutoAttempted = false; renderDeviceAuth();
  renderProjects(); renderLibrary();
  state.approvals.clear(); for (const a of latest.pendingApprovals || []) state.approvals.set(a.id, a);
  upstream(latest.upstreamStatus);
  renderApprovals(); renderView(); controls();
}
async function run(fn) { try { await fn(); } catch (e) { error(e.message); } }
$('dismiss-error').addEventListener('click', () => $('error').hidden = true);
$('open-sidebar').addEventListener('click', () => sidebar(true)); $('close-sidebar').addEventListener('click', () => sidebar(false)); $('scrim').addEventListener('click', () => sidebar(false));
for (const id of ['nav-home', 'mobile-home', 'brand-home']) $(id).addEventListener('click', e => { e.preventDefault(); showView('home'); sidebar(false); });
for (const id of ['nav-chat', 'mobile-chat', 'runtime-library', 'chat-back-library']) $(id).addEventListener('click', () => { showView('library'); sidebar(false); });
$('return-chat').addEventListener('click', () => { showView('chat'); sidebar(false); });
$('chat-back-runtime').addEventListener('click', () => showView('home'));
$('join-thread').addEventListener('click', () => run(() => joinThread()));
$('chat-archive').addEventListener('click', () => run(() => previewOperation('archive', state.thread)));
$('operation-back').addEventListener('click', () => { if (state.operation?.busy) return; const prior = state.operation?.priorView || 'home'; state.operation = null; showView(prior); });
$('operation-confirm').addEventListener('click', () => run(confirmOperation));
$('operation-recheck').addEventListener('click', () => run(recheckOperation));
$('operation-repreview').addEventListener('click', () => { if (state.operation) run(() => previewOperation(state.operation.kind, state.operation.target, true)); });
for (const id of ['refresh-overview', 'retry-overview']) $(id).addEventListener('click', () => void refreshOverview());
$('directory-form').addEventListener('submit', e => { e.preventDefault(); run(() => browseDirectory($('directory-path').value.trim())); });
$('directory-up').addEventListener('click', () => { if (state.directory?.parent) run(() => browseDirectory(state.directory.parent)); });
$('cancel-directory').addEventListener('click', () => { if (state.projectSaving) return; state.directoryEpoch++; showView(state.priorView); });
$('directory-path').addEventListener('input', () => { state.directoryEpoch++; state.directoryLoading = false; state.directory = null; controls(); $('directory-status').textContent = '点击「打开」验证此路径后，即可保存。'; });
$('select-directory').addEventListener('click', () => run(saveProject));
$('add-project').addEventListener('click', () => run(() => openProjectEditor()));
$('edit-project').addEventListener('click', () => run(() => openProjectEditor(true)));
$('reload-project').addEventListener('click', () => run(reloadProject));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('sidebar').classList.contains('open')) sidebar(false); });
$('refresh-history').addEventListener('click', () => run(() => history())); $('older-threads').addEventListener('click', () => run(() => history(true)));
$('refresh-library').addEventListener('click', () => run(() => history())); $('library-older').addEventListener('click', () => run(() => history(true)));
$('library-archived').addEventListener('change', () => run(async () => { state.archived = $('library-archived').value === 'true'; await history(); }));
$('older-messages').addEventListener('click', () => run(async () => { const container = $('conversation'), beforeHeight = container.scrollHeight, beforeTop = container.scrollTop; $('older-messages').disabled = true; try { const page = await api(`/api/history?${state.session?.capabilities?.library ? '' : `project=${encodeURIComponent(activeProjectId())}&`}thread=${encodeURIComponent(state.thread.id)}&cursor=${encodeURIComponent(state.historyCursor)}`); const added = document.createDocumentFragment(); for (const turn of page.turns) for (const item of turn.items || []) { if (state.items.has(item.id)) continue; appendItem(item); const entry = state.items.get(item.id); if (entry) added.append(entry.node); } $('messages').prepend(added); state.historyCursor = page.nextCursor; $('older-messages').hidden = !page.nextCursor; container.scrollTop = beforeTop + container.scrollHeight - beforeHeight; } finally { $('older-messages').disabled = false; } }));
$('project').addEventListener('change', () => run(async () => { state.projectId = $('project').value; renderProjects(); rememberSelection(); renderView(); await history(); }));
$('history-scope').addEventListener('change', () => run(async () => { state.historyScope = $('history-scope').value === 'project' ? 'project' : 'all'; renderProjects(); rememberSelection(); await history(); }));
async function createThread() { const projectId = state.projectId; const result = await api('/api/threads', { projectId }); state.pending = null; const thread = runtimeThread(result); renderThread(thread, null, true, projectId); await history(); return thread; }
for (const id of ['new-thread', 'top-new-thread', 'welcome-new-thread']) $(id).addEventListener('click', () => run(openNewThread));
$('prompt').addEventListener('input', () => { controls(); const prompt = $('prompt'); if (prompt.style) { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; } }); $('prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } });
$('composer').addEventListener('submit', e => { e.preventDefault(); if ($('send').disabled) return; run(async () => { state.posting = true; activity('sending', '正在发送', true); controls(); const text = $('prompt').value.trim(); try { if (!state.thread) { await createThread(); activity('sending', '正在发送', true); } if (!state.pending || state.pending.text !== text || state.pending.threadId !== state.thread.id) state.pending = { text, threadId: state.thread.id, submissionId: submissionId() }; const submittedThreadId = state.pending.threadId, existingIds = new Set(state.items.keys()); const result = await api('/api/turns', { projectId: activeProjectId(), ...state.pending }); acceptTurnItems(result.turn, existingIds); state.pending = null; $('prompt').value = ''; if ($('prompt').style) $('prompt').style.height = 'auto'; acceptTurnStatus(submittedThreadId, result.turn); } catch (failure) { if (state.session?.authenticated) activity('failed', '发送未完成，保留了你的消息。请确认连接后重试。'); throw failure; } finally { state.posting = false; if (!state.session?.authenticated || state.upstreamStatus === 'closed') { state.busy = false; state.turnId = null; } renderActivity(); controls(); } }); });
$('interrupt').addEventListener('click', () => run(async () => { $('interrupt').disabled = true; await api('/api/interrupt', { threadId: state.thread.id, turnId: state.turnId }); activity('tool', '已请求中断，等待 Codex 确认。'); }));
$('login-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { const field = $('secret'); try { await establishAuthSession(); await api('/api/login', { secret: field.value }); } finally { field.value = ''; } state.deviceError = false; state.deviceStatus = ''; $('error').hidden = true; await hydrate(); }); });
for (const id of ['trust-browser', 'trust-browser-sidebar']) $(id).addEventListener('click', () => run(enrollTrustedDevice));
$('revoke-device').addEventListener('click', () => run(revokeTrustedDevice));
$('show-recovery').addEventListener('click', () => { state.deviceRecovery = true; renderDeviceAuth(); $('secret').focus(); });
$('device-retry').addEventListener('click', () => run(async () => { state.deviceSuppressed = false; state.deviceAutoAttempted = false; await hydrate(true); }));
$('logout').addEventListener('click', () => run(async () => { stopSubscription(); if (state.session?.capabilities?.deviceAuthentication) state.deviceSuppressed = true; await api('/api/logout', {}); state.thread = null; state.threadProjectId = null; state.pending = null; savedSelection = null; rememberSelection(); state.approvals.clear(); clearMessages(); await hydrate(); }));
for (const button of $('examples').querySelectorAll('button')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; controls(); $('prompt').focus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { stopSubscription(); stopOverview(); }
  else if (state.session?.authenticated) {
    if (state.posting) subscribe();
    else run(() => hydrate(true));
    if (state.view === 'home') startOverview();
  }
});
window.addEventListener('pagehide', () => { stopSubscription(); stopOverview(); });
if (window.visualViewport) { const updateViewport = () => { const height = Math.round(window.visualViewport.height); document.documentElement.style.setProperty('--viewport-height', `${height}px`); document.querySelector('.workspace').classList.toggle('keyboard-open', window.innerHeight - height > 150); }; window.visualViewport.addEventListener('resize', updateViewport); updateViewport(); }
run(() => hydrate());
