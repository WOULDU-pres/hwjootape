/**
 * Decomposition heuristics — turn OCR results + the user's outline into a SlideSpec.
 *
 * Apple Vision OCR gives us, per text region: the string (often garbled for CJK,
 * so NOT trusted for content) and a precise pixel bbox + height (reliable). We map
 * regions to the authoritative outline by geometry:
 *   - title  = the largest-height region (fallback: topmost)
 *   - bullets = remaining regions, top->bottom, zipped to outline.bullets in order
 * Font size is derived from bbox HEIGHT (geometry, not glyph reading — sidesteps
 * M4: you can't read garbled Hangul, but you can measure how tall it was).
 * Every OCR region is returned in `wipeBoxes` so the baked draft text can be
 * erased before editable boxes are placed on top.
 */
import type { SlideSpec, TextElement, NBBox } from './spec';

export interface OcrBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBBox;
}

export interface DraftDims {
  width: number;
  height: number;
}

export interface SlideOutlineInput {
  title?: string;
  bullets?: string[];
}

export interface DecomposeResult {
  spec: SlideSpec;
  /** All OCR region bboxes (pixel coords) to wipe from the draft background. */
  wipeBoxes: OcrBBox[];
}

const TITLE_COLOR = '#1a3a8f';
const BODY_COLOR = '#222222';
const SLIDE_H_PT = 540; // 7.5in * 72

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function toNBBox(b: OcrBBox, dims: DraftDims): NBBox {
  return {
    x: clamp01(dims.width ? b.x / dims.width : 0),
    y: clamp01(dims.height ? b.y / dims.height : 0),
    w: clamp01(dims.width ? b.width / dims.width : 0),
    h: clamp01(dims.height ? b.height / dims.height : 0),
  };
}

function fontPtFromHeight(b: OcrBBox, dims: DraftDims): number {
  if (!dims.height) return 24;
  const pt = (b.height / dims.height) * SLIDE_H_PT;
  return Math.round(Math.max(10, Math.min(80, pt)));
}

/** Default-positioned box for an outline item that has no matching OCR region. */
function fallbackNBBox(index: number, isTitle: boolean): NBBox {
  if (isTitle) return { x: 0.06, y: 0.08, w: 0.88, h: 0.14 };
  // Cap y so many bullets without OCR regions still land on-slide.
  return { x: 0.06, y: Math.min(0.9, 0.3 + index * 0.1), w: 0.6, h: 0.08 };
}

/**
 * Build a SlideSpec from an EXPLICIT assignment of OCR regions to outline items:
 * `titleLine` is the region for the title (or null → fallback position) and
 * `bodyLines[i]` is the region for bullet i (or null → fallback). This is the single
 * spec-building path shared by the geometry heuristic (`decomposeToSpec`) and the
 * gpt-5.5 mapping (`text-mapping.ts`) — only the assignment differs between them.
 */
export function buildSpecFromAssignment(input: {
  slideId: string;
  outline: SlideOutlineInput;
  titleLine: OcrLine | null;
  bodyLines: Array<OcrLine | null>;
  draftDims: DraftDims;
  draftAssetId?: string;
}): SlideSpec {
  const { slideId, outline, titleLine, bodyLines, draftDims, draftAssetId } = input;
  const elements: TextElement[] = [];

  const titleText = outline.title?.trim();
  if (titleText) {
    const nbbox = titleLine ? toNBBox(titleLine.bbox, draftDims) : fallbackNBBox(0, true);
    elements.push({
      id: 't-title',
      type: 'text',
      role: 'title',
      text: titleText,
      nbbox,
      color: TITLE_COLOR,
      fontSizePt: titleLine ? fontPtFromHeight(titleLine.bbox, draftDims) : 40,
      bold: true,
      align: 'left',
      ocrText: titleLine?.text,
      z: 10,
    });
  }

  const bullets = outline.bullets ?? [];
  bullets.forEach((bullet, i) => {
    const region = bodyLines[i] ?? null;
    const nbbox = region ? toNBBox(region.bbox, draftDims) : fallbackNBBox(i, false);
    elements.push({
      id: `t-bullet-${i}`,
      type: 'text',
      role: 'bullet',
      text: bullet,
      nbbox,
      color: BODY_COLOR,
      fontSizePt: region ? fontPtFromHeight(region.bbox, draftDims) : 22,
      bold: false,
      align: 'left',
      ocrText: region?.text,
      z: 10,
    });
  });

  return {
    slideId,
    draftDims,
    outline: { title: outline.title, bullets },
    draftAssetId,
    approved: false,
    background: null,
    elements,
  };
}

export function decomposeToSpec(input: {
  slideId: string;
  outline: SlideOutlineInput;
  ocrLines: OcrLine[];
  draftDims: DraftDims;
  draftAssetId?: string;
}): DecomposeResult {
  const { slideId, outline, ocrLines, draftDims, draftAssetId } = input;
  const lines = [...ocrLines].sort((a, b) => a.bbox.y - b.bbox.y);
  const wipeBoxes = lines.map((l) => l.bbox);

  // Geometry assignment: title = largest-height region; bullets = remaining top->bottom.
  let titleLine: OcrLine | null = null;
  if (lines.length) {
    titleLine = lines.reduce((max, l) => (l.bbox.height > max.bbox.height ? l : max), lines[0]);
  }
  const bodyLines = lines.filter((l) => l !== titleLine);
  const bullets = outline.bullets ?? [];

  const spec = buildSpecFromAssignment({
    slideId,
    outline,
    titleLine,
    bodyLines: bullets.map((_, i) => bodyLines[i] ?? null),
    draftDims,
    draftAssetId,
  });

  return { spec, wipeBoxes };
}
