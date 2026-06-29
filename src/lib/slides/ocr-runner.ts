/**
 * ocr-runner — compile (once) and invoke the Apple Vision OCR helper.
 *
 * Apple Vision (VNRecognizeTextRequest) is local, free, on-device, and reads
 * Korean + Latin with precise bounding boxes — the primitive that lets us detect
 * and place text regions (resolving the "SAM3 can't read text" blocker). The
 * Swift source is bundled in scripts/; we swiftc it to the runtime dir on first
 * use and cache the binary.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, stat } from 'node:fs/promises';
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

/** Run OCR on an image file, returning detected lines with pixel bboxes. */
export async function runOcr(imagePath: string, env: NodeJS.ProcessEnv = process.env): Promise<OcrResult> {
  const binary = await ensureOcrBinary(env);
  const { stdout } = await execFileAsync(binary, [imagePath], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as OcrResult;
  if (!Array.isArray(parsed.lines)) throw new Error('OCR returned no lines array');
  return parsed;
}
