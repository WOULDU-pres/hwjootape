import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Open a file manager window in the OS, scoped to the active project.
 *
 * Mirrors the spawnBrowser() platform dispatch in bin/bananatape.mjs:
 * open (darwin) / explorer-via-cmd (win32) / xdg-open (linux), always spawned
 * with an argument array (never a shell string), detached + unref.
 */
function openInFileManager(dir: string): void {
  if (process.platform === 'darwin') {
    spawn('open', [dir], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (process.platform === 'win32') {
    // start needs an empty "" title arg; cmd /c keeps it off a shell string.
    spawn('cmd', ['/c', 'start', '', dir], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [dir], { stdio: 'ignore', detached: true }).unref();
}

/**
 * Resolve `requested` to an absolute path and assert it stays inside
 * `projectRoot`. Returns the absolute path, or null if it escapes the root.
 *
 * The boundary check resolves both sides to their real (symlink-followed)
 * absolute forms and requires the target to equal the root or sit under
 * `root + path.sep` — the trailing separator prevents a sibling like
 * `/projects/foo-evil` from passing a `/projects/foo` prefix test.
 */
async function resolveWithinRoot(
  projectRoot: string,
  requested: string,
): Promise<string | null> {
  const rootReal = await realpath(projectRoot);
  // Resolve the request relative to the real project root (absolute inputs win,
  // path.resolve collapses any ../ segments before the prefix check).
  const target = path.resolve(rootReal, requested);
  // Resolve symlinks on whatever portion of the target already exists so a
  // symlink can't smuggle the real path outside the root after the check.
  const targetReal = await realpath(target).catch(() => target);
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${path.sep}`)) {
    return null;
  }
  return targetReal;
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json(
        { error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const requested = typeof body?.path === 'string' ? body.path : '';
    if (!requested) {
      return NextResponse.json({ error: 'path (string) is required' }, { status: 400 });
    }

    const resolved = await resolveWithinRoot(projectRoot, requested);
    if (!resolved) {
      return NextResponse.json({ error: 'Path escapes project root' }, { status: 400 });
    }

    // If the path is a file, open its containing directory; if a directory, open it.
    let openDir = resolved;
    const info = await stat(resolved).catch(() => null);
    if (info && !info.isDirectory()) {
      openDir = path.dirname(resolved);
    }

    openInFileManager(openDir);

    return NextResponse.json({ success: true, opened: openDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to open folder';
    console.error('Open folder error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
