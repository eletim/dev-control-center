import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectError } from './project-store.js';

const processTokenName = 'DEV_CONTROL_CENTER_PROCESS_TOKEN';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ProjectProcessManager {
  constructor({ stateFile = null, startupDelay = 150, stopTimeout = 2000, pollInterval = 25 } = {}) {
    this.processes = new Map();
    this.queues = new Map();
    this.stateFile = stateFile;
    this.startupDelay = startupDelay;
    this.stopTimeout = stopTimeout;
    this.pollInterval = pollInterval;
    this.#load();
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
    if (this.#ownsProcessGroup(managed)) return true;
    this.#forget(id, managed);
    return false;
  }

  start(project) {
    return this.withProjectLock(project.id, () => this.#start(project));
  }

  stop(id) {
    return this.withProjectLock(id, () => this.#stop(id, true));
  }

  restart(project) {
    return this.withProjectLock(project.id, async () => {
      await this.#stop(project.id, false);
      await this.#start(project);
    });
  }

  perform(id, action, getProject) {
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

  async #start(project) {
    if (this.isRunning(project.id)) {
      throw new ProjectError('already_running', 'Project is already running.');
    }

    const token = randomUUID();
    const child = spawn(project.startCommand, {
      cwd: project.path,
      detached: true,
      env: { ...process.env, [processTokenName]: token },
      shell: true,
      stdio: 'ignore',
    });
    const managed = { child, processGroupId: child.pid, token, local: true, monitor: null };
    this.processes.set(project.id, managed);
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      this.#persist();
    } catch (error) {
      if (managed.processGroupId && this.#ownsProcessGroup(managed)) await this.#stop(project.id, false);
      else this.#forget(project.id, managed);
      throw new ProjectError('start_failed', `Could not start project: ${error.message}`);
    }

    child.unref();
    this.#monitor(project.id, managed);
    const earlyExit = await Promise.race([exited, delay(this.startupDelay).then(() => null)]);
    if (earlyExit && (earlyExit.code !== 0 || earlyExit.signal)) {
      await this.#stop(project.id, false);
      const reason = earlyExit.signal ? `signal ${earlyExit.signal}` : `exit code ${earlyExit.code}`;
      throw new ProjectError('start_failed', `Start Command failed with ${reason}.`);
    }
    this.isRunning(project.id);
  }

  async #stop(id, requireRunning) {
    if (!this.isRunning(id)) {
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      return;
    }

    const managed = this.processes.get(id);
    this.#signal(managed.processGroupId, 'SIGTERM');
    let deadline = Date.now() + this.stopTimeout;
    while (this.isRunning(id) && Date.now() < deadline) await delay(this.pollInterval);
    if (this.isRunning(id)) {
      this.#signal(managed.processGroupId, 'SIGKILL');
      deadline = Date.now() + this.stopTimeout;
      while (this.isRunning(id) && Date.now() < deadline) await delay(this.pollInterval);
    }
    if (this.isRunning(id)) throw new ProjectError('stop_failed', 'Could not stop the project process group.');
    this.#forget(id, managed);
  }

  #signal(processGroupId, signal) {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  #ownsProcessGroup(managed) {
    let processIds;
    try {
      processIds = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
    } catch {
      if (!managed.local) return false;
      try {
        process.kill(-managed.processGroupId, 0);
        return true;
      } catch (error) {
        if (error.code === 'EPERM') return true;
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    }

    const expectedToken = `${processTokenName}=${managed.token}`;
    return processIds.some((processId) => {
      try {
        const stat = readFileSync(`/proc/${processId}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) !== managed.processGroupId) return false;
        const environment = readFileSync(`/proc/${processId}/environ`).toString('utf8').split('\0');
        return environment.includes(expectedToken);
      } catch {
        return false;
      }
    });
  }

  #monitor(id, managed) {
    managed.monitor = setInterval(() => this.isRunning(id), 1000);
    managed.monitor.unref();
  }

  #forget(id, managed) {
    if (this.processes.get(id) !== managed) return;
    if (managed.monitor) clearInterval(managed.monitor);
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
      if (typeof record.id !== 'string' || !Number.isInteger(record.processGroupId) || typeof record.token !== 'string') continue;
      const managed = { child: null, ...record, local: false, monitor: null };
      if (!this.#ownsProcessGroup(managed)) continue;
      this.processes.set(record.id, managed);
      this.#monitor(record.id, managed);
    }
    this.#persist();
  }

  #persist() {
    if (!this.stateFile) return;
    const records = [...this.processes.entries()].map(([id, managed]) => ({
      id,
      processGroupId: managed.processGroupId,
      token: managed.token,
    }));
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporaryPath = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.stateFile);
  }
}
