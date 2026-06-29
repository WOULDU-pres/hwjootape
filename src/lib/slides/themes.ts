/**
 * themes — the curated, data-driven THEME layer for the layout-first deck generator.
 *
 * A `Theme` is pure design DATA: a palette, a font pair, and a per-archetype recipe
 * (where the title goes, where the body/bullets go, an optional default image zone,
 * and a background spec). `compose` (layoutToSpec) reads ONLY `palette` + `fonts` +
 * `layout[archetype]` to place a designed `DeckLayout` into editable `SlideSpec`
 * text — so adding a new theme is just adding a new `Theme` object to the registry
 * below. No code anywhere else changes.
 *
 * Coordinate model (must match scripts/render-png.py + scripts/build-pptx.py):
 *   - NBBox fields are normalized [0,1] on a fixed 16:9 canvas (x,y = top-left).
 *   - `color` is a 6-digit hex string (leading '#' tolerated but omitted here).
 *   - `align` is left|center|right; `fontSizePt` is a point size on a 7.5in-tall slide.
 *   - The sidecars auto-fit (shrink) text to its box, so the point sizes here are an
 *     UPPER bound for a comfortable hierarchy, and the boxes are generously sized so
 *     Korean body text never has to shrink below a readable size.
 *
 * IMPORTANT (sidecar constraint): the python sidecars render ONLY text elements,
 * image elements, and a full-slide background picture. They have NO rectangle/shape
 * primitive. Therefore `ArchetypeBackground.bgColor` and `AccentBar` are THEME DATA
 * describing intent only — `compose` cannot emit them as renderable elements. They
 * are reserved for the imagery route (which can bake a solid fill + accent bar into a
 * full-slide background PNG) or a future `rect` element. The fonts default to the
 * project defaults (Pretendard latin / Apple SD Gothic Neo EA — see ./spec.ts).
 */
import type { Theme, ThemeRegistry } from './layout-types';

/**
 * Image zone proven sensible by the spike: right-hand column, comfortably clear of
 * the left-hand title + bullets and the page margins. Shared by every image
 * archetype's `defaultImageZone` so imagery lands in a consistent, non-overlapping
 * region when the designer omits a per-slide `imageZone`.
 */
const DEFAULT_IMAGE_ZONE = { x: 0.58, y: 0.24, w: 0.36, h: 0.62 } as const;

/**
 * "아카데미 블루" (Academy Blue) — a polished, high-contrast theme for Korean
 * business decks. Near-white background, near-black body text, and ONE restrained
 * navy-blue accent reserved for titles and accent bars. Type hierarchy is clear:
 * oversized titles, comfortable body. Margins are generous (~6% side gutters) and
 * title boxes never overlap the body or the image zone.
 */
const ACADEMY_BLUE: Theme = {
  id: 'academy-blue',
  name: '아카데미 블루',
  palette: {
    bg: 'f7f8fa', // soft off-white page
    fg: '1c1f26', // near-black body text (high contrast on bg)
    accent: '1a3a8f', // restrained navy — titles, bars, emphasis
    muted: '5b6472', // secondary / captions
  },
  fonts: {
    latin: 'Pretendard',
    ea: 'Apple SD Gothic Neo',
  },
  layout: {
    // Cover: oversized centered title low-center, no bullets, no image.
    title: {
      title: {
        nbbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.22 },
        color: '1a3a8f',
        fontSizePt: 54,
        align: 'center',
        bold: true,
      },
      // Subtitle/strapline carried as body when the designer supplies one line.
      body: {
        nbbox: { x: 0.1, y: 0.64, w: 0.8, h: 0.12 },
        color: '5b6472',
        fontSizePt: 22,
        align: 'center',
      },
      background: {
        bgColor: 'f7f8fa',
        // Slim full-width accent bar near the bottom (intent; baked by imagery route).
        accentBar: { nbbox: { x: 0.0, y: 0.84, w: 1.0, h: 0.02 }, color: '1a3a8f' },
      },
    },

    // Section divider: a single large title, vertically centered, no body.
    section: {
      title: {
        nbbox: { x: 0.08, y: 0.42, w: 0.84, h: 0.2 },
        color: '1a3a8f',
        fontSizePt: 44,
        align: 'left',
        bold: true,
      },
      background: {
        bgColor: 'f7f8fa',
        // Left rail accent (intent only).
        accentBar: { nbbox: { x: 0.0, y: 0.0, w: 0.015, h: 1.0 }, color: '1a3a8f' },
      },
    },

    // Title + full-width bullet list, no image.
    bullets: {
      title: {
        nbbox: { x: 0.07, y: 0.1, w: 0.86, h: 0.16 },
        color: '1a3a8f',
        fontSizePt: 36,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.07, y: 0.3, w: 0.86, h: 0.6 },
        color: '1c1f26',
        fontSizePt: 22,
        align: 'left',
      },
      background: {
        bgColor: 'f7f8fa',
        // Short accent underline beneath the title (intent only).
        accentBar: { nbbox: { x: 0.07, y: 0.27, w: 0.16, h: 0.012 }, color: '1a3a8f' },
      },
    },

    // Title + bullets on the LEFT, image zone on the RIGHT (aligned to DEFAULT_IMAGE_ZONE).
    'bullets-image-right': {
      title: {
        nbbox: { x: 0.07, y: 0.1, w: 0.86, h: 0.16 },
        color: '1a3a8f',
        fontSizePt: 36,
        align: 'left',
        bold: true,
      },
      body: {
        // Left column ends at ~0.5, clear of the image zone starting at x:0.58.
        nbbox: { x: 0.07, y: 0.3, w: 0.46, h: 0.6 },
        color: '1c1f26',
        fontSizePt: 22,
        align: 'left',
      },
      defaultImageZone: { ...DEFAULT_IMAGE_ZONE },
      background: {
        bgColor: 'f7f8fa',
        accentBar: { nbbox: { x: 0.07, y: 0.27, w: 0.16, h: 0.012 }, color: '1a3a8f' },
      },
    },

    // Quote / callout: one emphasized line, centered, no bullets.
    quote: {
      title: {
        nbbox: { x: 0.12, y: 0.36, w: 0.76, h: 0.28 },
        color: '1c1f26',
        fontSizePt: 34,
        align: 'center',
        bold: true,
      },
      // Attribution line, if supplied as a single body line.
      body: {
        nbbox: { x: 0.12, y: 0.66, w: 0.76, h: 0.1 },
        color: '5b6472',
        fontSizePt: 20,
        align: 'center',
      },
      background: {
        bgColor: 'f7f8fa',
        accentBar: { nbbox: { x: 0.42, y: 0.3, w: 0.16, h: 0.012 }, color: '1a3a8f' },
      },
    },

    // Closing / thank-you: large centered title, no body.
    closing: {
      title: {
        nbbox: { x: 0.1, y: 0.42, w: 0.8, h: 0.2 },
        color: '1a3a8f',
        fontSizePt: 48,
        align: 'center',
        bold: true,
      },
      background: {
        bgColor: 'f7f8fa',
        accentBar: { nbbox: { x: 0.0, y: 0.84, w: 1.0, h: 0.02 }, color: '1a3a8f' },
      },
    },
  },
};

/**
 * "미드나잇" (Midnight) — a DARK keynote theme. Near-black stage, light text, and
 * ONE vivid electric-blue accent reserved for titles, bars, and emphasis. Titles
 * are bold and oversized (keynote scale); body text sits high-contrast on the dark
 * field. Image zone hugs the right column, off the title, so nothing overlaps.
 */
const MIDNIGHT: Theme = {
  id: 'midnight',
  name: '미드나잇',
  palette: {
    bg: '0c0e14', // near-black stage
    fg: 'f4f6fb', // light text (high contrast on bg)
    accent: '3d7dff', // vivid electric blue — titles, bars, emphasis
    muted: '8a93a6', // secondary / captions on dark
  },
  fonts: {
    latin: 'Pretendard',
    ea: 'Apple SD Gothic Neo',
  },
  layout: {
    // Cover: huge left-anchored title low on the stage, vivid-accent colored.
    title: {
      title: {
        nbbox: { x: 0.08, y: 0.46, w: 0.84, h: 0.26 },
        color: '3d7dff',
        fontSizePt: 66,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.08, y: 0.74, w: 0.84, h: 0.12 },
        color: '8a93a6',
        fontSizePt: 24,
        align: 'left',
      },
      background: {
        bgColor: '0c0e14',
        // Thick left rail in the vivid accent (intent; baked by imagery route).
        accentBar: { nbbox: { x: 0.0, y: 0.0, w: 0.02, h: 1.0 }, color: '3d7dff' },
      },
    },

    // Section divider: oversized light title, vertically centered, no body.
    section: {
      title: {
        nbbox: { x: 0.08, y: 0.4, w: 0.84, h: 0.24 },
        color: 'f4f6fb',
        fontSizePt: 52,
        align: 'left',
        bold: true,
      },
      background: {
        bgColor: '0c0e14',
        accentBar: { nbbox: { x: 0.08, y: 0.36, w: 0.12, h: 0.014 }, color: '3d7dff' },
      },
    },

    // Title + full-width bullet list, light-on-dark.
    bullets: {
      title: {
        nbbox: { x: 0.08, y: 0.09, w: 0.84, h: 0.16 },
        color: '3d7dff',
        fontSizePt: 40,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.08, y: 0.3, w: 0.84, h: 0.6 },
        color: 'f4f6fb',
        fontSizePt: 23,
        align: 'left',
      },
      background: {
        bgColor: '0c0e14',
        accentBar: { nbbox: { x: 0.08, y: 0.26, w: 0.14, h: 0.012 }, color: '3d7dff' },
      },
    },

    // Title + bullets on the LEFT, image zone on the RIGHT.
    'bullets-image-right': {
      title: {
        nbbox: { x: 0.08, y: 0.09, w: 0.84, h: 0.16 },
        color: '3d7dff',
        fontSizePt: 40,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.08, y: 0.3, w: 0.45, h: 0.6 },
        color: 'f4f6fb',
        fontSizePt: 23,
        align: 'left',
      },
      defaultImageZone: { ...DEFAULT_IMAGE_ZONE },
      background: {
        bgColor: '0c0e14',
        accentBar: { nbbox: { x: 0.08, y: 0.26, w: 0.14, h: 0.012 }, color: '3d7dff' },
      },
    },

    // Quote / callout: one bold light line, centered, with a vivid attribution.
    quote: {
      title: {
        nbbox: { x: 0.1, y: 0.34, w: 0.8, h: 0.3 },
        color: 'f4f6fb',
        fontSizePt: 38,
        align: 'center',
        bold: true,
      },
      body: {
        nbbox: { x: 0.1, y: 0.66, w: 0.8, h: 0.1 },
        color: '3d7dff',
        fontSizePt: 22,
        align: 'center',
      },
      background: {
        bgColor: '0c0e14',
        accentBar: { nbbox: { x: 0.44, y: 0.3, w: 0.12, h: 0.012 }, color: '3d7dff' },
      },
    },

    // Closing / thank-you: huge centered vivid-accent title, no body.
    closing: {
      title: {
        nbbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.22 },
        color: '3d7dff',
        fontSizePt: 60,
        align: 'center',
        bold: true,
      },
      background: {
        bgColor: '0c0e14',
        accentBar: { nbbox: { x: 0.0, y: 0.86, w: 1.0, h: 0.02 }, color: '3d7dff' },
      },
    },
  },
};

/**
 * "테라코타" (Terracotta) — a WARM editorial theme. Warm cream/ivory page, deep
 * charcoal text, and ONE earthy terracotta accent. Margins are more generous than
 * Academy Blue (~9–10% gutters) for an editorial, unhurried feel. Titles are
 * confident but not shouty; body sits in a warm, readable charcoal.
 */
const TERRACOTTA: Theme = {
  id: 'terracotta',
  name: '테라코타',
  palette: {
    bg: 'f6efe4', // warm cream / ivory page
    fg: '2b2620', // deep warm charcoal body text
    accent: 'bf5a36', // earthy terracotta — titles, bars, emphasis
    muted: '8a7f70', // warm taupe — secondary / captions
  },
  fonts: {
    latin: 'Pretendard',
    ea: 'Apple SD Gothic Neo',
  },
  layout: {
    // Cover: generous-margin centered title mid-page, terracotta, warm strapline.
    title: {
      title: {
        nbbox: { x: 0.14, y: 0.4, w: 0.72, h: 0.22 },
        color: 'bf5a36',
        fontSizePt: 50,
        align: 'center',
        bold: true,
      },
      body: {
        nbbox: { x: 0.14, y: 0.64, w: 0.72, h: 0.12 },
        color: '8a7f70',
        fontSizePt: 22,
        align: 'center',
      },
      background: {
        bgColor: 'f6efe4',
        // Centered short rule under the title (intent only).
        accentBar: { nbbox: { x: 0.42, y: 0.36, w: 0.16, h: 0.012 }, color: 'bf5a36' },
      },
    },

    // Section divider: confident charcoal title with a terracotta left rail.
    section: {
      title: {
        nbbox: { x: 0.12, y: 0.42, w: 0.76, h: 0.2 },
        color: '2b2620',
        fontSizePt: 42,
        align: 'left',
        bold: true,
      },
      background: {
        bgColor: 'f6efe4',
        accentBar: { nbbox: { x: 0.0, y: 0.0, w: 0.02, h: 1.0 }, color: 'bf5a36' },
      },
    },

    // Title + full-width bullets, generous gutters.
    bullets: {
      title: {
        nbbox: { x: 0.1, y: 0.11, w: 0.8, h: 0.16 },
        color: 'bf5a36',
        fontSizePt: 34,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.1, y: 0.31, w: 0.8, h: 0.58 },
        color: '2b2620',
        fontSizePt: 22,
        align: 'left',
      },
      background: {
        bgColor: 'f6efe4',
        accentBar: { nbbox: { x: 0.1, y: 0.28, w: 0.16, h: 0.012 }, color: 'bf5a36' },
      },
    },

    // Title + bullets on the LEFT, image zone on the RIGHT.
    'bullets-image-right': {
      title: {
        nbbox: { x: 0.1, y: 0.11, w: 0.8, h: 0.16 },
        color: 'bf5a36',
        fontSizePt: 34,
        align: 'left',
        bold: true,
      },
      body: {
        // Left column ends ~0.49, clear of the image zone at x:0.58.
        nbbox: { x: 0.1, y: 0.31, w: 0.42, h: 0.58 },
        color: '2b2620',
        fontSizePt: 22,
        align: 'left',
      },
      defaultImageZone: { ...DEFAULT_IMAGE_ZONE },
      background: {
        bgColor: 'f6efe4',
        accentBar: { nbbox: { x: 0.1, y: 0.28, w: 0.16, h: 0.012 }, color: 'bf5a36' },
      },
    },

    // Quote / callout: serene charcoal line, centered, terracotta attribution.
    quote: {
      title: {
        nbbox: { x: 0.16, y: 0.36, w: 0.68, h: 0.28 },
        color: '2b2620',
        fontSizePt: 32,
        align: 'center',
        bold: true,
      },
      body: {
        nbbox: { x: 0.16, y: 0.66, w: 0.68, h: 0.1 },
        color: 'bf5a36',
        fontSizePt: 20,
        align: 'center',
      },
      background: {
        bgColor: 'f6efe4',
        accentBar: { nbbox: { x: 0.42, y: 0.3, w: 0.16, h: 0.012 }, color: 'bf5a36' },
      },
    },

    // Closing / thank-you: large centered terracotta title, no body.
    closing: {
      title: {
        nbbox: { x: 0.14, y: 0.42, w: 0.72, h: 0.2 },
        color: 'bf5a36',
        fontSizePt: 46,
        align: 'center',
        bold: true,
      },
      background: {
        bgColor: 'f6efe4',
        accentBar: { nbbox: { x: 0.0, y: 0.85, w: 1.0, h: 0.018 }, color: 'bf5a36' },
      },
    },
  },
};

/**
 * "모노" (Mono) — a MINIMAL theme. Pure white page, near-black ink text, and ONE
 * restrained graphite/ink accent used only as a thin rule. Lots of whitespace and
 * SMALLER, restrained titles let the content breathe — the quietest of the four.
 */
const MONO: Theme = {
  id: 'mono',
  name: '모노',
  palette: {
    bg: 'ffffff', // pure white page
    fg: '141414', // near-black ink body text
    accent: '3a3a3a', // restrained graphite/ink — thin rules only
    muted: '9a9a9a', // light gray — secondary / captions
  },
  fonts: {
    latin: 'Pretendard',
    ea: 'Apple SD Gothic Neo',
  },
  layout: {
    // Cover: restrained left-anchored ink title, lots of air, thin rule.
    title: {
      title: {
        nbbox: { x: 0.1, y: 0.42, w: 0.8, h: 0.18 },
        color: '141414',
        fontSizePt: 40,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.1, y: 0.62, w: 0.8, h: 0.1 },
        color: '9a9a9a',
        fontSizePt: 18,
        align: 'left',
      },
      background: {
        bgColor: 'ffffff',
        // Thin short ink rule above the title (intent only).
        accentBar: { nbbox: { x: 0.1, y: 0.38, w: 0.1, h: 0.006 }, color: '3a3a3a' },
      },
    },

    // Section divider: small restrained ink title, generous whitespace.
    section: {
      title: {
        nbbox: { x: 0.1, y: 0.44, w: 0.8, h: 0.16 },
        color: '141414',
        fontSizePt: 32,
        align: 'left',
        bold: true,
      },
      background: {
        bgColor: 'ffffff',
        accentBar: { nbbox: { x: 0.1, y: 0.4, w: 0.08, h: 0.006 }, color: '3a3a3a' },
      },
    },

    // Title + full-width bullets, small title, airy body.
    bullets: {
      title: {
        nbbox: { x: 0.1, y: 0.12, w: 0.8, h: 0.12 },
        color: '141414',
        fontSizePt: 28,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.1, y: 0.3, w: 0.8, h: 0.58 },
        color: '141414',
        fontSizePt: 21,
        align: 'left',
      },
      background: {
        bgColor: 'ffffff',
        // Thin accent bar beneath the title (intent only).
        accentBar: { nbbox: { x: 0.1, y: 0.27, w: 0.12, h: 0.006 }, color: '3a3a3a' },
      },
    },

    // Title + bullets on the LEFT, image zone on the RIGHT.
    'bullets-image-right': {
      title: {
        nbbox: { x: 0.1, y: 0.12, w: 0.8, h: 0.12 },
        color: '141414',
        fontSizePt: 28,
        align: 'left',
        bold: true,
      },
      body: {
        nbbox: { x: 0.1, y: 0.3, w: 0.42, h: 0.58 },
        color: '141414',
        fontSizePt: 21,
        align: 'left',
      },
      defaultImageZone: { ...DEFAULT_IMAGE_ZONE },
      background: {
        bgColor: 'ffffff',
        accentBar: { nbbox: { x: 0.1, y: 0.27, w: 0.12, h: 0.006 }, color: '3a3a3a' },
      },
    },

    // Quote / callout: quiet ink line, centered, muted-gray attribution.
    quote: {
      title: {
        nbbox: { x: 0.14, y: 0.38, w: 0.72, h: 0.24 },
        color: '141414',
        fontSizePt: 28,
        align: 'center',
        bold: false,
      },
      body: {
        nbbox: { x: 0.14, y: 0.64, w: 0.72, h: 0.1 },
        color: '9a9a9a',
        fontSizePt: 18,
        align: 'center',
      },
      background: {
        bgColor: 'ffffff',
        accentBar: { nbbox: { x: 0.46, y: 0.33, w: 0.08, h: 0.006 }, color: '3a3a3a' },
      },
    },

    // Closing / thank-you: restrained centered ink title, no body.
    closing: {
      title: {
        nbbox: { x: 0.1, y: 0.44, w: 0.8, h: 0.16 },
        color: '141414',
        fontSizePt: 36,
        align: 'center',
        bold: true,
      },
      background: {
        bgColor: 'ffffff',
        accentBar: { nbbox: { x: 0.46, y: 0.4, w: 0.08, h: 0.006 }, color: '3a3a3a' },
      },
    },
  },
};

/** Default theme id used when a requested id is missing or unknown. */
export const DEFAULT_THEME_ID = ACADEMY_BLUE.id;

/**
 * Theme registry. Add a new theme by adding a `Theme` object here (and, optionally,
 * a new `const` above) — `compose` and the routes read only this registry, so no
 * other code changes are needed to introduce 2–3 more themes in a later phase.
 */
const THEMES: ThemeRegistry = {
  [ACADEMY_BLUE.id]: ACADEMY_BLUE,
  [MIDNIGHT.id]: MIDNIGHT,
  [TERRACOTTA.id]: TERRACOTTA,
  [MONO.id]: MONO,
};

/** Look up a theme by id, falling back to the default theme if absent/unknown. */
export function getTheme(id?: string): Theme {
  if (id && Object.prototype.hasOwnProperty.call(THEMES, id)) {
    return THEMES[id];
  }
  return THEMES[DEFAULT_THEME_ID];
}

/** All registered themes (stable order; default theme first). */
export function listThemes(): Theme[] {
  const def = THEMES[DEFAULT_THEME_ID];
  const rest = Object.values(THEMES).filter((t) => t.id !== DEFAULT_THEME_ID);
  return [def, ...rest];
}
