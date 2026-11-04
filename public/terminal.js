// All traffic uses the parent app's authenticated, origin-bound API helper.
export function installTerminal({ api, button, parent = document.body } = {}) {
  if (typeof api !== 'function' || !button) throw new TypeError('Terminal requires api and button');
  let authenticated = false, enabled = false, current = null, epoch = 0, opening = false, disposed = false;
  let vendorPromise;
  const styles = ['/vendor/xterm.css', '/terminal.css'];
  for (const href of styles) if (!document.querySelector(`link[href="${href}"]`)) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.append(link);
  }
  const loadVendor = () => vendorPromise ??= Promise.all([import('/vendor/xterm.js'), import('/vendor/xterm-addon-fit.js')]);
  const styleNonce = document.querySelector('meta[name="terminal-style-nonce"]')?.content || '';
  const nativeCreateElement = document.createElement.bind(document);
  const createTerminalElement = (tag, options) => {
    const element = nativeCreateElement(tag, options);
    if (styleNonce && String(tag).toLowerCase() === 'style') element.nonce = styleNonce;
    return element;
  };
  // Give xterm's renderer a document that only adds our server-issued CSP nonce
  // to its own style elements. Other document methods keep their native receiver.
  const terminalDocument = styleNonce ? new Proxy(document, { get(target, key) {
    if (key === 'createElement') return createTerminalElement;
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } }) : document;
  const encode = bytes => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
  const decode = text => Uint8Array.from(atob(text), value => value.charCodeAt(0));
  const makeButton = (label, handler, className = '') => {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    if (className) element.className = className; element.addEventListener('click', handler); return element;
  };
  const isCurrent = session => current === session && !session.closed;
  const updateButton = () => { button.hidden = !authenticated || !enabled; button.disabled = opening; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', String(Boolean(current))); };
  const status = (session, message, error = false) => { if (!isCurrent(session)) return; session.status.textContent = message; session.status.classList.toggle('is-error', error); };
  const pauseInput = (session, message) => {
    session.inputPaused = true; session.queue = []; session.queuedBytes = 0;
    session.term.options.disableStdin = true; session.resume.hidden = false; status(session, message, true);
  };
  async function sendQueued(session) {
    if (session.sending || session.inputPaused) return;
    session.sending = true;
    try {
      while (isCurrent(session) && session.id && session.queue.length && !session.inputPaused) {
        const bytes = session.queue.shift(); session.queuedBytes -= bytes.length;
        try { await api(`/api/terminal/${session.id}/input`, { data: encode(bytes) }); }
        catch { if (isCurrent(session)) pauseInput(session, '输入发送未确认，未自动重发。核对屏幕后可继续输入。'); }
      }
    } finally { session.sending = false; }
  }
  function input(session, bytes) {
    if (!isCurrent(session) || !session.id || session.inputPaused || session.ended) return;
    if (session.queuedBytes + bytes.length > 65536) { pauseInput(session, '输入过长，剩余输入未发送。核对屏幕后可继续输入。'); return; }
    for (let offset = 0; offset < bytes.length; offset += 16384) session.queue.push(bytes.slice(offset, offset + 16384));
    session.queuedBytes += bytes.length; void sendQueued(session);
  }
  async function poll(session) {
    let failures = 0;
    while (isCurrent(session) && session.id && !session.ended) {
      const abort = new AbortController(); session.pollAbort = abort;
      try {
        const page = await api(`/api/terminal/${session.id}?cursor=${session.cursor}`, undefined, abort.signal);
        if (!isCurrent(session)) return;
        if (page.reset) { session.term.reset(); session.term.writeln('\x1b[33m较早的输出已超出临时缓存。\x1b[0m'); }
        if (page.data) await new Promise(resolve => session.term.write(decode(page.data), resolve));
        if (!isCurrent(session)) return;
        session.cursor = page.cursor; failures = 0;
        if (!session.inputPaused) status(session, '已连接 · 当前服务器用户 · 起始目录 /');
        if (page.closed && !page.hasMore) {
          session.ended = true; session.term.options.disableStdin = true; clearInterval(session.heartbeat);
          session.resume.hidden = true;
          status(session, page.reason === 'lease_expired' ? '连接已过期，临时终端已关闭。' : `临时终端已关闭${page.exitCode !== null ? `（退出码 ${page.exitCode}）` : ''}。`);
          return;
        }
      } catch (error) {
        if (!isCurrent(session) || abort.signal.aborted) return;
        if ([401, 403, 404].includes(error.status)) { session.ended = true; session.term.options.disableStdin = true; clearInterval(session.heartbeat); status(session, error.message || '终端连接已失效。', true); return; }
        status(session, '连接中断，正在恢复输出…', true);
        await new Promise(resolve => { session.retryResolve = resolve; session.retry = setTimeout(resolve, Math.min(5000, 600 * 2 ** failures++)); });
        session.retryResolve = null;
      }
    }
  }
  async function resize(session) {
    if (!isCurrent(session) || !session.term || session.ended) return;
    session.fit.fit();
    const cols = Math.min(500, Math.max(10, session.term.cols)), rows = Math.min(200, Math.max(2, session.term.rows));
    if (!session.id || (session.cols === cols && session.rows === rows)) return;
    session.cols = cols; session.rows = rows;
    try { await api(`/api/terminal/${session.id}/resize`, { cols, rows }); }
    catch (error) { if (isCurrent(session)) status(session, error.message || '终端尺寸未能同步。', true); }
  }
  async function close({ restoreFocus = true } = {}) {
    epoch++;
    const session = current; current = null; opening = false; updateButton();
    if (!session) return;
    session.closed = true; clearInterval(session.heartbeat); clearTimeout(session.retry); clearTimeout(session.resizeTimer); session.retryResolve?.();
    session.pollAbort?.abort(); session.observer?.disconnect(); session.term?.dispose();
    session.dialog.remove(); if (restoreFocus && authenticated) button.focus();
    if (session.id && !session.ended) {
      try { await api(`/api/terminal/${session.id}/close`, {}); }
      catch { /* The server lease closes it after the last authenticated heartbeat. */ }
    }
  }
  async function open() {
    if (disposed || !authenticated || !enabled || opening) return;
    if (current) { current.term?.focus(); return; }
    opening = true; const version = ++epoch; updateButton();
    const dialog = document.createElement('dialog'); dialog.className = 'temporary-terminal'; dialog.setAttribute('aria-labelledby', 'temporary-terminal-title');
    const header = document.createElement('header'); header.className = 'terminal-header';
    const title = document.createElement('h2'); title.id = 'temporary-terminal-title'; title.textContent = '临时终端';
    const closeButton = makeButton('关闭终端', () => void close(), 'terminal-close');
    header.append(title, closeButton);
    const statusLine = document.createElement('p'); statusLine.className = 'terminal-status'; statusLine.setAttribute('role', 'status'); statusLine.textContent = '正在连接服务器终端…';
    const surface = document.createElement('div'); surface.className = 'terminal-surface';
    const controls = document.createElement('div'); controls.className = 'terminal-keys';
    const note = document.createElement('p'); note.className = 'terminal-note'; note.textContent = '起始目录 / · 关闭即结束 · 断线后约 1 分钟自动结束';
    const session = { dialog, status: statusLine, surface, id: null, cursor: 0, queue: [], queuedBytes: 0, sending: false, closed: false, ended: false, inputPaused: false };
    const resume = makeButton('继续输入', () => { if (!isCurrent(session) || session.ended) return; session.inputPaused = false; session.term.options.disableStdin = false; resume.hidden = true; status(session, '已恢复输入 · 未重发之前的输入'); session.term.focus(); }, 'terminal-resume');
    session.resume = resume; resume.hidden = true;
    for (const [label, data, titleText] of [['Ctrl C', '\x03', '中断当前命令'], ['Tab', '\t', '补全'], ['Esc', '\x1b', 'Escape'], ['↑', '\x1b[A', '上一条命令'], ['↓', '\x1b[B', '下一条命令']]) {
      const key = makeButton(label, () => { input(session, new TextEncoder().encode(data)); session.term?.focus(); }, 'terminal-key'); key.setAttribute('aria-label', titleText); controls.append(key);
    }
    controls.append(resume); dialog.append(header, statusLine, surface, controls, note); parent.append(dialog); current = session;
    dialog.addEventListener('cancel', event => { event.preventDefault(); /* Esc belongs to the terminal; explicit close ends the shell. */ session.term?.focus(); });
    try {
      dialog.showModal(); await loadVendor();
      if (!isCurrent(session) || epoch !== version) return;
      session.term = new globalThis.Terminal({ documentOverride: terminalDocument, cursorBlink: true, convertEol: false, scrollback: 2000, fontSize: 14, fontFamily: 'Consolas, "SFMono-Regular", Menlo, monospace', allowProposedApi: false, theme: { background: '#14212d', foreground: '#e4edf4', cursor: '#9ecbff', selectionBackground: '#365572', black: '#14212d', brightBlack: '#899ead', blue: '#79b8ff', brightBlue: '#a2ceff', green: '#9ad6b0', brightGreen: '#b5ecc9', red: '#ff9d9d', brightRed: '#ffbcbc' } });
      session.fit = new globalThis.FitAddon.FitAddon(); session.term.loadAddon(session.fit);
      // xterm 6's scrollbar uses window.document instead of documentOverride.
      // Stamp only styles created synchronously by open(), then restore it.
      // https://github.com/xtermjs/xterm.js/issues/4445
      const originalCreateElement = document.createElement;
      try { if (styleNonce) document.createElement = createTerminalElement; session.term.open(surface); }
      finally { document.createElement = originalCreateElement; }
      session.term.textarea?.setAttribute('aria-label', '服务器临时终端输入');
      session.fit.fit(); session.term.options.disableStdin = true;
      const cols = Math.min(500, Math.max(10, session.term.cols)), rows = Math.min(200, Math.max(2, session.term.rows));
      const created = await api('/api/terminal', { cols, rows });
      if (!isCurrent(session) || epoch !== version || !authenticated) { try { await api(`/api/terminal/${created.id}/close`, {}); } catch { /* Auth invalidation also closes server ownership. */ } return; }
      Object.assign(session, { id: created.id, cols, rows }); opening = false; updateButton(); session.term.options.disableStdin = false;
      session.term.onData(data => input(session, new TextEncoder().encode(data)));
      session.term.onBinary(data => input(session, Uint8Array.from(data, value => value.charCodeAt(0) & 255)));
      session.observer = new ResizeObserver(() => { clearTimeout(session.resizeTimer); session.resizeTimer = setTimeout(() => void resize(session), 100); }); session.observer.observe(surface);
      session.heartbeat = setInterval(() => {
        if (!isCurrent(session) || session.ended) return;
        api(`/api/terminal/${session.id}/heartbeat`, {}).catch(error => { if (isCurrent(session) && [401, 403, 404].includes(error.status)) { session.ended = true; session.term.options.disableStdin = true; clearInterval(session.heartbeat); status(session, '终端连接已失效。', true); } });
      }, 15000);
      status(session, '已连接 · 当前服务器用户 · 起始目录 /'); session.term.focus(); void poll(session);
    } catch (error) {
      if (!isCurrent(session)) return;
      opening = false; updateButton(); status(session, error.message || '无法打开终端，请关闭后重试。', true);
      session.ended = !session.id;
    }
  }
  const clicked = () => void open(); const pageHide = () => void close({ restoreFocus: false });
  button.addEventListener('click', clicked); window.addEventListener('pagehide', pageHide); updateButton();
  return {
    open, close,
    setAuthenticated(value, { available = true } = {}) { authenticated = value === true; enabled = available === true; if (!authenticated || !enabled) void close({ restoreFocus: false }); updateButton(); },
    dispose() { disposed = true; button.removeEventListener('click', clicked); window.removeEventListener('pagehide', pageHide); void close({ restoreFocus: false }); }
  };
}
