/**
 * ocr-runner — detect + read text regions, dispatching by platform.
 *
 * macOS: Apple Vision (VNRecognizeTextRequest) — local, free, on-device, reads
 * Korean + Latin with precise bounding boxes. The Swift source is bundled in
 * scripts/; we swiftc it to the runtime dir on first use and cache the binary.
 *
 * Linux/WSL (+ Windows): PaddleOCR (lang="korean") in an auto-provisioned uv
 * venv, via scripts/paddle-ocr.py. Both backends emit the identical OcrResult
 * JSON, so the rest of the deck pipeline is platform-agnostic.
 */
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, stat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { getRuntimeDir } from '@/lib/projects/paths';
import type { OcrLine } from './heuristics';

const execFileAsync = promisify(execFile);

export interface OcrResult {
  imageWidth: number;
  imageHeight: number;
  lines: OcrLine[];
}

export function getOcrSourcePath(): string {
  return path.resolve(process.cwd(), 'scripts', 'apple-vision-ocr.swift');
}

function getOcrBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getRuntimeDir(env), 'ocr', 'apple-vision-ocr');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isBinaryFresh(binary: string, source: string): Promise<boolean> {
  if (!(await pathExists(binary))) return false;
  try {
    const [b, s] = await Promise.all([stat(binary), stat(source)]);
    return b.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

let compileInFlight: Promise<string> | null = null;

/** Ensure the OCR binary is compiled and up to date; returns its path. */
export async function ensureOcrBinary(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Apple Vision OCR requires macOS.');
  }
  const binary = getOcrBinaryPath(env);
  const source = getOcrSourcePath();

  // Assign the in-flight promise synchronously (before any await) so concurrent
  // callers share one compile instead of racing two swiftc writes. The freshness
  // check lives INSIDE the memoized promise; it is cleared in finally so a later
  // source edit recompiles.
  if (!compileInFlight) {
    compileInFlight = (async () => {
      if (await isBinaryFresh(binary, source)) return binary;
      await mkdir(path.dirname(binary), { recursive: true });
      await execFileAsync('swiftc', ['-O', source, '-o', binary], { timeout: 3 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
      return binary;
    })();
  }
  try {
    return await compileInFlight;
  } finally {
    compileInFlight = null;
  }
}

/** macOS path: run the compiled Apple Vision binary; it prints OcrResult JSON. */
async function runOcrAppleVision(imagePath: string, env: NodeJS.ProcessEnv): Promise<OcrResult> {
  const binary = await ensureOcrBinary(env);
  const { stdout } = await execFileAsync(binary, [imagePath], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as OcrResult;
  if (!Array.isArray(parsed.lines)) throw new Error('OCR returned no lines array');
  return parsed;
}

// ---- Linux/WSL path: PaddleOCR in an auto-provisioned uv venv ----

// Defaults target a shared CUDA 12.6 toolchain (common with the torch SAM3
// venv). Override the index/package for other CUDA tags or a CPU build, e.g.
// BANANATAPE_PADDLE_PACKAGE=paddlepaddle (CPU) or .../cu130/ for CUDA 13.
const PADDLE_PYTHON_VERSION = process.env.BANANATAPE_PADDLE_PYTHON_VERSION || '3.12';
const PADDLE_GPU_INDEX = process.env.BANANATAPE_PADDLE_INDEX_URL || 'https://www.paddlepaddle.org.cn/packages/stable/cu126/';
const PADDLE_FRAMEWORK = process.env.BANANATAPE_PADDLE_PACKAGE || 'paddlepaddle-gpu==3.3.1';

export function getPaddleOcrScript(): string {
  return path.resolve(process.cwd(), 'scripts', 'paddle-ocr.py');
}

function getPaddleInstallDir(env: NodeJS.ProcessEnv): string {
  return path.join(getRuntimeDir(env), 'paddleocr');
}

function getPaddleVenvPython(installDir: string): string {
  return path.join(installDir, '.venv', 'bin', 'python');
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

let paddleVenvReady: Promise<string> | null = null;

/** Ensure a venv with paddlepaddle + paddleocr exists; returns the python path.
 *  Idempotent and process-cached. First run installs deps + downloads the Korean
 *  model, so it can take several minutes. */
export async function ensurePaddleVenv(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (paddleVenvReady) return paddleVenvReady;
  paddleVenvReady = (async () => {
    const installDir = getPaddleInstallDir(env);
    const venvPython = getPaddleVenvPython(installDir);
    if (await pathExists(venvPython)) {
      try {
        await execFileAsync(venvPython, ['-c', 'import paddle, paddleocr'], { timeout: 60_000 });
        return venvPython;
      } catch {
        // fall through to (re)install deps
      }
    }
    const uv = await findUv(env);
    if (!uv) {
      throw new Error(
        'uv (Astral) is required for PaddleOCR. Install once: curl -LsSf https://astral.sh/uv/install.sh | sh',
      );
    }
    await mkdir(installDir, { recursive: true });
    if (!(await pathExists(venvPython))) {
      await execFileAsync(uv, ['venv', '--python', PADDLE_PYTHON_VERSION, path.join(installDir, '.venv')], { timeout: 5 * 60 * 1000 });
    }
    // paddlepaddle wheels live on the PaddlePaddle index (CUDA-tagged); paddleocr
    // + its other deps come from PyPI. Install in two steps so each resolves
    // against the right index.
    await execFileAsync(uv, ['pip', 'install', '--python', venvPython, '--index-url', PADDLE_GPU_INDEX, PADDLE_FRAMEWORK], { timeout: 20 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    await execFileAsync(uv, ['pip', 'install', '--python', venvPython, 'paddleocr'], { timeout: 20 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    await execFileAsync(venvPython, ['-c', 'import paddle, paddleocr'], { timeout: 60_000 });
    return venvPython;
  })();
  try {
    return await paddleVenvReady;
  } catch (error) {
    paddleVenvReady = null;
    throw error;
  }
}

/** Linux/WSL path: run paddle-ocr.py in the venv, writing OcrResult JSON to a
 *  temp file (keeps PaddleOCR's stdout chatter out of the parse). */
async function runOcrPaddle(imagePath: string, env: NodeJS.ProcessEnv): Promise<OcrResult> {
  const python = await ensurePaddleVenv(env);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bananatape-ocr-'));
  const outPath = path.join(dir, 'ocr.json');
  try {
    await execFileAsync(python, [getPaddleOcrScript(), '--input', imagePath, '--output', outPath], {
      timeout: 5 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const parsed = JSON.parse(await readFile(outPath, 'utf8')) as OcrResult;
    if (!Array.isArray(parsed.lines)) throw new Error('OCR returned no lines array');
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run OCR on an image file, returning detected lines with pixel bboxes.
 *  macOS -> Apple Vision; everything else -> PaddleOCR. */
export async function runOcr(imagePath: string, env: NodeJS.ProcessEnv = process.env): Promise<OcrResult> {
  if (process.platform === 'darwin') return runOcrAppleVision(imagePath, env);
  return runOcrPaddle(imagePath, env);
}
