import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, access, stat, rm } from 'node:fs/promises';
import { getRuntimeDir } from '@/lib/projects/paths';

const execFileAsync = promisify(execFile);

const MLX_SAM3_REPO_URL = 'https://github.com/Deekshith-Dade/mlx_sam3.git';
const MLX_SAM3_REPO_REF = 'main';
const MLX_SAM3_PYTHON_VERSION = '3.13';
const MLX_SAM3_LEAN_DEPS = [
  'mlx>=0.30.0',
  'numpy>=2.3.5',
  'pillow>=12.0.0',
  'torch>=2.9.1',
  'torchvision>=0.24.1',
  'huggingface-hub>=1.1.6',
  'ftfy>=6.3.1',
  'regex>=2025.11.3',
  'iopath>=0.1.10',
];
const INSTALL_MANIFEST_VERSION = 1;
const STALE_LOCK_MS = 60 * 60 * 1000;

export type Sam3Source = 'env' | 'auto-mlx' | 'fallback';

export interface ResolvedSam3Command {
  source: Sam3Source;
  argv: string[] | null;
  reason?: string;
}

export interface InstallManifest {
  installVersion: number;
  installedAt: string;
  pythonVersion: string;
  repoUrl: string;
  repoRef: string;
  deps: string[];
  pythonPath: string;
  scriptPath: string;
}

export interface InstallStatus {
  installed: boolean;
  installing: boolean;
  failed: boolean;
  message: string;
  errorCode?: string;
  startedAt?: string;
  updatedAt?: string;
  canFallback: boolean;
}

export function isAutoInstallSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BANANATAPE_DISABLE_AUTO_INSTALL === '1') return false;
  if (env.CI === 'true') return false;
  return process.platform === 'darwin' && process.arch === 'arm64';
}

export function getMlxInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getRuntimeDir(env), 'mlx_sam3');
}

function getVenvPythonPath(installDir: string): string {
  return path.join(installDir, '.venv', 'bin', 'python');
}

function getManifestPath(installDir: string): string {
  return path.join(installDir, 'install.json');
}

function getLockPath(installDir: string): string {
  return path.join(installDir, 'install.lock');
}

function getStatusPath(installDir: string): string {
  return path.join(installDir, 'status.json');
}

function getInstallLogPath(installDir: string): string {
  return path.join(installDir, 'install.log');
}

export function getBundledMlxScriptPath(): string {
  return path.resolve(process.cwd(), 'scripts', 'sam3-magic-layer-mlx.py');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(installDir: string): Promise<InstallManifest | null> {
  try {
    const raw = await readFile(getManifestPath(installDir), 'utf8');
    const parsed = JSON.parse(raw) as InstallManifest;
    if (parsed.installVersion !== INSTALL_MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeStatus(installDir: string, status: InstallStatus): Promise<void> {
  await mkdir(installDir, { recursive: true });
  const tmp = `${getStatusPath(installDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(status, null, 2), 'utf8');
  await rename(tmp, getStatusPath(installDir));
}

async function readStatus(installDir: string): Promise<InstallStatus | null> {
  try {
    const raw = await readFile(getStatusPath(installDir), 'utf8');
    return JSON.parse(raw) as InstallStatus;
  } catch {
    return null;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const s = await stat(lockPath);
    return Date.now() - s.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

async function acquireLock(installDir: string): Promise<boolean> {
  await mkdir(installDir, { recursive: true });
  const lockPath = getLockPath(installDir);
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch {
    if (await isLockStale(lockPath)) {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'w' });
      return true;
    }
    return false;
  }
}

async function releaseLock(installDir: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(getLockPath(installDir));
  } catch {
    return;
  }
}

async function appendLog(installDir: string, line: string): Promise<void> {
  try {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(getInstallLogPath(installDir), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    return;
  }
}

async function verifyInstalledManifest(manifest: InstallManifest): Promise<boolean> {
  if (!(await pathExists(manifest.pythonPath))) return false;
  if (!(await pathExists(manifest.scriptPath))) return false;
  try {
    await execFileAsync(manifest.pythonPath, ['-c', 'from sam3 import build_sam3_image_model; from sam3.model.sam3_image_processor import Sam3Processor'], { timeout: 30_000 });
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

export interface InstallAttemptResult {
  status: 'started' | 'already-installing' | 'already-installed' | 'unsupported' | 'missing-uv' | 'failed';
  message: string;
  errorCode?: string;
}

async function performInstall(installDir: string, uvPath: string, scriptPath: string): Promise<void> {
  const venvPython = getVenvPythonPath(installDir);
  const srcDir = path.join(installDir, 'mlx_sam3-src');

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: 'Creating Python 3.13 environment with uv...',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });
  await appendLog(installDir, 'starting install');

  await execFileAsync(uvPath, ['venv', '--python', MLX_SAM3_PYTHON_VERSION, path.join(installDir, '.venv')], { timeout: 5 * 60 * 1000 });

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: 'Installing lean Python dependencies (torch, mlx, ...)',
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });

  await execFileAsync(uvPath, ['pip', 'install', '--python', venvPython, ...MLX_SAM3_LEAN_DEPS], { timeout: 15 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: 'Cloning mlx_sam3 source (preserves bundled BPE tokenizer assets)...',
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });

  await rm(srcDir, { recursive: true, force: true });
  await execFileAsync('git', ['clone', '--depth', '1', '--branch', MLX_SAM3_REPO_REF, MLX_SAM3_REPO_URL, srcDir], { timeout: 5 * 60 * 1000 });

  await execFileAsync(uvPath, ['pip', 'install', '--python', venvPython, '--no-deps', '-e', srcDir], { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

  await execFileAsync(venvPython, ['-c', 'from sam3 import build_sam3_image_model; from sam3.model.sam3_image_processor import Sam3Processor'], { timeout: 60_000 });

  const manifest: InstallManifest = {
    installVersion: INSTALL_MANIFEST_VERSION,
    installedAt: new Date().toISOString(),
    pythonVersion: MLX_SAM3_PYTHON_VERSION,
    repoUrl: MLX_SAM3_REPO_URL,
    repoRef: MLX_SAM3_REPO_REF,
    deps: MLX_SAM3_LEAN_DEPS,
    pythonPath: venvPython,
    scriptPath,
  };
  const tmp = `${getManifestPath(installDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, getManifestPath(installDir));

  await writeStatus(installDir, {
    installed: true,
    installing: false,
    failed: false,
    message: 'mlx_sam3 ready. First Magic Layer run downloads ~3.4GB of model weights.',
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });
  await appendLog(installDir, 'install complete');
}

let inFlight: Promise<void> | null = null;

export async function startInstallInBackground(env: NodeJS.ProcessEnv = process.env): Promise<InstallAttemptResult> {
  if (!isAutoInstallSupported(env)) {
    return { status: 'unsupported', message: 'Auto-install only runs on macOS Apple Silicon.' };
  }

  const installDir = getMlxInstallDir(env);
  const scriptPath = getBundledMlxScriptPath();

  if (!(await pathExists(scriptPath))) {
    return { status: 'failed', message: `Bundled mlx wrapper script not found: ${scriptPath}`, errorCode: 'SCRIPT_MISSING' };
  }

  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return { status: 'already-installed', message: 'mlx_sam3 already installed.' };
  }

  if (inFlight) return { status: 'already-installing', message: 'Install already in progress.' };

  const uvPath = await findUv(env);
  if (!uvPath) {
    return {
      status: 'missing-uv',
      message: 'uv (Astral) is required for auto-install. Install once: curl -LsSf https://astral.sh/uv/install.sh | sh',
      errorCode: 'UV_NOT_FOUND',
    };
  }

  const acquired = await acquireLock(installDir);
  if (!acquired) return { status: 'already-installing', message: 'Another process is installing mlx_sam3.' };

  inFlight = (async () => {
    try {
      await performInstall(installDir, uvPath, scriptPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Install failed';
      await writeStatus(installDir, {
        installed: false,
        installing: false,
        failed: true,
        message: `Install failed: ${message}`,
        errorCode: 'INSTALL_FAILED',
        updatedAt: new Date().toISOString(),
        canFallback: true,
      });
      await appendLog(installDir, `FAILED: ${message}`);
    } finally {
      await releaseLock(installDir);
      inFlight = null;
    }
  })();

  void inFlight;

  return { status: 'started', message: 'mlx_sam3 install started in background.' };
}

export async function readInstallStatus(env: NodeJS.ProcessEnv = process.env): Promise<InstallStatus> {
  const installDir = getMlxInstallDir(env);
  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return {
      installed: true,
      installing: false,
      failed: false,
      message: 'mlx_sam3 ready.',
      updatedAt: manifest.installedAt,
      canFallback: true,
    };
  }
  const persisted = await readStatus(installDir);
  if (persisted) return persisted;
  return {
    installed: false,
    installing: inFlight !== null,
    failed: false,
    message: 'Not installed yet.',
    canFallback: true,
  };
}

export async function resolveSam3Command(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedSam3Command> {
  const explicit = env.BANANATAPE_SAM3_COMMAND?.trim();
  if (explicit) {
    return { source: 'env', argv: explicit.split(/\s+/) };
  }

  if (!isAutoInstallSupported(env)) {
    return {
      source: 'fallback',
      argv: null,
      reason: env.BANANATAPE_DISABLE_AUTO_INSTALL === '1'
        ? 'auto-install disabled via env'
        : `unsupported platform ${process.platform}/${process.arch}`,
    };
  }

  const installDir = getMlxInstallDir(env);
  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return {
      source: 'auto-mlx',
      argv: [manifest.pythonPath, manifest.scriptPath],
    };
  }

  return { source: 'fallback', argv: null, reason: 'auto-mlx not yet installed' };
}
