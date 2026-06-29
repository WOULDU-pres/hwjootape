/**
 * SlideSpec — the spine of the deck generator.
 *
 * One spec per slide; a deck is SlideSpec[]. Coordinates are NORMALIZED [0,1]
 * relative to the slide, because god-tibo ignores the `size` param and returns
 * arbitrary draft dimensions (empirically: a "16:9 widescreen" prompt yields
 * AR ~1.777 but pixel dims like 1672x941). Normalizing against the actual draft
 * dims and mapping onto a fixed 16:9 slide keeps placement correct regardless.
 *
 * Authoring specs reference assets by id (resolved via the project asset store);
 * a ResolvedDeck (absolute paths, final text) is what the python sidecars consume.
 */

// 16:9 slide in EMU (13.333" x 7.5").
export const SLIDE_W_EMU = 12192000;
export const SLIDE_H_EMU = 6858000;

export type TextAlign = 'left' | 'center' | 'right';
export type TextRole = 'title' | 'subtitle' | 'bullet' | 'caption' | 'other';

/** Normalized bounding box, each field in [0,1] relative to the slide. */
export interface NBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextElement {
  id: string;
  type: 'text';
  role: TextRole;
  /** Final text (authoritative, from the user's outline). */
  text: string;
  nbbox: NBBox;
  color?: string;
  fontSizePt?: number;
  bold?: boolean;
  align?: TextAlign;
  /** Latin font face. */
  font?: string;
  /** East-Asian font face (Hangul). */
  fontEA?: string;
  z?: number;
  /** Raw OCR string for this region (debug / mapping aid; not used for output). */
  ocrText?: string;
}

export interface ImageElement {
  id: string;
  type: 'image';
  nbbox: NBBox;
  /** Regenerated/cutout asset id; resolved to a path for the sidecar. */
  assetId?: string;
  z?: number;
}

export type SlideElement = TextElement | ImageElement;

export interface SlideBackground {
  assetId?: string;
}

/** A solid-color band (e.g. a title underline or a side rail) painted behind the
 *  elements. nbbox is normalized [0,1]; color is a 6-digit hex (no leading '#'). */
export interface SlideAccentBar {
  nbbox: NBBox;
  color: string;
}

export interface SlideSpec {
  slideId: string;
  /** Actual god-tibo draft pixel dims (informational; coords are normalized). */
  draftDims?: { width: number; height: number };
  outline?: { title?: string; bullets?: string[] };
  draftAssetId?: string;
  approved?: boolean;
  background?: SlideBackground | null;
  /**
   * Solid slide background fill (hex, no leading '#', e.g. "0c0e14"). Orthogonal
   * to the image-asset `background`: this is the theme's `palette.bg` baked in so
   * the renderers fill the whole canvas before drawing elements. Absent = white.
   */
  backgroundColor?: string;
  /** Optional theme accent band, painted behind the elements (above the fill). */
  accentBar?: SlideAccentBar;
  elements: SlideElement[];
}

export type Deck = SlideSpec[];

// ---- Resolved shapes (what the python sidecars consume) ----

export interface ResolvedTextElement {
  type: 'text';
  text: string;
  nbbox: NBBox;
  color?: string;
  fontSizePt?: number;
  bold?: boolean;
  align?: TextAlign;
  font?: string;
  fontEA?: string;
  z?: number;
}

export interface ResolvedImageElement {
  type: 'image';
  path: string;
  nbbox: NBBox;
  z?: number;
}

export interface ResolvedSlide {
  background?: { path: string } | null;
  /** Solid background fill (hex, no leading '#'); sidecars fill the canvas with it
   *  before drawing. Absent = white (the historical default). */
  backgroundColor?: string;
  /** Solid accent band painted above the fill, behind the elements. */
  accentBar?: SlideAccentBar;
  elements: Array<ResolvedTextElement | ResolvedImageElement>;
}

export interface ResolvedDeck {
  slideWidthEmu: number;
  slideHeightEmu: number;
  slides: ResolvedSlide[];
}

const DEFAULT_FONT = 'Pretendard';
const DEFAULT_FONT_EA = 'Apple SD Gothic Neo';

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function normalizeBBox(b: NBBox | undefined | null): NBBox {
  if (!b) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: clamp01(b.x), y: clamp01(b.y), w: clamp01(b.w), h: clamp01(b.h) };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateSlideSpec(spec: SlideSpec): ValidationResult {
  const errors: string[] = [];
  if (!spec.slideId) errors.push('slideId is required');
  if (!Array.isArray(spec.elements)) errors.push('elements must be an array');
  for (const [i, el] of (spec.elements ?? []).entries()) {
    if (el.type !== 'text' && el.type !== 'image') errors.push(`element ${i}: invalid type`);
    if (!el.nbbox) errors.push(`element ${i}: nbbox is required`);
    if (el.type === 'text' && !el.text?.trim()) errors.push(`element ${i}: text element has empty text`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve an authoring deck to the sidecar input. `resolveAsset` maps an assetId
 * to an absolute file path (project asset store, or identity for headless tests).
 * Text elements get default Korean fonts unless overridden. Image elements with
 * no resolvable asset are dropped (caller decides fallback upstream).
 */
export function resolveDeck(
  deck: Deck,
  resolveAsset: (assetId: string) => string | null,
): ResolvedDeck {
  const slides: ResolvedSlide[] = deck.map((spec) => {
    const elements: ResolvedSlide['elements'] = [];
    for (const el of spec.elements) {
      if (el.type === 'text') {
        elements.push({
          type: 'text',
          text: el.text,
          nbbox: normalizeBBox(el.nbbox),
          color: el.color,
          fontSizePt: el.fontSizePt,
          bold: el.bold,
          align: el.align ?? 'left',
          font: el.font ?? DEFAULT_FONT,
          fontEA: el.fontEA ?? DEFAULT_FONT_EA,
          z: el.z,
        });
      } else {
        const path = el.assetId ? resolveAsset(el.assetId) : null;
        if (!path) continue;
        elements.push({ type: 'image', path, nbbox: normalizeBBox(el.nbbox), z: el.z });
      }
    }
    const bgPath = spec.background?.assetId ? resolveAsset(spec.background.assetId) : null;
    const slide: ResolvedSlide = { background: bgPath ? { path: bgPath } : null, elements };
    if (spec.backgroundColor) slide.backgroundColor = spec.backgroundColor;
    if (spec.accentBar) slide.accentBar = spec.accentBar;
    return slide;
  });

  return { slideWidthEmu: SLIDE_W_EMU, slideHeightEmu: SLIDE_H_EMU, slides };
}
