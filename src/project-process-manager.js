import { spawn } from 'node:child_process';
import { ProjectError } from './project-store.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ProjectProcessManager {
  constructor({ stopTimeout = 2000, pollInterval = 25 } = {}) {
    this.processes = new Map();
    this.queues = new Map();
    this.stopTimeout = stopTimeout;
    this.pollInterval = pollInterval;
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
    try {
      process.kill(-managed.processGroupId, 0);
      return true;
    } catch (error) {
      if (error.code === 'EPERM') return true;
      if (error.code !== 'ESRCH') throw error;
      this.#forget(id, managed);
      return false;
    }
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

  async #start(project) {
    if (this.isRunning(project.id)) {
      throw new ProjectError('already_running', 'Project is already running.');
    }

    const child = spawn(project.startCommand, {
      cwd: project.path,
      detached: true,
      shell: true,
      stdio: 'ignore',
    });
    const managed = { child, processGroupId: child.pid, monitor: null };
    this.processes.set(project.id, managed);

    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      this.#forget(project.id, managed);
      throw new ProjectError('start_failed', `Could not start project: ${error.message}`);
    }

    child.unref();
    managed.monitor = setInterval(() => this.isRunning(project.id), 1000);
    managed.monitor.unref();
  }

  async #stop(id, requireRunning) {
    if (!this.isRunning(id)) {
      if (requireRunning) throw new ProjectError('not_running', 'Project is not running.');
      return;
    }

    const managed = this.processes.get(id);
    this.#signal(managed.processGroupId, 'SIGTERM');
    const deadline = Date.now() + this.stopTimeout;
    while (this.isRunning(id) && Date.now() < deadline) await delay(this.pollInterval);
    if (this.isRunning(id)) {
      this.#signal(managed.processGroupId, 'SIGKILL');
      while (this.isRunning(id)) await delay(this.pollInterval);
    }
    this.#forget(id, managed);
  }

  #signal(processGroupId, signal) {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  #forget(id, managed) {
    if (this.processes.get(id) !== managed) return;
    if (managed.monitor) clearInterval(managed.monitor);
    this.processes.delete(id);
  }
}
