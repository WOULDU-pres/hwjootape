import { readProjectManifest } from './metadata-store';
import { resolveProjectRootById } from './registry';

interface ActiveProjectContext {
  projectRoot: string;
  launchId: string;
}

/**
 * Resolve which project a request targets, for the single-hub server model.
 * Order: `?project=<id>` query param, then `x-project-id` header (both looked up
 * in the registry), then the BANANATAPE_ACTIVE_PROJECT_PATH env (single-project
 * fallback for the per-project launch model). Returns null if none resolve.
 */
export async function resolveRequestProjectRoot(request: Request, env = process.env): Promise<string | null> {
  let id: string | null = null;
  try {
    id = new URL(request.url).searchParams.get('project');
  } catch {
    id = null;
  }
  id = id || request.headers.get('x-project-id');
  if (id) {
    const root = await resolveProjectRootById(id);
    if (root) return root;
  }
  return getConfiguredProjectRoot(env);
}

export function getConfiguredProjectRoot(env = process.env): string | null {
  const value = env.BANANATAPE_ACTIVE_PROJECT_PATH?.trim();
  return value || null;
}

export function getLaunchId(env = process.env): string {
  return env.BANANATAPE_LAUNCH_ID?.trim() || 'dev';
}

export function hasActiveProject(env = process.env): boolean {
  return Boolean(getConfiguredProjectRoot(env));
}

export function requireProjectSession(env = process.env): ActiveProjectContext {
  const projectRoot = getConfiguredProjectRoot(env);
  if (!projectRoot) throw new Error('No active BananaTape project');
  return {
    projectRoot,
    launchId: getLaunchId(env),
  };
}

export async function getCurrentProjectSummary() {
  const projectRoot = getConfiguredProjectRoot();
  if (!projectRoot) return { persistence: 'none' as const };
  const session = requireProjectSession();
  const manifest = await readProjectManifest(session.projectRoot);
  return {
    persistence: 'project' as const,
    projectId: manifest.id,
    projectName: manifest.name,
    launchId: session.launchId,
  };
}
