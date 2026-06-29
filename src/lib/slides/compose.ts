/**
 * compose — the THEME step of the layout-first deck generator.
 *
 * `layoutToSpec` maps a `DeckLayout` (designed by gpt-5.5) plus a curated `Theme`
 * into `SlideSpec[]` (see ./spec.ts) — real, EDITABLE text placed by the theme's
 * per-archetype geometry/typography. The text is authoritative (straight from the
 * layout, which carries the outline); the theme supplies box/color/font/size.
 *
 * BACKGROUND (spec.ts: SlideSpec.backgroundColor + accentBar): the theme's
 * per-archetype `background.bgColor` is baked onto each spec as `backgroundColor`
 * (a solid hex fill) and its optional `accentBar` is carried through verbatim.
 * The python sidecars (scripts/render-png.py + scripts/build-pptx.py) fill the
 * canvas with `backgroundColor` and paint `accentBar` as a solid rectangle before
 * drawing elements — so the dark/warm themes now export with the right field.
 * The image-asset `background` stays null here: any full-slide background PICTURE
 * is still owned by the imagery route; this is only the solid color + accent band.
 *
 * compose also does NOT add image elements: the dedicated `imageZone` is carried
 * forward via the `DeckLayout` so the imagery route can generate the asset and
 * APPEND an `ImageElement`. compose emits a text-only spec.
 *
 * Bullets are emitted as ONE text element whose lines are joined by '\n' (the
 * sidecars split on '\n', one paragraph/line per split) with a leading '• '
 * glyph per line (the sidecars add no bullet markers, so compose includes them).
 */
import type { ArchetypeLayout, DeckLayout, Theme } from './layout-types';
import type { SlideElement, SlideSpec, TextElement } from './spec';

const BULLET_GLYPH = '•';

/**
 * Build the BODY text element's text from bullets: one line per bullet, each
 * prefixed with the bullet glyph, joined by '\n' (the unit the sidecars split on).
 */
export function formatBulletsText(bullets: string[]): string {
  return bullets.map((b) => `${BULLET_GLYPH} ${b}`).join('\n');
}

/** Compose a single `SlideLayout` (at index `i`) into a text-only `SlideSpec`. */
function composeSlide(
  layout: DeckLayout,
  theme: Theme,
  i: number,
): SlideSpec {
  const L = layout.slides[i];
  const A: ArchetypeLayout = theme.layout[L.archetype];

  const elements: SlideElement[] = [];

  // TITLE — always emitted. z:10 keeps text above any (future) background.
  const title: TextElement = {
    id: `t-${i}`,
    type: 'text',
    role: 'title',
    text: L.title,
    nbbox: A.title.nbbox,
    color: A.title.color,
    fontSizePt: A.title.fontSizePt,
    align: A.title.align,
    font: theme.fonts.latin,
    fontEA: theme.fonts.ea,
    z: 10,
  };
  if (A.title.bold !== undefined) title.bold = A.title.bold;
  elements.push(title);

  // BODY / BULLETS — only when the archetype defines a body box AND there are
  // bullets. Skipping (rather than emitting empty text) keeps validateSlideSpec
  // happy, which rejects empty/whitespace-only text elements.
  if (A.body && L.bullets.length > 0) {
    const body: TextElement = {
      id: `b-${i}`,
      type: 'text',
      role: 'bullet',
      text: formatBulletsText(L.bullets),
      nbbox: A.body.nbbox,
      color: A.body.color,
      fontSizePt: A.body.fontSizePt,
      align: A.body.align,
      font: theme.fonts.latin,
      fontEA: theme.fonts.ea,
      z: 11,
    };
    if (A.body.bold !== undefined) body.bold = A.body.bold;
    elements.push(body);
  }

  const spec: SlideSpec = {
    slideId: `s${i + 1}`,
    outline: { title: L.title, bullets: L.bullets },
    // No background ASSET yet — the imagery route owns any full-slide picture.
    background: null,
    // Solid theme fill (palette.bg, per archetype) baked in so the sidecars fill
    // the canvas; absent on the resolved slide => white, the historical default.
    backgroundColor: A.background.bgColor,
    elements,
  };
  // Carry the optional theme accent band through to the renderers verbatim.
  if (A.background.accentBar) spec.accentBar = A.background.accentBar;
  return spec;
}

/**
 * Map a `DeckLayout` + `Theme` into `SlideSpec[]` (one spec per slide layout).
 * Text-only: no image elements (imagery route appends those later), no
 * background asset (imagery route bakes the fill). Every emitted spec is shaped
 * to pass `validateSlideSpec`.
 */
export function layoutToSpec(deckLayout: DeckLayout, theme: Theme): SlideSpec[] {
  return deckLayout.slides.map((_, i) => composeSlide(deckLayout, theme, i));
}

/** Contract alias: `compose(layout, theme)` is the same mapping as `layoutToSpec`. */
export const compose = layoutToSpec;
