import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ProjectError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class ProjectStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.projects = [];
    this.ready = this.#load();
    this.pendingMutation = Promise.resolve();
  }

  async #load() {
    try {
      const contents = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('expected an array');
      this.projects = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not read project data: ${error.message}`, { cause: error });
      }
    }
  }

  async list() {
    await this.ready;
    return this.projects.map((project) => ({ ...project }));
  }

  async get(id) {
    await this.ready;
    return this.projects.find((project) => project.id === id) ?? null;
  }

  async create(input) {
    return this.#mutate(async (projects) => {
      const project = await this.#validatedProject(input);
      this.#ensureUniquePath(projects, project.path);
      const saved = { id: randomUUID(), ...project };
      return { projects: [...projects, saved], result: { ...saved } };
    });
  }

  async update(id, input) {
    return this.#mutate(async (projects) => {
      const index = projects.findIndex((project) => project.id === id);
      if (index === -1) throw new ProjectError('not_found', 'Project not found.');
      const project = await this.#validatedProject(input);
      this.#ensureUniquePath(projects, project.path, id);
      const saved = { id, ...project };
      const nextProjects = [...projects];
      nextProjects[index] = saved;
      return { projects: nextProjects, result: { ...saved } };
    });
  }

  async delete(id) {
    return this.#mutate(async (projects) => {
      const index = projects.findIndex((project) => project.id === id);
      if (index === -1) throw new ProjectError('not_found', 'Project not found.');
      return { projects: projects.filter((project) => project.id !== id) };
    });
  }

  async #validatedProject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProjectError('invalid_input', 'A JSON object is required.');
    }
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      throw new ProjectError('invalid_path', 'Path is required.');
    }
    if (typeof input.startCommand !== 'string' || input.startCommand.trim() === '') {
      throw new ProjectError('invalid_start_command', 'Start Command is required.');
    }

    let canonicalPath;
    try {
      canonicalPath = await realpath(path.resolve(input.path.trim()));
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new ProjectError('invalid_path', 'Path must be an existing directory.');
    }

    return { path: canonicalPath, startCommand: input.startCommand.trim() };
  }

  #ensureUniquePath(projects, canonicalPath, exceptId = null) {
    if (projects.some((project) => project.path === canonicalPath && project.id !== exceptId)) {
      throw new ProjectError('duplicate_path', 'That project path is already registered.');
    }
  }

  async #mutate(operation) {
    const mutation = this.pendingMutation.then(async () => {
      await this.ready;
      const { projects, result } = await operation(this.projects);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(projects, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
      this.projects = projects;
      return result;
    });
    this.pendingMutation = mutation.catch(() => {});
    return mutation;
  }
}
