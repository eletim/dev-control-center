import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProjectError } from './project-store.js';

const execFileAsync = promisify(execFile);
const processSupervisorPath = fileURLToPath(new URL('./process-supervisor.js', import.meta.url));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function projectWindowName(project) {
  const basename = path.basename(project.path)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'project';
  const identity = createHash('sha256').update(project.id).digest('hex').slice(0, 12);
  return `${basename}-${identity}`;
}

export class ProjectProcessManager {
  constructor({
    stateFile = null,
    sessionName = 'dev-control-center',
    tmuxPath = 'tmux',
    tmuxSocketName = null,
    startupDelay = 150,
    stopTimeout = 2000,
    pollInterval = 25,
  } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionName)) {
      throw new Error('The tmux session name may contain only letters, numbers, underscores, and hyphens.');
    }
    this.processes = new Map();
    this.queues = new Map();
    this.stateFile = stateFile;
    this.sessionName = sessionName;
    this.tmuxPath = tmuxPath;
    this.tmuxSocketName = tmuxSocketName;
    this.startupDelay = startupDelay;
    this.stopTimeout = stopTimeout;
    this.pollInterval = pollInterval;
    this.acceptingLifecycleWork = true;
    this.lockOwner = null;
    if (this.stateFile) this.#acquireStateLock();
    try {
      this.#load();
    } catch (error) {
      this.releaseStateLock();
      throw error;
    }
  }

  async withProjectLock(id, operation) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.catch(() => {});
    this.queues.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    }
  }

  isRunning(id) {
    const managed = this.processes.get(id);
    if (!managed) return false;
    if (managed.pending) return false;
    const pane = this.#paneState(managed);
    if (!pane) {
      this.#forget(id, managed);
      return false;
    }
    return !pane.dead;
  }

  start(project) {
    this.#requireLifecycleWork();
    return this.withProjectLock(project.id, () => this.#start(project));
  }

  stop(id) {
    this.#requireLifecycleWork();
    return this.withProjectLock(id, () => this.#stop(id, true));
  }

  restart(project) {
    this.#requireLifecycleWork();
    return this.withProjectLock(project.id, async () => {
      await this.#stop(project.id, false);
      await this.#start(project);
    });
  }

  remove(id) {
    return this.#stop(id, false);
  }

  perform(id, action, getProject) {
    this.#requireLifecycleWork();
    return this.withProjectLock(id, async () => {
      const project = await getProject();
      if (!project) throw new ProjectError('not_found', 'Project not found.');
      if (action === 'start') await this.#start(project);
      else if (action === 'stop') await this.#stop(id, true);
      else {
        await this.#stop(id, false);
        await this.#start(project);
      }
      return project;
    });
  }

  async stopAll() {
    await Promise.all([...this.processes.keys()].map((id) => (
      this.withProjectLock(id, () => this.#stop(id, false))
    )));
  }

  beginShutdown() {
    this.acceptingLifecycleWork = false;
  }

  async drain() {
    await Promise.all([...this.queues.values()]);
  }

  releaseStateLock() {
    if (!this.stateFile || !this.lockOwner) return;
    const lockPath = `${this.stateFile}.lock`;
    let currentOwner;
    try {
      currentOwner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    } catch {
      return;
    }
    if (currentOwner.pid !== this.lockOwner.pid || currentOwner.startTime !== this.lockOwner.startTime) return;
    const retiredPath = `${lockPath}.${randomUUID()}.retired`;
    try {
      renameSync(lockPath, retiredPath);
      rmSync(retiredPath, { recursive: true, force: true });
      this.lockOwner = null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async #start(project) {
    if (this.isRunning(project.id)) {
      throw new ProjectError('already_running', 'Project is already running.');
    }

    let managed = this.processes.get(project.id);
    if (managed) {
      const pane = this.#paneState(managed);
      if (pane && !pane.dead) {
        this.processes.set(project.id, managed);
        this.#persist();
        throw new ProjectError('already_running', 'Project is already running.');
      }
      await this.#killWindow(managed);
      this.#forget(project.id, managed);
    }

    const pending = {
      pending: true,
      sessionName: this.sessionName,
      windowName: projectWindowName(project),
      token: randomUUID(),
    };
    this.processes.set(project.id, pending);
    this.#persist();

    try {
      managed = await this.#createWindow(project, pending);
      this.processes.set(project.id, managed);
      this.#persist();
    } catch (error) {
      this.#forget(project.id, pending);
      throw new ProjectError('start_failed', `Could not start project in tmux: ${error.message}`);
    }

    await delay(this.startupDelay);
    const pane = this.#paneState(managed);
    if (pane?.dead && (pane.status !== 0 || pane.signal)) {
      const reason = pane.signal ? `signal ${pane.signal}` : `exit code ${pane.status}`;
      throw new ProjectError('start_failed', `Start Command failed with ${reason}. Output remains in tmux window ${managed.windowName}.`);
    }
  }

  async #createWindow(project, pending) {
    const { token, windowName } = pending;
    const format = '#{session_id}\t#{window_id}\t#{pane_id}';
    let result;
    const newWindowArguments = ['new-window', '-d', '-P', '-F', format, '-t', this.sessionName, '-n', windowName, '-c', project.path];
    if (this.#sessionExists()) {
      result = await this.#tmux(newWindowArguments);
    } else {
      try {
        result = await this.#tmux(['new-session', '-d', '-P', '-F', format, '-s', this.sessionName, '-n', windowName, '-c', project.path]);
      } catch (error) {
        if (!/duplicate session/i.test(error.message)) throw error;
        result = await this.#tmux(newWindowArguments);
      }
    }
    const [sessionId, windowId, paneId] = result.stdout.trim().split('\t');
    if (!/^\$\d+$/.test(sessionId) || !/^@\d+$/.test(windowId) || !/^%\d+$/.test(paneId)) {
      throw new Error('tmux did not return a session, window, and pane identity');
    }
    const managed = {
      sessionName: this.sessionName,
      sessionId,
      windowName,
      windowId,
      paneId,
      token,
    };
    try {
      await this.#tmux(['set-option', '-p', '-t', paneId, '@dcc_owner_token', token]);
      await this.#tmux(['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on']);
      await this.#tmux(['set-option', '-w', '-t', windowId, 'automatic-rename', 'off']);
      await this.#tmux(['set-option', '-w', '-t', windowId, 'allow-rename', 'off']);
      const supervisor = [process.execPath, processSupervisorPath, project.startCommand, token].map(shellQuote).join(' ');
      const command = `${shellQuote(this.tmuxPath)} set-option -p -t "$TMUX_PANE" @dcc_command_started ${shellQuote(token)} && exec ${supervisor}`;
      await this.#tmux(['respawn-pane', '-k', '-t', paneId, '-c', project.path, command]);
      return managed;
    } catch (error) {
      await this.#killWindow(managed, false);
      throw error;
    }
  }

  async #stop(id, requireRunning) {
    const managed = this.processes.get(id);
    if (!managed) {
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      return;
    }
    if (managed.pending) {
      this.#forget(id, managed);
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      return;
    }

    const pane = this.#paneState(managed);
    if (!pane) {
      this.#forget(id, managed);
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      return;
    }
    if (pane.dead) {
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      await this.#killWindow(managed);
      this.#forget(id, managed);
      return;
    }

    this.#signalPane(managed, 'SIGTERM');
    let deadline = Date.now() + this.stopTimeout;
    while (this.isRunning(id) && Date.now() < deadline) await delay(this.pollInterval);
    if (this.isRunning(id)) {
      this.#signalPane(managed, 'SIGKILL');
      deadline = Date.now() + this.stopTimeout;
      while (this.isRunning(id) && Date.now() < deadline) await delay(this.pollInterval);
    }
    if (this.isRunning(id)) throw new ProjectError('stop_failed', 'Could not stop the project process group.');
    await this.#killWindow(managed);
    this.#forget(id, managed);
  }

  #signalPane(managed, signal) {
    const pane = this.#paneState(managed);
    if (!pane || !Number.isInteger(pane.pid)) return;
    try {
      process.kill(-pane.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  #requireLifecycleWork() {
    if (!this.acceptingLifecycleWork) {
      throw new ProjectError('shutting_down', 'The control center is shutting down.');
    }
  }

  #sessionExists() {
    return this.#tmuxSync(['has-session', '-t', `=${this.sessionName}`], { stdio: 'ignore' }).status === 0;
  }

  #paneState(managed, requireStarted = true) {
    const result = this.#tmuxQuery([
      'display-message', '-p', '-t', managed.paneId,
      '#{session_name}\t#{session_id}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{@dcc_owner_token}\t#{@dcc_command_started}\t#{pane_dead}\t#{@dcc_exit_status}\t#{pane_dead_signal}\t#{pane_pid}',
    ], { encoding: 'utf8' });
    if (!result) return null;
    const [sessionName, sessionId, windowName, windowId, paneId, token, commandStarted, dead, status, signal, pid]
      = result.stdout.trim().split('\t');
    if (sessionName !== managed.sessionName || sessionId !== managed.sessionId
      || windowName !== managed.windowName || windowId !== managed.windowId
      || paneId !== managed.paneId || token !== managed.token
      || (requireStarted && commandStarted !== managed.token)) return null;
    return {
      dead: dead === '1',
      status: status === '' ? null : Number(status),
      signal: signal || null,
      pid: Number(pid),
    };
  }

  #findPendingWindow(pending) {
    const result = this.#tmuxQuery([
      'list-panes', '-a', '-F',
      '#{session_name}\t#{session_id}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{@dcc_owner_token}\t#{@dcc_command_started}',
    ], { encoding: 'utf8' });
    if (!result) return null;
    const matches = result.stdout.trim().split('\n').flatMap((line) => {
      const [sessionName, sessionId, windowName, windowId, paneId, token, commandStarted] = line.split('\t');
      if (sessionName !== pending.sessionName || windowName !== pending.windowName
        || token !== pending.token) return [];
      return [{
        managed: { sessionName, sessionId, windowName, windowId, paneId, token },
        started: commandStarted === pending.token,
      }];
    });
    if (matches.length > 1) throw new Error('Multiple tmux panes claim the same project ownership token.');
    return matches[0] ?? null;
  }

  async #killWindow(managed, requireStarted = true) {
    if (!managed?.windowId || !this.#paneState(managed, requireStarted)) return;
    try {
      await this.#tmux(['kill-window', '-t', managed.windowId]);
    } catch (error) {
      if (!/can't find|no server running|no such/i.test(error.message)) throw error;
    }
  }

  #killWindowSync(managed, requireStarted = true) {
    if (!managed?.windowId || !this.#paneState(managed, requireStarted)) return;
    this.#tmuxQuery(['kill-window', '-t', managed.windowId], { encoding: 'utf8' });
  }

  #forget(id, managed) {
    if (managed && this.processes.get(id) !== managed) return;
    this.processes.delete(id);
    this.#persist();
  }

  #load() {
    if (!this.stateFile) return;
    let records;
    try {
      records = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (!Array.isArray(records)) throw new Error('expected an array');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Could not read process data: ${error.message}`, { cause: error });
    }

    for (const record of records) {
      if (typeof record.id !== 'string' || record.sessionName !== this.sessionName
        || typeof record.windowName !== 'string' || typeof record.token !== 'string'
        || record.token.length < 32) continue;
      const base = {
        sessionName: record.sessionName,
        windowName: record.windowName,
        token: record.token,
      };
      if (record.pending === true) {
        const pendingWindow = this.#findPendingWindow(base);
        if (pendingWindow?.started) this.processes.set(record.id, pendingWindow.managed);
        else if (pendingWindow) this.#killWindowSync(pendingWindow.managed, false);
        continue;
      }
      if (!/^\$\d+$/.test(record.sessionId) || !/^@\d+$/.test(record.windowId)
        || !/^%\d+$/.test(record.paneId)) continue;
      const managed = {
        ...base,
        sessionId: record.sessionId,
        windowId: record.windowId,
        paneId: record.paneId,
      };
      if (this.#paneState(managed)) this.processes.set(record.id, managed);
    }
    this.#persist();
  }

  #persist() {
    if (!this.stateFile) return;
    const records = [...this.processes.entries()].map(([id, managed]) => ({ id, ...managed }));
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporaryPath = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.stateFile);
  }

  async #tmux(args) {
    try {
      return await execFileAsync(this.tmuxPath, this.#tmuxArguments(args));
    } catch (error) {
      const detail = error.code === 'ENOENT' ? `${this.tmuxPath} is not installed`
        : (error.stderr || error.message).trim();
      throw new Error(detail, { cause: error });
    }
  }

  #tmuxSync(args, options) {
    return spawnSync(this.tmuxPath, this.#tmuxArguments(args), options);
  }

  #tmuxQuery(args, options) {
    const result = this.#tmuxSync(args, options);
    if (result.error) {
      const detail = result.error.code === 'ENOENT' ? `${this.tmuxPath} is not installed` : result.error.message;
      throw new Error(`Could not query tmux: ${detail}`, { cause: result.error });
    }
    if (result.status === 0) return result;
    const detail = (result.stderr || '').trim();
    if (/can't find|no server running|no such file or directory/i.test(detail)) return null;
    throw new Error(`Could not query tmux: ${detail || `exit code ${result.status}`}`);
  }

  #tmuxArguments(args) {
    return this.tmuxSocketName ? ['-L', this.tmuxSocketName, ...args] : args;
  }

  #acquireStateLock() {
    const lockPath = `${this.stateFile}.lock`;
    const startTime = this.#processStartTime(process.pid);
    const owner = { pid: process.pid, startTime };

    while (true) {
      const candidatePath = `${lockPath}.${randomUUID()}.candidate`;
      mkdirSync(candidatePath, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(candidatePath, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 });
      try {
        renameSync(candidatePath, lockPath);
        this.lockOwner = owner;
        return;
      } catch (error) {
        rmSync(candidatePath, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }

      if (this.#stateLockIsLive(lockPath)) {
        throw new Error(`Process state is already controlled by another process: ${this.stateFile}`);
      }

      const stalePath = `${lockPath}.${randomUUID()}.stale`;
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch (error) {
        if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    }
  }

  #stateLockIsLive(lockPath) {
    try {
      const owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      return Number.isInteger(owner.pid) && typeof owner.startTime === 'string'
        && this.#processStartTime(owner.pid) === owner.startTime;
    } catch {
      return false;
    }
  }

  #processStartTime(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
      try {
        process.kill(pid, 0);
        return `pid:${pid}`;
      } catch (error) {
        if (error.code === 'EPERM') return `pid:${pid}`;
        if (error.code === 'ESRCH') return null;
        throw error;
      }
    }
  }
}
