/**
 * regenerate — regenerate non-text image elements via god-tibo (full regeneration,
 * NOT crop). Per user direction (2026-06-29): crop-based cutouts read as pasted /
 * unnatural, so we ALWAYS redraw each element instead of placing the raw cutout.
 *
 * Flow per slide: SAM3 finds candidate regions -> drop any overlapping an OCR text
 * box (text handled separately) -> for each region: crop a masked cutout (used ONLY
 * as the img2img reference so god-tibo knows what to draw) -> god-tibo regenerates
 * the element on a solid white background -> `keyout` makes that flat background
 * transparent so it composites cleanly over the slide's background plate.
 *
 * Trade-off (accepted): dropping the old fidelity gate means a regenerated element
 * can drift from the original (god-tibo has no mask/strength control). The raw cutout
 * is kept ONLY as a last resort when god-tibo fails outright, so an element is never
 * silently lost.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { generateImage as godTiboGenerate } from '@/lib/providers/god-tibo-provider';
import { ensurePptxVenv } from './pptx-runner';
import { runSam3Segments, maskDataUrlToFile, type Sam3Segment } from './sam3';
import type { OcrLine } from './heuristics';
import type { NBBox } from './spec';

const execFileAsync = promisify(execFile);

const MAX_IMAGE_REGIONS = 12;
const GODTIBO_TIMEOUT_MS = 60_000;
const REGEN_PROMPT =
  'Recreate this single graphic/illustration element exactly as shown: same subject, ' +
  'art style, colors, and shape. Center it with generous margin on a SOLID PURE WHITE ' +
  '(#ffffff) background — no gradient, no shadow, no other background color. No text. ' +
  'It will be cut out and placed into a presentation slide.';

function elementOpsScript(): string {
  return path.resolve(process.cwd(), 'scripts', 'element-ops.py');
}

/** Fraction of `inner` area covered by `outer`. */
function overlapRatio(inner: Sam3Segment['bbox'], outer: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.width, outer.x + outer.width);
  const y1 = Math.min(inner.y + inner.height, outer.y + outer.height);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const area = inner.width * inner.height;
  return area > 0 ? (w * h) / area : 0;
}

/** Segments that are NOT text (don't substantially overlap any OCR region). */
export function detectImageRegions(segments: Sam3Segment[], ocrLines: OcrLine[], textOverlap = 0.4): Sam3Segment[] {
  return segments.filter((seg) => !ocrLines.some((line) => overlapRatio(seg.bbox, line.bbox) > textOverlap));
}

export interface ImageElementResult {
  pngPath: string;
  nbbox: NBBox;
  z: number;
  source: 'regen' | 'raw';
  fidelity: number;
  label: string;
}

export interface RegenInput {
  draftPath: string;
  ocrLines: OcrLine[];
  dims: { width: number; height: number };
  workDir: string;
  segments?: Sam3Segment[];
  fidelityThreshold?: number;
  env?: NodeJS.ProcessEnv;
}

export async function regenerateImageElements(input: RegenInput): Promise<ImageElementResult[]> {
  const env = input.env ?? process.env;
  const python = await ensurePptxVenv(env);
  await mkdir(input.workDir, { recursive: true });

  const segments = input.segments ?? (await runSam3Segments(input.draftPath, env));
  const allRegions = detectImageRegions(segments, input.ocrLines);
  const regions = allRegions.slice(0, MAX_IMAGE_REGIONS);
  if (allRegions.length > regions.length) {
    console.warn(`regenerate: capping image regions ${allRegions.length} -> ${MAX_IMAGE_REGIONS}`);
  }
  const results: ImageElementResult[] = [];

  for (const [i, region] of regions.entries()) {
    const { x, y, width, height } = region.bbox;
    const cutoutPath = path.join(input.workDir, `cutout-${i}.png`);
    const maskPath = await maskDataUrlToFile(region.maskDataUrl, path.join(input.workDir, `mask-${i}.png`));

    // The masked cutout is only the img2img REFERENCE (what to redraw), never the
    // shipped element — and the last-resort fallback if god-tibo fails.
    const cropArgs = [elementOpsScript(), 'crop', input.draftPath, cutoutPath, '--bbox', `${x},${y},${width},${height}`];
    if (maskPath) cropArgs.push('--mask', maskPath);
    await execFileAsync(python, cropArgs, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });

    const nbbox: NBBox = {
      x: input.dims.width ? x / input.dims.width : 0,
      y: input.dims.height ? y / input.dims.height : 0,
      w: input.dims.width ? width / input.dims.width : 0,
      h: input.dims.height ? height / input.dims.height : 0,
    };

    // Always regenerate, then key out the white background so the redrawn element
    // composites cleanly. Fall back to the raw cutout only if god-tibo fails.
    let chosen = cutoutPath;
    let source: 'regen' | 'raw' = 'raw';
    try {
      const cutoutBuf = await readFile(cutoutPath);
      const regenDataUrl = await godTiboGenerate({
        prompt: REGEN_PROMPT,
        images: [`data:image/png;base64,${cutoutBuf.toString('base64')}`],
        // god-tibo-provider has no built-in timeout; bound the network call.
        fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(GODTIBO_TIMEOUT_MS) }),
      });
      const m = regenDataUrl.match(/^data:[^;,]+;base64,(.+)$/);
      if (m) {
        const regenPath = path.join(input.workDir, `regen-${i}.png`);
        await writeFile(regenPath, Buffer.from(m[1], 'base64'));
        const keyedPath = path.join(input.workDir, `keyed-${i}.png`);
        await execFileAsync(python, [elementOpsScript(), 'keyout', regenPath, keyedPath], { timeout: 60_000 });
        chosen = keyedPath;
        source = 'regen';
      }
    } catch (error) {
      console.warn(`regenerate: god-tibo regen failed for region ${i} (${region.label}), keeping cutout:`, error);
      source = 'raw';
    }

    results.push({ pngPath: chosen, nbbox, z: 5, source, fidelity: source === 'regen' ? 0 : 1, label: region.label });
  }

  return results;
}
