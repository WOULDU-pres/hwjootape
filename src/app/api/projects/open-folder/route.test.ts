import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn((command: string, args: readonly string[]) => {
    void command;
    void args;
    return { unref: vi.fn() };
  }),
  resolveRequestProjectRoot: vi.fn<(request: Request) => Promise<string | null>>(),
}));

// No real process is ever launched: spawn is replaced, the rest passes through.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, default: { ...actual, spawn: mocks.spawn }, spawn: mocks.spawn };
});

// Inject the project root so the boundary check runs against our temp dir.
vi.mock('@/lib/projects/session', () => ({
  resolveRequestProjectRoot: mocks.resolveRequestProjectRoot,
}));

import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/projects/open-folder?project=demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// A real temp dir as the project root so realpath()-based resolution behaves
// exactly as in production, without ever escaping onto the real FS.
let projectRoot: string;
let projectRootReal: string;

beforeEach(async () => {
  mocks.spawn.mockClear();
  const base = await mkdtemp(path.join(os.tmpdir(), 'bananatape-openfolder-'));
  projectRoot = base;
  projectRootReal = await realpath(base);
  await mkdir(path.join(base, 'assets'), { recursive: true });
  await writeFile(path.join(base, 'assets', 'a.png'), 'x');
  mocks.resolveRequestProjectRoot.mockResolvedValue(projectRoot);
});

describe('POST /api/projects/open-folder', () => {
  it('rejects an absolute path outside the project root without spawning', async () => {
    const res = await POST(req({ path: '/etc' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Path escapes project root');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a ../ traversal that escapes the project root without spawning', async () => {
    const res = await POST(req({ path: '../../../../etc/passwd' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Path escapes project root');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('opens a directory inside the project root', async () => {
    const res = await POST(req({ path: 'assets' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.opened).toBe(path.join(projectRootReal, 'assets'));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    // First spawn arg is the file-manager binary; second is the [dir] array.
    const [, args] = mocks.spawn.mock.calls[0];
    expect(args).toContain(path.join(projectRootReal, 'assets'));
  });

  it('opens the containing directory when the inside path is a file', async () => {
    const res = await POST(req({ path: 'assets/a.png' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.opened).toBe(path.join(projectRootReal, 'assets'));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('returns the 400 missing-project envelope when no project resolves', async () => {
    mocks.resolveRequestProjectRoot.mockResolvedValueOnce(null);
    const res = await POST(req({ path: 'assets' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('선택된 덱이 없습니다');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a missing path body without spawning', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('path (string) is required');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
