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
    this.pendingWrite = Promise.resolve();
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
    await this.ready;
    const project = await this.#validatedProject(input);
    this.#ensureUniquePath(project.path);
    const saved = { id: randomUUID(), ...project };
    this.projects.push(saved);
    await this.#save();
    return { ...saved };
  }

  async update(id, input) {
    await this.ready;
    const index = this.projects.findIndex((project) => project.id === id);
    if (index === -1) throw new ProjectError('not_found', 'Project not found.');
    const project = await this.#validatedProject(input);
    this.#ensureUniquePath(project.path, id);
    const saved = { id, ...project };
    this.projects[index] = saved;
    await this.#save();
    return { ...saved };
  }

  async delete(id) {
    await this.ready;
    const index = this.projects.findIndex((project) => project.id === id);
    if (index === -1) throw new ProjectError('not_found', 'Project not found.');
    this.projects.splice(index, 1);
    await this.#save();
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

  #ensureUniquePath(canonicalPath, exceptId = null) {
    if (this.projects.some((project) => project.path === canonicalPath && project.id !== exceptId)) {
      throw new ProjectError('duplicate_path', 'That project path is already registered.');
    }
  }

  async #save() {
    this.pendingWrite = this.pendingWrite.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.projects, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    return this.pendingWrite;
  }
}
