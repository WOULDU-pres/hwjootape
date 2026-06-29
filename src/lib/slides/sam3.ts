/**
 * sam3 — run local SAM3 (mlx) segmentation for the deck generator.
 *
 * Reuses the magic-layer runner's command resolution (auto-installed mlx on Apple
 * Silicon, or BANANATAPE_SAM3_COMMAND). In the deck pipeline SAM3's role is
 * SECONDARY: it finds non-text IMAGE regions to regenerate; text is handled by
 * Apple Vision OCR. Returns segments with pixel bboxes and optional mask data URLs.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSam3Command } from '@/lib/magic-layer/runner';

const execFileAsync = promisify(execFile);

export interface Sam3Segment {
  id: string;
  label: string;
  bbox: { x: number; y: number; width: number; height: number };
  maskDataUrl?: string;
}

function sanitizeSegments(value: unknown): Sam3Segment[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { segments?: unknown }).segments)
      ? (value as { segments: unknown[] }).segments
      : [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const c = item as { id?: unknown; label?: unknown; bbox?: unknown; box?: unknown; maskDataUrl?: unknown; mask?: unknown };
    const box = (c.bbox ?? c.box) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; w?: unknown; h?: unknown } | undefined;
    if (!box || typeof box !== 'object') return [];
    const x = Number(box.x);
    const y = Number(box.y);
    const width = Number(box.width ?? box.w);
    const height = Number(box.height ?? box.h);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{
      id: typeof c.id === 'string' ? c.id : `sam3-${index + 1}`,
      label: typeof c.label === 'string' ? c.label : `segment ${index + 1}`,
      bbox: { x, y, width, height },
      maskDataUrl: typeof c.maskDataUrl === 'string' ? c.maskDataUrl : (typeof c.mask === 'string' ? c.mask : undefined),
    }];
  });
}

/** Run SAM3 on an image. Returns [] when no backend is available (fallback). */
export async function runSam3Segments(imagePath: string, env: NodeJS.ProcessEnv = process.env): Promise<Sam3Segment[]> {
  const resolved = await resolveSam3Command(env);
  if (!resolved.argv || resolved.argv.length === 0) return [];

  const dir = await mkdtemp(path.join(tmpdir(), 'bananatape-slide-sam3-'));
  const outputPath = path.join(dir, 'segments.json');
  try {
    const [bin, ...configured] = resolved.argv;
    const args = configured.map((a) => a.replaceAll('{input}', imagePath).replaceAll('{output}', outputPath));
    if (!args.some((a) => a.includes(imagePath))) args.push('--input', imagePath);
    if (!args.some((a) => a.includes(outputPath))) args.push('--output', outputPath);
    await execFileAsync(bin, args, { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
    return sanitizeSegments(JSON.parse(await readFile(outputPath, 'utf8')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a base64 data URL to a PNG file; returns the path (or null if not a data URL). */
export async function maskDataUrlToFile(maskDataUrl: string | undefined, outPath: string): Promise<string | null> {
  if (!maskDataUrl) return null;
  const m = maskDataUrl.match(/^data:[^;,]+;base64,(.+)$/);
  if (!m) return null;
  await writeFile(outPath, Buffer.from(m[1], 'base64'));
  return outPath;
}
