/**
 * registry — server-side access to the CLI's project registry (~/.bananatape/projects.json)
 * and runtime list, so a single "hub" server can list / create / resolve any project
 * per-request instead of being pinned to one BANANATAPE_ACTIVE_PROJECT_PATH.
 *
 * Mirrors bin/bananatape.mjs registry semantics (schemaVersion 1, Unicode-aware slug).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  getRegistryPath,
  getRuntimeRegistryPath,
  getProjectsRoot,
  getManifestPath,
  getHistoryPath,
} from './paths';

const SCHEMA_VERSION = 1;

export interface RegistryProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

export interface RunningEntry {
  projectId: string;
  projectPath?: string;
  port: number;
  pid: number;
  launchId?: string;
}

/** Unicode-aware slug: keep letters (incl. Korean/CJK) + numbers; everything else -> '-'. */
export function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!slug) throw new Error('Project name must include at least one letter or number.');
  return slug;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return fallback;
    throw error;
  }
}

interface RegistryFile {
  schemaVersion: number;
  projects: RegistryProject[];
}

export async function readRegistry(): Promise<RegistryFile> {
  const registry = await readJson<RegistryFile>(getRegistryPath(), { schemaVersion: SCHEMA_VERSION, projects: [] });
  return registry.schemaVersion === SCHEMA_VERSION && Array.isArray(registry.projects)
    ? registry
    : { schemaVersion: SCHEMA_VERSION, projects: [] };
}

export async function listRegisteredProjects(): Promise<RegistryProject[]> {
  return (await readRegistry()).projects;
}

export async function resolveProjectRootById(id: string): Promise<string | null> {
  const registry = await readRegistry();
  const found = registry.projects.find((project) => project.id === id || project.name === id);
  return found?.path ?? null;
}

export async function readRunningEntries(): Promise<RunningEntry[]> {
  const runtime = await readJson<{ schemaVersion: number; running: RunningEntry[] }>(
    getRuntimeRegistryPath(),
    { schemaVersion: SCHEMA_VERSION, running: [] },
  );
  return Array.isArray(runtime.running) ? runtime.running : [];
}

/** Create a project folder + manifest + history and append it to the registry. */
export async function createRegisteredProject(name: string, dir?: string): Promise<RegistryProject> {
  const id = slugify(name);
  const root = path.join(path.resolve(dir || getProjectsRoot()), id);
  const now = new Date().toISOString();
  const manifest = { schemaVersion: SCHEMA_VERSION, id, name: name.trim(), createdAt: now, updatedAt: now };

  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'references'), { recursive: true });
  await mkdir(path.join(root, 'thumbnails'), { recursive: true });
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  // wx: fail if the project already exists, so we never clobber.
  await writeFile(getManifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(
    getHistoryPath(root),
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision: 0, entries: [] }, null, 2)}\n`,
    { flag: 'wx' },
  );

  const registry = await readRegistry();
  registry.projects = registry.projects.filter((project) => project.id !== id && project.path !== root);
  const entry: RegistryProject = { id, name: manifest.name, path: root, createdAt: now, lastOpenedAt: null };
  registry.projects.push(entry);
  await mkdir(path.dirname(getRegistryPath()), { recursive: true });
  await writeFile(getRegistryPath(), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return entry;
}
