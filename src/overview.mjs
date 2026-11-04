import os from 'node:os';
import { open, readFile, readdir, readlink, stat, lstat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const finite = value => Number.isFinite(Number(value)) && String(value).trim() !== '' ? Number(value) : null;
const percent = (used, total) => total > 0 ? Math.round(Math.max(0, Math.min(100, used / total * 100)) * 10) / 10 : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cpuTicks = () => os.cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });

// pane_pid is the process started by tmux, not necessarily the Codex child PID.
export function parseTmuxPanes(text) {
  return text.split('\n').filter(Boolean).flatMap(line => {
    const [sessionId, ...fields] = line.split('|');
    if (fields.length < 5) return [];
    const [window, pane, paneId, pid] = fields.splice(-4), sessionName = fields.join('|');
    if (!/^\$\d+$/.test(sessionId || '') || !/^%\d+$/.test(paneId || '') || !sessionName || sessionName.length > 80 || /[\x00-\x1f\x7f]/.test(sessionName)) return [];
    if (![window, pane, pid].every(value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value))) || Number(pid) < 1) return [];
    return [{ sessionId, sessionName, windowIndex: Number(window), paneIndex: Number(pane), paneId, panePid: Number(pid), target: `${sessionId}:${window}.${pane}` }];
  });
}

async function readProcess(pid) {
  const folder = `/proc/${pid}`, info = await stat(folder);
  if (info.uid !== process.getuid()) return null;
  const text = await readFile(`${folder}/stat`, 'utf8'), end = text.lastIndexOf(')'), fields = text.slice(end + 2).split(' ');
  if (end < 0 || !/^\d+$/.test(fields[19] || '') || fields[0] === 'Z') return null;
  return { pid, ppid: Number(fields[1]), startTicks: fields[19], comm: text.slice(text.indexOf('(') + 1, end) };
}

async function tmuxEnvironment(pid) {
  const file = await open(`/proc/${pid}/environ`, 'r');
  try {
    const data = Buffer.alloc(65536), { bytesRead } = await file.read(data, 0, data.length, 0);
    const value = data.subarray(0, bytesRead).toString('utf8').split('\0').find(entry => entry.startsWith('TMUX='));
    const socket = /^TMUX=(\/[^\0]{1,4096}),\d+,\d+$/.exec(value || '')?.[1];
    return { socket, complete: bytesRead < data.length };
  } finally { await file.close(); }
}

// Commands only list tmux metadata. No pane output, command arguments or socket
// paths are returned to the browser, and PID ancestry is rechecked before use.
export function createTmuxResolver({ getProcess = readProcess, getEnvironment = tmuxEnvironment, listSocket, initialSockets } = {}) {
  const socketResults = new Map();
  const query = socket => {
    if (!socketResults.has(socket)) socketResults.set(socket, (async () => {
      try {
        const info = await lstat(socket);
        if (!info.isSocket() || info.uid !== process.getuid()) return { panes: [], complete: false };
        // Older tmux versions replace literal control separators with underscores.
        // Read the four numeric suffixes from the right so names may contain '|'.
        const { stdout } = await execute('/usr/bin/tmux', ['-S', socket, 'list-panes', '-a', '-F', '#{session_id}|#{session_name}|#{window_index}|#{pane_index}|#{pane_id}|#{pane_pid}'], { timeout: 1500, maxBuffer: 65536, windowsHide: true, env: { PATH: '/usr/bin:/bin' } });
        const panes = parseTmuxPanes(stdout);
        return { panes, complete: panes.length === stdout.split('\n').filter(Boolean).length };
      } catch (error) { return { panes: [], complete: error.code === 'ENOENT' }; }
    })());
    return socketResults.get(socket);
  };
  const getSocket = listSocket || query;
  let initial;
  const knownPanes = () => initial ||= (async () => {
    let sockets = initialSockets, complete = true;
    if (!sockets) {
      sockets = [fileURLToPath(new URL('../runtime/private-relay-tmux.sock', import.meta.url))];
      try {
        const directory = `/tmp/tmux-${process.getuid()}`, info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o022) complete = false;
        else {
          const entries = await readdir(directory);
          if (entries.length > 16) complete = false;
          sockets.push(...entries.slice(0, 16).map(name => `${directory}/${name}`));
        }
      } catch (error) { if (error.code !== 'ENOENT') complete = false; }
    }
    const results = await Promise.all([...new Set(sockets)].map(getSocket));
    return { panes: results.flatMap(result => result.panes), complete: complete && results.every(result => result.complete) };
  })();
  return async pid => {
    const unknown = { tmux: null, tmuxState: 'unknown' };
    try {
      const chain = [], seen = new Set(); let current = pid, complete = false;
      while (current > 1 && chain.length < 32 && !seen.has(current)) {
        seen.add(current); const entry = await getProcess(current);
        if (!entry) { complete = true; break; }
        chain.push(entry); current = entry.ppid;
      }
      if (current <= 1) complete = true;
      if (!chain.length || chain[0].pid !== pid) return unknown;
      const known = await knownPanes(); let panes = known.panes; complete &&= known.complete;
      const find = () => chain.map(entry => panes.find(pane => pane.panePid === entry.pid)).find(Boolean);
      let match = find(), hinted = false;
      if (!match) {
        for (const entry of chain) {
          try {
            const environment = await getEnvironment(entry.pid); complete &&= environment.complete;
            if (environment.socket) { hinted = true; const result = await getSocket(environment.socket); panes = [...panes, ...result.panes]; complete &&= result.complete; match = find(); if (match) break; }
          } catch { complete = false; }
        }
      }
      if (!match) return { tmux: null, tmuxState: complete && !hinted && !chain.some(entry => entry.comm?.startsWith('tmux')) ? 'none' : 'unknown' };
      for (const entry of chain) {
        const again = await getProcess(entry.pid);
        if (!again || again.startTicks !== entry.startTicks || again.ppid !== entry.ppid) return unknown;
      }
      const { panePid, ...tmux } = match;
      return { tmux, tmuxState: 'attached' };
    } catch { return unknown; }
  };
}

export function parseMemory(text) {
  const values = Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm)].map(match => [match[1], Number(match[2]) * 1024]));
  if (!values.MemTotal || !Number.isFinite(values.MemAvailable)) throw Error('memory_unavailable');
  const totalBytes = values.MemTotal, availableBytes = values.MemAvailable, usedBytes = totalBytes - availableBytes;
  return { totalBytes, usedBytes, availableBytes, percent: percent(usedBytes, totalBytes) };
}

export function parseGpu(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [index, name, utilization, total, used, temperature] = line.split(',').map(value => value.trim());
    if (!/^\d+$/.test(index) || !name || temperature === undefined) throw Error('gpu_unavailable');
    const totalMiB = finite(total), usedMiB = finite(used);
    return { index: Number(index), name: name.slice(0, 120), utilizationPercent: finite(utilization), memoryTotalBytes: totalMiB === null ? null : totalMiB * 1048576, memoryUsedBytes: usedMiB === null ? null : usedMiB * 1048576, temperatureC: finite(temperature) };
  });
}

// A live process holding this rollout proves ownership. A stored in-progress turn
// alone does not: interrupted clients can leave old task_started events behind.
export function rolloutActivity(head, tail) {
  let meta;
  try { const first = JSON.parse(head.split('\n')[0]); if (first.type === 'session_meta') meta = first.payload; } catch { return null; }
  if (!meta || !/^[A-Za-z0-9_-]{1,160}$/.test(meta.id || '') || typeof meta.cwd !== 'string' || !meta.cwd.startsWith('/')) return null;
  let status = 'unknown', cwd = meta.cwd;
  for (const line of tail.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'turn_context' && typeof event.payload?.cwd === 'string' && event.payload.cwd.startsWith('/') && event.payload.cwd.length <= 4096) cwd = event.payload.cwd;
    if (event.type !== 'event_msg') continue;
    if (['task_started', 'turn_started'].includes(event.payload?.type)) status = 'working';
    if (['task_complete', 'task_completed', 'turn_complete', 'turn_aborted'].includes(event.payload?.type)) status = 'idle';
  }
  return { threadId: meta.id, cwd: cwd.slice(0, 4096), status };
}

async function readRollout(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid()) return null;
    const chunks = []; let position = 0, newline = false;
    while (position < Math.min(2097152, info.size) && !newline) {
      const part = Buffer.alloc(Math.min(65536, info.size - position, 2097152 - position));
      const { bytesRead } = await file.read(part, 0, part.length, position);
      if (!bytesRead) break;
      const content = part.subarray(0, bytesRead); chunks.push(content); position += bytesRead; newline = content.includes(10);
    }
    if (!newline) return null;
    const last = Buffer.alloc(Math.min(262144, info.size));
    await file.read(last, 0, last.length, Math.max(0, info.size - last.length));
    return rolloutActivity(Buffer.concat(chunks).toString('utf8'), last.toString('utf8'));
  } finally { await file.close(); }
}

export async function observeCodexProcesses() {
  if (process.platform !== 'linux') return { agents: [], complete: false, unmappedProcesses: 0 };
  const agents = new Map(), resolveTmux = createTmuxResolver(); let complete = true, unmappedProcesses = 0;
  const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  for (const pid of pids) {
    let matched = false;
    try {
      const root = `/proc/${pid}`;
      if ((await stat(root)).uid !== process.getuid()) continue;
      const executable = await readlink(`${root}/exe`);
      if (!/^codex(?:\s+\(deleted\))?$/.test(basename(executable))) continue;
      matched = true;
      const tmux = await resolveTmux(Number(pid));
      // File descriptors reveal a session ID without exposing command arguments,
      // process environments, prompts, or arbitrary file contents to the browser.
      const allFds = await readdir(`${root}/fd`);
      if (allFds.length > 1024) complete = false;
      const fds = allFds.slice(0, 1024); let mapped = false;
      for (const fd of fds) {
        let path; try { path = await readlink(`${root}/fd/${fd}`); } catch { continue; }
        if (!/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(path)) continue;
        const activity = await readRollout(path);
        if (activity) {
          mapped = true;
          agents.set(`${activity.threadId}:${pid}`, { ...activity, ...tmux, pid: Number(pid), source: 'external', name: 'Codex', canOpen: true, detail: activity.status === 'unknown' ? '进程在线，任务状态暂不可确定' : activity.status === 'working' ? '正在执行任务' : '等待新任务' });
        } else complete = false;
      }
      if (!mapped) {
        unmappedProcesses++;
        let cwd = ''; try { cwd = await readlink(`${root}/cwd`); } catch { /* Unknown is still a useful observation. */ }
        agents.set(`process:${pid}`, { ...tmux, threadId: '', pid: Number(pid), cwd, source: 'external', name: `Codex 进程 ${pid}`, canOpen: false, status: 'unknown', detail: '进程在线，未找到可核对的会话记录' });
      }
    } catch (error) { if ((matched && !['ENOENT', 'ESRCH'].includes(error.code)) || !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) complete = false; }
  }
  return { agents: [...agents.values()], complete, unmappedProcesses };
}

async function collectStorage() {
  const mounts = (await readFile('/proc/mounts', 'utf8')).split('\n').map(line => line.split(' ')[1]).filter(path => path === '/' || /^\/mnt\/data\d+$/.test(path));
  const results = [];
  for (const path of [...new Set(mounts)]) {
    try {
      const values = await statfs(path, { bigint: true });
      const totalBytes = Number(values.blocks * values.bsize), availableBytes = Number(values.bavail * values.bsize), usedBytes = Number((values.blocks - values.bfree) * values.bsize);
      results.push({ path, totalBytes, usedBytes, availableBytes, percent: percent(usedBytes, totalBytes) });
    } catch { /* Other filesystems remain visible if one mount is unavailable. */ }
  }
  return results;
}

export function createOverviewCollector({ config, rpc, authorizedThreads, loadedThreads = new Set(), threadNames = new Map(), activeTurns, busy, approvals, clock = Date.now, mock = false, registerProject, sampleMetrics, observeProcesses = observeCodexProcesses } = {}) {
  let previousCpu = cpuTicks(), previousTime = clock(), cache, pending;
  const metrics = sampleMetrics || (async () => {
    const errors = [], result = { cpu: null, memory: null, storage: [], gpus: [], errors };
    if (mock) return { cpu: { percent: 18.4, cores: 32, load: [2.1, 1.8, 1.5] }, memory: { totalBytes: 274877906944, usedBytes: 68719476736, availableBytes: 206158430208, percent: 25 }, storage: [{ path: '/storage/data', totalBytes: 16000000000000, usedBytes: 2400000000000, availableBytes: 13600000000000, percent: 15 }], gpus: [{ index: 0, name: '模拟 GPU', utilizationPercent: 32, memoryTotalBytes: 25769803776, memoryUsedBytes: 6442450944, temperatureC: 46 }], errors: [], simulated: true };
    if (clock() - previousTime < 150) await delay(150);
    const currentCpu = cpuTicks(), difference = currentCpu.total - previousCpu.total;
    result.cpu = { percent: difference > 0 ? percent(difference - (currentCpu.idle - previousCpu.idle), difference) : null, cores: os.cpus().length, load: os.loadavg().map(value => Math.round(value * 100) / 100) };
    previousCpu = currentCpu; previousTime = clock();
    await Promise.all([
      (async () => { try { result.memory = parseMemory(await readFile('/proc/meminfo', 'utf8')); } catch { errors.push({ metric: 'memory', message: '内存指标暂不可用' }); } })(),
      (async () => { try { result.storage = await collectStorage(); } catch { errors.push({ metric: 'storage', message: '存储指标暂不可用' }); } })(),
      (async () => { try { const gpu = await execute('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 2500, maxBuffer: 65536, windowsHide: true, env: { PATH: '/usr/bin:/bin:/usr/local/bin' } }); result.gpus = parseGpu(gpu.stdout); } catch { errors.push({ metric: 'gpu', message: 'GPU 指标暂不可用或未安装 NVIDIA 驱动' }); } })(),
    ]);
    return result;
  });
  async function collect() {
    if (cache && clock() - cache.timestamp < 3000) return cache.data;
    if (pending) return pending;
    pending = (async () => {
      const [resources, observed] = await Promise.all([metrics(), mock ? { agents: [], complete: true } : observeProcesses().catch(() => ({ agents: [], complete: false }))]);
      const agents = new Map(), externalThreads = new Set();
      for (const agent of observed.agents) {
        if (!config.workspace && !config.projects.some(project => project.cwd === agent.cwd)) continue;
        const external = agent.threadId && Number.isInteger(agent.pid) && agent.pid !== rpc?.child?.pid;
        if (external) externalThreads.add(agent.threadId);
        const key = agent.threadId || `process:${agent.pid}`, prior = agents.get(key);
        if (prior && prior.pid !== rpc?.child?.pid && !external && agent.threadId) continue;
        const rank = { waitingApproval: 4, working: 3, unknown: 2, idle: 1 };
        if (external && prior && prior.pid !== rpc?.child?.pid && (rank[prior.status] || 0) > (rank[agent.status] || 0)) continue;
        let project;
        try { project = await registerProject?.(agent.cwd); } catch { /* Unavailable project stays read-only. */ }
        agents.set(key, { ...agent, name: threadNames.get(agent.threadId) || `${basename(agent.cwd || '') || 'Codex'} · ${agent.threadId?.slice(0, 8) || agent.pid}`, ...(project ? { projectId: project.id } : {}), canOpen: !!agent.threadId && !!project });
      }
      for (const [threadId, cwd] of authorizedThreads) {
        if (!loadedThreads.has(threadId) || externalThreads.has(threadId)) continue;
        const status = [...approvals.values()].some(approval => approval.params.threadId === threadId) ? 'waitingApproval' : busy.has(threadId) || activeTurns.has(threadId) ? 'working' : 'idle';
        const old = agents.get(threadId) || observed.agents.find(agent => agent.pid === rpc?.child?.pid); let project;
        try { project = await registerProject?.(cwd); } catch { /* Closed project is displayed without opening. */ }
        agents.set(threadId, { ...old, threadId, cwd, name: threadNames.get(threadId) || `${basename(cwd) || 'Codex'} · ${threadId.slice(0, 8)}`, source: 'relay', status, canOpen: !!project || config.projects.some(p => p.cwd === cwd), projectId: project?.id || config.projects.find(p => p.cwd === cwd)?.id, detail: status === 'waitingApproval' ? '等待你批准操作' : status === 'working' ? '正在执行任务' : '等待新任务' });
      }
      const externalComplete = observed.complete && !(observed.unmappedProcesses > 0);
      const data = { sampledAt: new Date(clock()).toISOString(), metrics: resources, agents: [...agents.values()], coverage: { externalComplete, unmappedProcesses: observed.unmappedProcesses || 0, external: mock ? '模拟环境，不连接服务器' : externalComplete ? '通过同账号 Codex 进程及其打开的会话日志观察；无法确认的任务标为未知' : '部分外部进程无法对应到会话，任务状态可能不完整' } };
      cache = { timestamp: clock(), data }; return data;
    })().finally(() => { pending = null; });
    return pending;
  }
  return collect;
}
