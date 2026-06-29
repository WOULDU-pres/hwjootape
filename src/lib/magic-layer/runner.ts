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

export type Sam3Source = 'env' | 'auto-mlx' | 'auto-torch' | 'fallback';

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
  if (process.platform === 'darwin' && process.arch === 'arm64') return true; // MLX
  if (process.platform === 'linux') return true; // PyTorch (CUDA/CPU)
  return false;
}

/**
 * Per-platform SAM 3 backend. macOS Apple Silicon runs the MLX port; Linux runs
 * Meta's official PyTorch SAM 3 (same `from sam3 import ...` API). Both install
 * into their own runtime dir + venv so switching platforms never cross-pollutes.
 */
type Sam3Kind = 'mlx' | 'torch';

interface Sam3Profile {
  kind: Sam3Kind;
  source: 'auto-mlx' | 'auto-torch';
  pythonVersion: string;
  installDirName: string;
  repoUrl: string;
  repoRef: string;
  scriptPath: string;
  /** Deps installed from the default (PyPI) index. */
  preDeps: string[];
  /** torch only: install torch/torchvision from the CUDA wheel index first. */
  torchIndexDeps?: string[];
  torchIndexUrl?: string;
  /** mlx installs the source with --no-deps (lean); torch pulls sam3's deps. */
  editableNoDeps: boolean;
}

export function getSam3Profile(env: NodeJS.ProcessEnv = process.env): Sam3Profile {
  if (process.platform === 'linux') {
    return {
      kind: 'torch',
      source: 'auto-torch',
      pythonVersion: env.BANANATAPE_SAM3_PYTHON_VERSION || '3.12',
      installDirName: 'torch_sam3',
      repoUrl: env.BANANATAPE_SAM3_REPO_URL || 'https://github.com/facebookresearch/sam3.git',
      repoRef: env.BANANATAPE_SAM3_REPO_REF || 'main',
      scriptPath: path.resolve(process.cwd(), 'scripts', 'sam3-magic-layer-torch.py'),
      preDeps: ['numpy', 'pillow'],
      torchIndexDeps: ['torch', 'torchvision'],
      torchIndexUrl: env.BANANATAPE_TORCH_INDEX_URL || 'https://download.pytorch.org/whl/cu126',
      editableNoDeps: false,
    };
  }
  // darwin/arm64 (default): MLX port.
  return {
    kind: 'mlx',
    source: 'auto-mlx',
    pythonVersion: MLX_SAM3_PYTHON_VERSION,
    installDirName: 'mlx_sam3',
    repoUrl: MLX_SAM3_REPO_URL,
    repoRef: MLX_SAM3_REPO_REF,
    scriptPath: path.resolve(process.cwd(), 'scripts', 'sam3-magic-layer-mlx.py'),
    preDeps: MLX_SAM3_LEAN_DEPS,
    editableNoDeps: true,
  };
}

export function getSam3InstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getRuntimeDir(env), getSam3Profile(env).installDirName);
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

export function getBundledScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return getSam3Profile(env).scriptPath;
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

async function performInstall(installDir: string, uvPath: string, profile: Sam3Profile): Promise<void> {
  const venvPython = getVenvPythonPath(installDir);
  const srcDir = path.join(installDir, 'sam3-src');

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: `Creating Python ${profile.pythonVersion} environment with uv...`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });
  await appendLog(installDir, `starting ${profile.kind} install`);

  await execFileAsync(uvPath, ['venv', '--python', profile.pythonVersion, path.join(installDir, '.venv')], { timeout: 5 * 60 * 1000 });

  // torch profile: install the CUDA-tagged torch/torchvision from the PyTorch
  // wheel index first, so the editable sam3 install below finds them satisfied
  // and doesn't pull a CPU build from PyPI.
  if (profile.torchIndexDeps && profile.torchIndexDeps.length > 0) {
    await writeStatus(installDir, {
      installed: false,
      installing: true,
      failed: false,
      message: `Installing CUDA PyTorch from ${profile.torchIndexUrl} ...`,
      updatedAt: new Date().toISOString(),
      canFallback: true,
    });
    await execFileAsync(uvPath, ['pip', 'install', '--python', venvPython, '--index-url', profile.torchIndexUrl!, ...profile.torchIndexDeps], { timeout: 20 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
  }

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: profile.kind === 'mlx' ? 'Installing lean Python dependencies (torch, mlx, ...)' : 'Installing Python dependencies...',
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });

  await execFileAsync(uvPath, ['pip', 'install', '--python', venvPython, ...profile.preDeps], { timeout: 15 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

  await writeStatus(installDir, {
    installed: false,
    installing: true,
    failed: false,
    message: `Cloning ${profile.repoUrl} ...`,
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });

  await rm(srcDir, { recursive: true, force: true });
  await execFileAsync('git', ['clone', '--depth', '1', '--branch', profile.repoRef, profile.repoUrl, srcDir], { timeout: 5 * 60 * 1000 });

  const editableArgs = ['pip', 'install', '--python', venvPython, ...(profile.editableNoDeps ? ['--no-deps'] : []), '-e', srcDir];
  await execFileAsync(uvPath, editableArgs, { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });

  await execFileAsync(venvPython, ['-c', 'from sam3 import build_sam3_image_model; from sam3.model.sam3_image_processor import Sam3Processor'], { timeout: 60_000 });

  const manifest: InstallManifest = {
    installVersion: INSTALL_MANIFEST_VERSION,
    installedAt: new Date().toISOString(),
    pythonVersion: profile.pythonVersion,
    repoUrl: profile.repoUrl,
    repoRef: profile.repoRef,
    deps: [...(profile.torchIndexDeps ?? []), ...profile.preDeps],
    pythonPath: venvPython,
    scriptPath: profile.scriptPath,
  };
  const tmp = `${getManifestPath(installDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, getManifestPath(installDir));

  await writeStatus(installDir, {
    installed: true,
    installing: false,
    failed: false,
    message: `SAM 3 (${profile.kind}) ready. First Magic Layer run downloads ~3.4GB of model weights.`,
    updatedAt: new Date().toISOString(),
    canFallback: true,
  });
  await appendLog(installDir, 'install complete');
}

let inFlight: Promise<void> | null = null;

export async function startInstallInBackground(env: NodeJS.ProcessEnv = process.env): Promise<InstallAttemptResult> {
  if (!isAutoInstallSupported(env)) {
    return { status: 'unsupported', message: 'Auto-install runs on macOS Apple Silicon or Linux.' };
  }

  const profile = getSam3Profile(env);
  const installDir = getSam3InstallDir(env);
  const scriptPath = profile.scriptPath;

  if (!(await pathExists(scriptPath))) {
    return { status: 'failed', message: `Bundled SAM 3 wrapper script not found: ${scriptPath}`, errorCode: 'SCRIPT_MISSING' };
  }

  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return { status: 'already-installed', message: `SAM 3 (${profile.kind}) already installed.` };
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
  if (!acquired) return { status: 'already-installing', message: 'Another process is installing SAM 3.' };

  inFlight = (async () => {
    try {
      await performInstall(installDir, uvPath, profile);
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

  return { status: 'started', message: `SAM 3 (${profile.kind}) install started in background.` };
}

export async function readInstallStatus(env: NodeJS.ProcessEnv = process.env): Promise<InstallStatus> {
  const installDir = getSam3InstallDir(env);
  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return {
      installed: true,
      installing: false,
      failed: false,
      message: `SAM 3 (${getSam3Profile(env).kind}) ready.`,
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

  const profile = getSam3Profile(env);
  const installDir = getSam3InstallDir(env);
  const manifest = await readManifest(installDir);
  if (manifest && (await verifyInstalledManifest(manifest))) {
    return {
      source: profile.source,
      argv: [manifest.pythonPath, manifest.scriptPath],
    };
  }

  return { source: 'fallback', argv: null, reason: `${profile.kind} sam3 not yet installed` };
}
