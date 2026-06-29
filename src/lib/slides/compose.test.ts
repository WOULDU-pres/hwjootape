import { describe, it, expect } from 'vitest';
import { layoutToSpec, compose, formatBulletsText } from './compose';
import { validateSlideSpec, type NBBox, type TextElement } from './spec';
import type {
  ArchetypeLayout,
  ArchetypeLayoutMap,
  DeckLayout,
  Theme,
} from './layout-types';

// ---- Test fixtures ----

const titleBox: NBBox = { x: 0.08, y: 0.1, w: 0.84, h: 0.2 };
const bodyBox: NBBox = { x: 0.08, y: 0.35, w: 0.84, h: 0.5 };

function archetypeLayout(withBody: boolean): ArchetypeLayout {
  const base: ArchetypeLayout = {
    title: { nbbox: titleBox, color: '1a3a8f', fontSizePt: 40, align: 'left', bold: true },
    background: { bgColor: 'ffffff' },
  };
  if (withBody) {
    base.body = { nbbox: bodyBox, color: '333333', fontSizePt: 24, align: 'left' };
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

const deckLayout: DeckLayout = {
  slides: [
    { archetype: 'title', title: '2026 전략', bullets: [], imageZone: null },
    { archetype: 'bullets', title: '시장 개요', bullets: ['규모', '성장률', '경쟁사'], imageZone: null },
    {
      archetype: 'bullets-image-right',
      title: '핵심 제품',
      bullets: ['라인업'],
      imageZone: { x: 0.6, y: 0.3, w: 0.35, h: 0.5 },
    },
    // bullets present but archetype has no body box -> body element skipped
    { archetype: 'quote', title: '한 줄 인용', bullets: ['무시되는 불릿'], imageZone: null },
    { archetype: 'closing', title: '감사합니다', bullets: [], imageZone: null },
  ],
};

function bboxInUnit(b: NBBox): boolean {
  return [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1);
}

describe('formatBulletsText', () => {
  it('joins bullets with newlines and a leading bullet glyph per line', () => {
    expect(formatBulletsText(['a', 'b'])).toBe('• a\n• b');
  });
});

describe('layoutToSpec', () => {
  const specs = layoutToSpec(deckLayout, theme);

  it('emits one SlideSpec per slide layout', () => {
    expect(specs).toHaveLength(deckLayout.slides.length);
  });

  it('every emitted spec passes validateSlideSpec', () => {
    for (const spec of specs) {
      const res = validateSlideSpec(spec);
      expect(res.errors).toEqual([]);
      expect(res.ok).toBe(true);
    }
  });

  it('emits exactly the title element for a title-only archetype', () => {
    const cover = specs[0];
    expect(cover.elements).toHaveLength(1);
    const title = cover.elements[0] as TextElement;
    expect(title.role).toBe('title');
    expect(title.text).toBe('2026 전략');
    expect(title.type).toBe('text');
  });

  it('emits title + body for a bullets archetype, with bullets joined', () => {
    const market = specs[1];
    expect(market.elements).toHaveLength(2);
    const [title, body] = market.elements as TextElement[];
    expect(title.role).toBe('title');
    expect(title.text).toBe('시장 개요');
    expect(body.role).toBe('bullet');
    expect(body.text).toBe('• 규모\n• 성장률\n• 경쟁사');
  });

  it('emits title + body for bullets-image-right but NO image element', () => {
    const product = specs[2];
    expect(product.elements).toHaveLength(2);
    expect(product.elements.every((e) => e.type === 'text')).toBe(true);
    expect(product.elements.some((e) => e.type === 'image')).toBe(false);
  });

  it('skips the body element when the archetype has no body box (even with bullets)', () => {
    const quote = specs[3];
    expect(quote.elements).toHaveLength(1);
    expect((quote.elements[0] as TextElement).role).toBe('title');
  });

  it('carries the outline and leaves background null (no asset yet)', () => {
    const market = specs[1];
    expect(market.outline).toEqual({ title: '시장 개요', bullets: ['규모', '성장률', '경쟁사'] });
    expect(market.background).toBeNull();
    expect(market.slideId).toBe('s2');
  });

  it('applies theme typography/colors from the archetype layout', () => {
    const market = specs[1];
    const [title, body] = market.elements as TextElement[];
    expect(title).toMatchObject({
      color: '1a3a8f',
      fontSizePt: 40,
      align: 'left',
      bold: true,
      font: 'Pretendard',
      fontEA: 'Apple SD Gothic Neo',
    });
    expect(body).toMatchObject({ color: '333333', fontSizePt: 24, align: 'left' });
    expect(title.nbbox).toEqual(titleBox);
    expect(body.nbbox).toEqual(bodyBox);
  });

  it('keeps every nbbox normalized within [0,1]', () => {
    for (const spec of specs) {
      for (const el of spec.elements) {
        expect(bboxInUnit(el.nbbox)).toBe(true);
      }
    }
  });

  it('z-orders title below body (text in the 10-11 range)', () => {
    const market = specs[1];
    const [title, body] = market.elements as TextElement[];
    expect(title.z).toBe(10);
    expect(body.z).toBe(11);
    expect(title.z! < body.z!).toBe(true);
  });

  it('compose is an alias for layoutToSpec', () => {
    expect(compose).toBe(layoutToSpec);
    expect(compose(deckLayout, theme)).toEqual(specs);
  });
});
