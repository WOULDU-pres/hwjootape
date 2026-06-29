import { describe, it, expect, vi } from 'vitest';
import {
  buildLayoutPrompt,
  designDeck,
  fallbackDeckLayout,
  validateDeckLayout,
  ARCHETYPES,
  type DesignDeckDeps,
} from './layout-designer';
import type { SlideOutline } from './deck';
import type {
  ArchetypeLayout,
  ArchetypeLayoutMap,
  Theme,
} from './layout-types';

// ---- Test fixtures ----

function block(): ArchetypeLayout['title'] {
  return { nbbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, color: '111111', fontSizePt: 40, align: 'left' };
}

function archetypeLayout(withBody: boolean): ArchetypeLayout {
  const base: ArchetypeLayout = {
    title: block(),
    background: { bgColor: 'ffffff' },
  };
  if (withBody) {
    base.body = { nbbox: { x: 0.1, y: 0.35, w: 0.8, h: 0.5 }, color: '333333', fontSizePt: 24, align: 'left' };
  }
  return base;
}

const layoutMap: ArchetypeLayoutMap = {
  title: archetypeLayout(false),
  section: archetypeLayout(false),
  bullets: archetypeLayout(true),
  'bullets-image-right': archetypeLayout(true),
  quote: archetypeLayout(false),
  closing: archetypeLayout(false),
};

const theme: Theme = {
  id: 'test',
  name: '테스트 테마',
  palette: { bg: 'ffffff', fg: '111111', accent: '1a3a8f', muted: '888888' },
  fonts: { latin: 'Pretendard', ea: 'Apple SD Gothic Neo' },
  layout: layoutMap,
};

const outlines: SlideOutline[] = [
  { title: '표지', bullets: [] },
  { title: '시장 개요', bullets: ['규모', '성장률', '경쟁사'] },
  { title: '핵심 제품', bullets: ['라인업'] },
  { title: '마무리', bullets: [] },
];

/** Build a structurally-valid DeckLayout JSON string for the fixture outline. */
function goodJson(): string {
  return JSON.stringify({
    slides: [
      { archetype: 'title', title: '표지', bullets: [], imageZone: null },
      { archetype: 'bullets', title: '시장 개요', bullets: ['규모', '성장률', '경쟁사'], imageZone: null },
      {
        archetype: 'bullets-image-right',
        title: '핵심 제품',
        bullets: ['라인업'],
        imageZone: { x: 0.6, y: 0.3, w: 0.35, h: 0.5 },
      },
      { archetype: 'closing', title: '마무리', bullets: [], imageZone: null },
    ],
  });
}

function depsReturning(text: string): DesignDeckDeps {
  return { generateLayout: vi.fn(async () => text) };
}

describe('buildLayoutPrompt', () => {
  it('embeds the allowed archetypes, output rules, and the outline', () => {
    const p = buildLayoutPrompt(outlines, theme);
    // archetype enum limited to the theme's archetypes
    for (const a of ARCHETYPES) expect(p).toContain(a);
    // JSON-only / no code fence instruction
    expect(p).toContain('JSON');
    expect(p).toContain('코드펜스');
    // normalized 0..1 + bbox containment rules
    expect(p).toContain('x+w<=1');
    expect(p).toContain('y+h<=1');
    // slide count == outline length
    expect(p).toContain(`총 ${outlines.length}개`);
    // imageZone must not overlap the title
    expect(p).toContain('제목 영역과 절대 겹치면 안 된다');
    // the outline titles + bullets are embedded
    expect(p).toContain('시장 개요');
    expect(p).toContain('규모');
    expect(p).toContain('마무리');
  });
});

describe('validateDeckLayout', () => {
  it('accepts a well-formed layout with the exact slide count', () => {
    const parsed = JSON.parse(goodJson());
    const layout = validateDeckLayout(parsed, 4);
    expect(layout).not.toBeNull();
    expect(layout!.slides).toHaveLength(4);
    expect(layout!.slides[2].imageZone).toEqual({ x: 0.6, y: 0.3, w: 0.35, h: 0.5 });
  });

  it('rejects a wrong slide count', () => {
    const parsed = JSON.parse(goodJson());
    expect(validateDeckLayout(parsed, 3)).toBeNull();
    expect(validateDeckLayout(parsed, 5)).toBeNull();
  });

  it('rejects an unknown archetype', () => {
    const bad = { slides: [{ archetype: 'banner', title: 'x', bullets: [], imageZone: null }] };
    expect(validateDeckLayout(bad, 1)).toBeNull();
  });

  it('rejects an out-of-bounds imageZone (x+w>1)', () => {
    const bad = {
      slides: [{ archetype: 'bullets-image-right', title: 'x', bullets: [], imageZone: { x: 0.7, y: 0.1, w: 0.5, h: 0.2 } }],
    };
    expect(validateDeckLayout(bad, 1)).toBeNull();
  });

  it('rejects a non-finite / negative bbox', () => {
    const negative = {
      slides: [{ archetype: 'bullets', title: 'x', bullets: [], imageZone: { x: -0.1, y: 0.1, w: 0.2, h: 0.2 } }],
    };
    expect(validateDeckLayout(negative, 1)).toBeNull();
  });

  it('rejects non-object / missing slides array', () => {
    expect(validateDeckLayout(null, 1)).toBeNull();
    expect(validateDeckLayout({}, 1)).toBeNull();
    expect(validateDeckLayout({ slides: 'nope' }, 1)).toBeNull();
  });
});

describe('fallbackDeckLayout', () => {
  it('maps slide 1 -> title, last -> closing, middle -> bullets, imageZone null', () => {
    const layout = fallbackDeckLayout(outlines, theme);
    expect(layout.slides).toHaveLength(outlines.length);
    expect(layout.slides[0].archetype).toBe('title');
    expect(layout.slides[layout.slides.length - 1].archetype).toBe('closing');
    expect(layout.slides[1].archetype).toBe('bullets');
    expect(layout.slides[2].archetype).toBe('bullets');
    for (const s of layout.slides) expect(s.imageZone).toBeNull();
    // title-only archetypes drop bullets; bullets archetypes keep them
    expect(layout.slides[0].bullets).toEqual([]);
    expect(layout.slides[1].bullets).toEqual(['규모', '성장률', '경쟁사']);
    // titles preserved verbatim from the outline
    expect(layout.slides.map((s) => s.title)).toEqual(outlines.map((o) => o.title));
  });
});

describe('designDeck', () => {
  it('(a) good JSON -> parsed, no fallback', async () => {
    const deps = depsReturning(goodJson());
    const { layout, usedFallback } = await designDeck(outlines, theme, deps);
    expect(usedFallback).toBe(false);
    expect(layout.slides).toHaveLength(4);
    expect(layout.slides[0].archetype).toBe('title');
    expect(layout.slides[1].bullets).toEqual(['규모', '성장률', '경쟁사']);
    expect(deps.generateLayout).toHaveBeenCalledOnce();
  });

  it('strips code fences before parsing good JSON', async () => {
    const fenced = '```json\n' + goodJson() + '\n```';
    const { layout, usedFallback } = await designDeck(outlines, theme, depsReturning(fenced));
    expect(usedFallback).toBe(false);
    expect(layout.slides).toHaveLength(4);
  });

  it('(b) malformed JSON -> deterministic fallback', async () => {
    const { layout, usedFallback } = await designDeck(outlines, theme, depsReturning('{ not valid json'));
    expect(usedFallback).toBe(true);
    // matches the deterministic fallback derived from the outline + theme
    expect(layout).toEqual(fallbackDeckLayout(outlines, theme));
  });

  it('(c) wrong slide count -> deterministic fallback', async () => {
    const tooFew = JSON.stringify({
      slides: [{ archetype: 'title', title: '표지', bullets: [], imageZone: null }],
    });
    const { layout, usedFallback } = await designDeck(outlines, theme, depsReturning(tooFew));
    expect(usedFallback).toBe(true);
    expect(layout.slides).toHaveLength(outlines.length);
  });

  it('out-of-bounds imageZone -> fallback', async () => {
    const badZone = JSON.stringify({
      slides: outlines.map((o, idx) => ({
        archetype: idx === 0 ? 'title' : 'bullets',
        title: o.title,
        bullets: o.bullets,
        imageZone: idx === 2 ? { x: 0.9, y: 0.1, w: 0.5, h: 0.2 } : null,
      })),
    });
    const { usedFallback } = await designDeck(outlines, theme, depsReturning(badZone));
    expect(usedFallback).toBe(true);
  });

  it('empty assistant text -> fallback', async () => {
    const { usedFallback } = await designDeck(outlines, theme, depsReturning('   '));
    expect(usedFallback).toBe(true);
  });

  it('provider throwing -> fallback (never hard-fails)', async () => {
    const deps: DesignDeckDeps = {
      generateLayout: vi.fn(async () => {
        throw new Error('backend 500');
      }),
    };
    const { layout, usedFallback } = await designDeck(outlines, theme, deps);
    expect(usedFallback).toBe(true);
    expect(layout.slides).toHaveLength(outlines.length);
  });
});
