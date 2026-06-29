/**
 * text-mapping — gpt-5.5 mapping of decomposed OCR regions to the authoritative
 * outline (ADR-0002). When codex designs slides autonomously, the geometry heuristic
 * ("title = tallest region") misassigns; instead we ask gpt-5.5 which OCR box is the
 * title and which boxes are which bullets, using box POSITIONS + the (garbled) text
 * as cues. Korean OCR text is unreliable, so the model leans on layout — but it has
 * strictly more signal than pure geometry (it sees the outline AND all box positions).
 *
 * The LLM call lives behind `generateLayout` (injected). This module is pure: it only
 * builds the prompt, parses/validates the response, and applies the assignment via the
 * shared `buildSpecFromAssignment`. Any parse/format failure falls back to geometry.
 */
import type { OcrLine, SlideOutlineInput, DraftDims } from './heuristics';
import { buildSpecFromAssignment, decomposeToSpec } from './heuristics';
import type { SlideSpec } from './spec';

export interface TextMapping {
  /** Index into ocrLines for the title, or null if no region matches. */
  titleIndex: number | null;
  /** Index into ocrLines for each bullet (aligned to outline.bullets), null if none. */
  bulletIndices: Array<number | null>;
}

function stripCodeFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function inRange(v: unknown, count: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : null;
}

/**
 * Parse the gpt-5.5 mapping response into a validated TextMapping. Indices are
 * range-checked against `ocrCount`; `bulletBoxes` is padded/truncated to `bulletCount`.
 * Returns null when the payload can't be parsed or lacks the expected shape, so the
 * caller falls back to geometry.
 */
export function parseTextMapping(raw: string, ocrCount: number, bulletCount: number): TextMapping | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!('titleBox' in obj) || !('bulletBoxes' in obj)) return null;
  if (!Array.isArray(obj.bulletBoxes)) return null;

  // Enforce single-use (the prompt promises "each OCR box at most once"): the title
  // claims its box first, then bullets in order; a box already taken falls back to
  // null → fallbackNBBox, mirroring the geometry path's `lines.filter(!= titleLine)`.
  const used = new Set<number>();
  const take = (v: unknown): number | null => {
    const idx = inRange(v, ocrCount);
    if (idx === null || used.has(idx)) return null;
    used.add(idx);
    return idx;
  };
  const titleIndex = take(obj.titleBox);
  const bulletIndices: Array<number | null> = [];
  for (let i = 0; i < bulletCount; i++) bulletIndices.push(take(obj.bulletBoxes[i]));
  return { titleIndex, bulletIndices };
}

/** Build the gpt-5.5 prompt: outline + OCR boxes (index, normalized-ish position, text). */
export function buildMappingPrompt(ocrLines: OcrLine[], outline: SlideOutlineInput): string {
  const boxes = ocrLines
    .map(
      (l, i) =>
        `  ${i}: x=${Math.round(l.bbox.x)} y=${Math.round(l.bbox.y)} w=${Math.round(l.bbox.width)} h=${Math.round(
          l.bbox.height,
        )} text="${l.text}"`,
    )
    .join('\n');
  const bullets = (outline.bullets ?? []).map((b, i) => `  ${i}: ${b}`).join('\n');
  return [
    'You are mapping OCR text regions of a slide image to the slide\'s real outline.',
    'The OCR text may be garbled (especially Korean) — rely on POSITION and SIZE as much as the text.',
    '',
    `Title: ${outline.title ?? ''}`,
    'Bullets (by index):',
    bullets || '  (none)',
    '',
    'OCR boxes (by index, pixel coords):',
    boxes || '  (none)',
    '',
    'Return ONLY JSON: {"titleBox": <ocr index or null>, "bulletBoxes": [<ocr index or null>, ... one per bullet in order]}.',
    'Use each OCR box at most once. Use null when no box matches an outline item.',
  ].join('\n');
}

/**
 * Decompose using an explicit mapping when available, else geometry. Returns the
 * SlideSpec (text elements with the REAL outline text placed at the mapped/fallback
 * boxes). Background/image elements are added later by the imagery/decompose route.
 */
export function decomposeWithMapping(input: {
  slideId: string;
  outline: SlideOutlineInput;
  ocrLines: OcrLine[];
  draftDims: DraftDims;
  mapping: TextMapping | null;
  draftAssetId?: string;
}): SlideSpec {
  const { slideId, outline, ocrLines, draftDims, mapping, draftAssetId } = input;
  if (!mapping) {
    return decomposeToSpec({ slideId, outline, ocrLines, draftDims, draftAssetId }).spec;
  }
  const at = (idx: number | null) => (idx === null ? null : ocrLines[idx] ?? null);
  return buildSpecFromAssignment({
    slideId,
    outline,
    titleLine: at(mapping.titleIndex),
    bodyLines: mapping.bulletIndices.map(at),
    draftDims,
    draftAssetId,
  });
}
