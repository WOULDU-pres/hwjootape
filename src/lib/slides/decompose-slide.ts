/**
 * decompose-slide — Phase 4 orchestration (ADR-0002). Takes one chosen full-slide
 * image and turns it into an editable SlideSpec:
 *   1. OCR the image for text-region positions.
 *   2. gpt-5.5 maps those regions to the real outline (geometry fallback on failure).
 *   3. Place the REAL outline text as editable elements at the mapped boxes.
 *   4. Regenerate a clean background plate via god-tibo (original as reference).
 *   5. Regenerate / cut out foreground objects (SAM3 + god-tibo) as image elements.
 *
 * Sidecars + generators + persistence are INJECTED so the composition is unit-testable
 * with zero live calls. Background and object regeneration are non-fatal: a failure in
 * either leaves the slide usable (text always survives), per the graceful-degrade rule.
 */
import type { OcrLine } from './heuristics';
import { buildMappingPrompt, parseTextMapping, decomposeWithMapping } from './text-mapping';
import type { ImageElement, SlideSpec } from './spec';

export interface DecomposeSlideDeps {
  runOcr: (imagePath: string) => Promise<{ imageWidth: number; imageHeight: number; lines: OcrLine[] }>;
  /** gpt-5.5 text-region → outline mapping (raw JSON response). */
  generateLayout: (options: { prompt: string }) => Promise<string>;
  /** god-tibo image generation, used for the clean background plate. */
  generateImage: (options: { prompt: string; images?: string[] }) => Promise<string>;
  /** Regenerate / cut out foreground objects into ready image elements (with assetIds). */
  regenerateObjects: (input: {
    imagePath: string;
    imageDataUrl: string;
    ocrLines: OcrLine[];
    draftDims: { width: number; height: number };
  }) => Promise<ImageElement[]>;
  /** Persist a data URL and return its assetId (used for the background plate). */
  persistImage: (dataUrl: string, label: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DecomposeSlideInput {
  slideId: string;
  slideIndex: number;
  /** Absolute path to the chosen slide image (for OCR / SAM3 sidecars). */
  imagePath: string;
  /** The same image as a data URL (god-tibo background reference + object regen input). */
  imageDataUrl: string;
  outline: { title?: string; bullets?: string[] };
  styleHint?: string;
}

/** Background plate prompt: same style, but stripped of text and foreground graphics. */
export function buildBackgroundPrompt(styleHint?: string): string {
  const lines = [
    'Recreate ONLY the background of this presentation slide as a clean plate.',
    'Keep the same overall style, colors, and mood as the reference image.',
    'STRICT: no text, no letters, no numbers, no foreground icons/illustrations/objects, no charts.',
    'Just the smooth background surface, edge to edge, 16:9 widescreen.',
  ];
  if (styleHint && styleHint.trim()) lines.push(`Style direction: ${styleHint.trim()}.`);
  return lines.join('\n');
}

export async function decomposeSlide(input: DecomposeSlideInput, deps: DecomposeSlideDeps): Promise<SlideSpec> {
  // 1. OCR
  const ocr = await deps.runOcr(input.imagePath);
  const draftDims = { width: ocr.imageWidth, height: ocr.imageHeight };

  // 2. gpt-5.5 mapping (best-effort; geometry fallback if it throws or returns garbage)
  let mapping = null as ReturnType<typeof parseTextMapping>;
  try {
    const raw = await deps.generateLayout({ prompt: buildMappingPrompt(ocr.lines, input.outline) });
    mapping = parseTextMapping(raw, ocr.lines.length, input.outline.bullets?.length ?? 0);
  } catch (error) {
    console.warn(`decompose ${input.slideId}: text mapping failed, using geometry fallback:`, error);
    mapping = null;
  }

  // 3. Real outline text placed at mapped (or geometry-fallback) boxes
  const spec = decomposeWithMapping({
    slideId: input.slideId,
    outline: input.outline,
    ocrLines: ocr.lines,
    draftDims,
    mapping,
  });

  // 4. Clean background plate (non-fatal)
  try {
    const bgDataUrl = await deps.generateImage({
      prompt: buildBackgroundPrompt(input.styleHint),
      images: [input.imageDataUrl],
    });
    const assetId = await deps.persistImage(bgDataUrl, `bg:${input.slideId}`);
    spec.background = { assetId };
  } catch (error) {
    console.warn(`decompose ${input.slideId}: background regeneration failed:`, error);
    spec.background = null;
  }

  // 5. Foreground objects (non-fatal)
  try {
    const objects = await deps.regenerateObjects({
      imagePath: input.imagePath,
      imageDataUrl: input.imageDataUrl,
      ocrLines: ocr.lines,
      draftDims,
    });
    spec.elements.push(...objects);
  } catch (error) {
    console.warn(`decompose ${input.slideId}: object regeneration failed:`, error);
    // leave the slide without object elements
  }

  return spec;
}
