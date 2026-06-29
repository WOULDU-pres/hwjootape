/**
 * layout-types — the contract for the LAYOUT-FIRST deck generator.
 *
 * New pipeline (replaces the lossy "bake a slide -> OCR -> decompose" round-trip):
 *   1. design route: gpt-5.5 designs a `DeckLayout` as JSON from the user outline
 *      (archetype + title + bullets + optional imageZone per slide). PROVEN by the
 *      live spike in scripts/qa-layout-probe.mjs.
 *   2. compose (layoutToSpec): a curated `Theme` places that layout into real,
 *      EDITABLE text — emitting `SlideSpec[]` (see ./spec.ts). Text is authoritative
 *      (straight from the outline); the theme supplies the geometry/typography.
 *   3. imagery route: god-tibo fills ONLY the dedicated `imageZone`(s), appending
 *      `ImageElement`s to the already-composed specs.
 *
 * This module is TYPES ONLY — no runtime logic. It reuses `NBBox` and the spec
 * vocabulary from ./spec.ts rather than redefining geometry/typography units.
 */
import type { NBBox, TextAlign } from './spec';

/**
 * Slide archetypes the layout designer may emit. This exact set was validated in
 * the spike (scripts/qa-layout-probe.mjs ARCHETYPES); gpt-5.5 returned only these
 * and every Theme MUST provide a layout entry for each (see `ArchetypeLayoutMap`).
 *
 * - title:                cover slide (large title, no bullets, no image).
 * - section:              section divider (title only).
 * - bullets:              title + bullet list, no image.
 * - bullets-image-right:  title + bullets on the left, image zone on the right.
 * - quote:                a single emphasized quote/callout line.
 * - closing:              closing / thank-you slide.
 */
export type Archetype =
  | 'title'
  | 'section'
  | 'bullets'
  | 'bullets-image-right'
  | 'quote'
  | 'closing';

/** Dedicated zone god-tibo fills with imagery. Reuses the spec's normalized box. */
export type ImageZone = NBBox;

/**
 * One slide as designed by gpt-5.5 (the JSON shape proven in the spike).
 * `imageZone` is null for text-only archetypes. `bullets` is `[]` for archetypes
 * that carry no list (title/section/quote/closing).
 */
export interface SlideLayout {
  archetype: Archetype;
  title: string;
  bullets: string[];
  imageZone: ImageZone | null;
  /** Optional speaker note / design intent; not rendered onto the slide. */
  notes?: string;
}

/** The full deck as designed by gpt-5.5, before a Theme is applied. */
export interface DeckLayout {
  slides: SlideLayout[];
}

// ---- Theme: the curated, data-driven design layer ----

/** Theme palette. All values are 6-digit hex strings WITHOUT a leading `#`
 *  (e.g. "1a3a8f") — matches what `TextElement.color` / build-pptx.py /
 *  render-png.py expect (both `.lstrip("#")`, so a leading `#` is tolerated too). */
export interface ThemePalette {
  /** Slide background fill. */
  bg: string;
  /** Primary foreground / body text. */
  fg: string;
  /** Accent (titles, accent bars, emphasis). */
  accent: string;
  /** Muted / secondary text. */
  muted: string;
}

/** Theme typography. Maps onto `TextElement.font` (Latin) and `.fontEA` (Hangul). */
export interface ThemeFonts {
  /** Latin font face -> TextElement.font. */
  latin: string;
  /** East-Asian (Hangul) font face -> TextElement.fontEA. */
  ea: string;
}

/**
 * Styling for one text block (title or body) within an archetype. The box is a
 * normalized `NBBox`; color is a palette hex; the rest map 1:1 onto `TextElement`.
 */
export interface TextBlockStyle {
  /** Normalized placement on the slide. */
  nbbox: NBBox;
  /** Hex color (no leading `#`), typically drawn from the palette. */
  color: string;
  fontSizePt: number;
  align: TextAlign;
  /** Optional bold flag -> TextElement.bold. */
  bold?: boolean;
}

/**
 * A solid-color band the compose step may emit as a design accent (e.g. a top
 * title bar or a side rail). NOTE: the current python sidecars (build-pptx.py /
 * render-png.py) render ONLY `text` elements, `image` elements, and a full-slide
 * `background` picture — they have NO rectangle primitive. So an `AccentBar` is
 * THEME DATA describing intent; compose cannot turn it into a renderable element
 * today. It is consumed by the imagery route (which CAN bake the bg fill + accent
 * bar into a full-slide background PNG) or reserved for a future `rect` element /
 * sidecar shape support. compose itself must not emit an unsupported element.
 */
export interface AccentBar {
  nbbox: NBBox;
  /** Hex color (no leading `#`). */
  color: string;
}

/**
 * Background spec for an archetype. `bgColor` is the solid slide fill; `accentBar`
 * is optional. Neither is renderable through the existing element types — see the
 * `AccentBar` note. compose leaves `SlideSpec.background` null (no asset yet) and
 * carries this intent forward to the imagery route, which paints the actual
 * full-slide background asset.
 */
export interface ArchetypeBackground {
  /** Solid background fill, hex (no leading `#`). Usually `palette.bg`. */
  bgColor: string;
  /** Optional accent band (design intent; baked by the imagery route). */
  accentBar?: AccentBar;
}

/**
 * Per-archetype layout recipe: where the title goes, where the body/bullets go,
 * an optional default image zone (used when the designer omits one but the
 * archetype expects imagery, e.g. bullets-image-right), and the background spec.
 *
 * `body` is optional because some archetypes (title/section/closing) may render
 * only a title.
 */
export interface ArchetypeLayout {
  /** Title text block styling. */
  title: TextBlockStyle;
  /** Body / bullets text block styling (omit for title-only archetypes). */
  body?: TextBlockStyle;
  /** Fallback image zone if `SlideLayout.imageZone` is null but one is wanted. */
  defaultImageZone?: NBBox;
  /** Slide background spec (solid fill + optional accent bar). */
  background: ArchetypeBackground;
}

/** Every archetype maps to exactly one `ArchetypeLayout`. */
export type ArchetypeLayoutMap = {
  [A in Archetype]: ArchetypeLayout;
};

/**
 * A curated, data-driven theme. compose reads `palette` + `fonts` + `layout[archetype]`
 * to place each `SlideLayout` into editable `SlideSpec` text. Add new themes by
 * adding new `Theme` objects (e.g. in a theme registry) — no compose changes needed.
 */
export interface Theme {
  id: string;
  name: string;
  palette: ThemePalette;
  fonts: ThemeFonts;
  /** Per-archetype geometry + typography + background. */
  layout: ArchetypeLayoutMap;
}

/** Registry shape for looking a theme up by id (e.g. from the design route). */
export type ThemeRegistry = Record<string, Theme>;
