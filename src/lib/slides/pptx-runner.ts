/**
 * pptx-runner — invokes the python sidecars (build-pptx.py / render-png.py) that
 * assemble the editable .pptx and the flat PNG safety net.
 *
 * Compositing/flatten must NOT use the browser-only canvas helpers (they throw in
 * the Node runtime), so the server-side export goes through Pillow here. The venv
 * is auto-provisioned with uv, mirroring the SAM3 magic-layer runner pattern.
 */
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { getRuntimeDir } from '@/lib/projects/paths';
import type { ResolvedDeck } from './spec';

const execFileAsync = promisify(execFile);

const PPTX_PYTHON_VERSION = '3.13';
const PPTX_DEPS = ['python-pptx', 'pillow'];

function getInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getRuntimeDir(env), 'pptx');
}

function getVenvPython(installDir: string): string {
  return path.join(installDir, '.venv', 'bin', 'python');
}

export function getBuildPptxScript(): string {
  return path.resolve(process.cwd(), 'scripts', 'build-pptx.py');
}

export function getRenderPngScript(): string {
  return path.resolve(process.cwd(), 'scripts', 'render-png.py');
}

export function getCleanBgScript(): string {
  return path.resolve(process.cwd(), 'scripts', 'clean-bg.py');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function commandExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function findUv(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.BANANATAPE_UV_PATH && (await pathExists(env.BANANATAPE_UV_PATH))) return env.BANANATAPE_UV_PATH;
  for (const candidate of ['uv', path.join(os.homedir(), '.local', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv']) {
    if (path.isAbsolute(candidate)) {
      if (await pathExists(candidate)) return candidate;
    } else if (await commandExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

let venvReady: Promise<string> | null = null;

/** Ensure a python venv with python-pptx + pillow exists; returns the python path.
 *  Idempotent and process-cached. */
export async function ensurePptxVenv(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (venvReady) return venvReady;
  venvReady = (async () => {
    const installDir = getInstallDir(env);
    const venvPython = getVenvPython(installDir);
    // Already provisioned?
    if (await pathExists(venvPython)) {
      try {
        await execFileAsync(venvPython, ['-c', 'import pptx, PIL'], { timeout: 30_000 });
        return venvPython;
      } catch {
        // fall through to (re)install deps
      }
    }
    const uv = await findUv(env);
    if (!uv) {
      throw new Error(
        'uv (Astral) is required to build .pptx. Install once: curl -LsSf https://astral.sh/uv/install.sh | sh',
      );
    }
    await mkdir(installDir, { recursive: true });
    if (!(await pathExists(venvPython))) {
      await execFileAsync(uv, ['venv', '--python', PPTX_PYTHON_VERSION, path.join(installDir, '.venv')], { timeout: 5 * 60 * 1000 });
    }
    await execFileAsync(uv, ['pip', 'install', '--python', venvPython, ...PPTX_DEPS], { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    await execFileAsync(venvPython, ['-c', 'import pptx, PIL'], { timeout: 30_000 });
    return venvPython;
  })();
  try {
    return await venvReady;
  } catch (error) {
    venvReady = null;
    throw error;
  }
}

async function writeSpecTmp(deck: ResolvedDeck, projectTmpDir: string): Promise<string> {
  await mkdir(projectTmpDir, { recursive: true });
  const specPath = path.join(projectTmpDir, `deck-${process.pid}-${Date.now()}.json`);
  await writeFile(specPath, JSON.stringify(deck), 'utf8');
  return specPath;
}

/** Wipe baked-in draft text (pixel bboxes) so editable boxes can sit on a clean
 *  background. Uses the pptx venv (Pillow). Returns the cleaned image path. */
export async function cleanBackground(
  draftPath: string,
  wipeBoxes: Array<{ x: number; y: number; width: number; height: number }>,
  options: { outPath: string; tmpDir: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const env = options.env ?? process.env;
  const python = await ensurePptxVenv(env);
  await mkdir(options.tmpDir, { recursive: true });
  const boxesPath = path.join(options.tmpDir, `wipe-${process.pid}-${Date.now()}.json`);
  await writeFile(boxesPath, JSON.stringify(wipeBoxes), 'utf8');
  await mkdir(path.dirname(options.outPath), { recursive: true });
  try {
    await execFileAsync(python, [getCleanBgScript(), draftPath, boxesPath, options.outPath], {
      timeout: 2 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } finally {
    await rm(boxesPath, { force: true });
  }
  return options.outPath;
}

export interface ExportResult {
  pptxPath: string;
  pngPaths: string[];
}

/** Build the .pptx and flatten PNG(s) for a resolved deck. Returns output paths. */
export async function exportDeck(
  deck: ResolvedDeck,
  options: { outDir: string; tmpDir: string; baseName?: string; pngWidth?: number; env?: NodeJS.ProcessEnv },
): Promise<ExportResult> {
  const env = options.env ?? process.env;
  const python = await ensurePptxVenv(env);
  const specPath = await writeSpecTmp(deck, options.tmpDir);
  const base = options.baseName ?? 'deck';
  await mkdir(options.outDir, { recursive: true });
  const pptxPath = path.join(options.outDir, `${base}.pptx`);
  const pngPath = path.join(options.outDir, `${base}.png`);

  try {
    await execFileAsync(python, [getBuildPptxScript(), specPath, pptxPath], { timeout: 2 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    await execFileAsync(python, [getRenderPngScript(), specPath, pngPath, '--width', String(options.pngWidth ?? 1920)], { timeout: 2 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
  } finally {
    await rm(specPath, { force: true });
  }

  const pngPaths = deck.slides.map((_, i) =>
    i === 0 ? pngPath : path.join(options.outDir, `${base}-${i + 1}.png`),
  );
  return { pptxPath, pngPaths };
}
