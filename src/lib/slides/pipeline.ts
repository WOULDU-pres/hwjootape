/**
 * pipeline — shipping orchestration for the deck generator, composed from the
 * validated pieces (god-tibo provider, Apple Vision OCR, decomposition heuristics,
 * clean-bg, python pptx/png sidecars). API routes call these; persistence of
 * assets is handled by the routes via the project asset store.
 */
import { generateImage as godTiboGenerate } from '@/lib/providers/god-tibo-provider';
import { runOcr } from './ocr-runner';
import { decomposeToSpec, type OcrLine } from './heuristics';
import type { SlideOutline } from './deck';
import { buildDraftPrompt } from './deck';
import type { SlideSpec } from './spec';

export interface GeneratedDraft {
  /** PNG data URL (caller persists to the project asset store). */
  dataUrl: string;
}

/** Generate a flat 16:9 slide draft via god-tibo. Aspect is driven by the prompt
 *  (the backend ignores the size param); returned pixel dims are arbitrary.
 *  `referenceImages` (data URLs or http(s) URLs) are passed to god-tibo as visual
 *  guidance so the draft can incorporate the user's reference visuals. */
export async function generateSlideDraft(
  outline: SlideOutline,
  styleHint?: string,
  referenceImages?: string[],
): Promise<GeneratedDraft> {
  const images = referenceImages && referenceImages.length > 0 ? referenceImages : undefined;
  const dataUrl = await godTiboGenerate({ prompt: buildDraftPrompt(outline, styleHint), images });
  return { dataUrl };
}

export interface DecomposedSlide {
  spec: SlideSpec;
  wipeBoxes: Array<{ x: number; y: number; width: number; height: number }>;
  ocrLines: OcrLine[];
  draftDims: { width: number; height: number };
}

/** Decompose a draft image into a SlideSpec: OCR the text regions, map them to
 *  the authoritative outline, and collect every region as a wipe box so the baked
 *  text can be erased before editable boxes are placed. */
export async function decomposeDraft(input: {
  slideId: string;
  draftPath: string;
  outline: SlideOutline;
  draftAssetId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DecomposedSlide> {
  const ocr = await runOcr(input.draftPath, input.env);
  const draftDims = { width: ocr.imageWidth, height: ocr.imageHeight };
  const { spec, wipeBoxes } = decomposeToSpec({
    slideId: input.slideId,
    outline: input.outline,
    ocrLines: ocr.lines,
    draftDims,
    draftAssetId: input.draftAssetId,
  });
  return { spec, wipeBoxes, ocrLines: ocr.lines, draftDims };
}
