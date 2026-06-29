import { describe, it, expect } from 'vitest';
import { parseOutline, buildDraftPrompt } from './deck';
import { resolveDeck, validateSlideSpec, SLIDE_W_EMU, type SlideSpec } from './spec';

describe('parseOutline', () => {
  it('splits slides on --- and extracts title + bullets', () => {
    const md = [
      '# 첫 번째 슬라이드',
      '- 항목 하나',
      '- 항목 둘',
      '---',
      '# 두 번째 슬라이드',
      '* 다른 항목',
    ].join('\n');
    const slides = parseOutline(md);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toEqual({ title: '첫 번째 슬라이드', bullets: ['항목 하나', '항목 둘'] });
    expect(slides[1]).toEqual({ title: '두 번째 슬라이드', bullets: ['다른 항목'] });
  });

  it('treats the first plain line as the title when no heading', () => {
    const slides = parseOutline('그냥 제목\n- 불릿');
    expect(slides[0].title).toBe('그냥 제목');
    expect(slides[0].bullets).toEqual(['불릿']);
  });

  it('handles numbered bullets and drops empty blocks', () => {
    const slides = parseOutline('# T\n1. a\n2) b\n---\n\n\n');
    expect(slides).toHaveLength(1);
    expect(slides[0].bullets).toEqual(['a', 'b']);
  });
});

describe('buildDraftPrompt', () => {
  it('drives 16:9 via prompt text and marks rendered text as placeholder', () => {
    const p = buildDraftPrompt({ title: '제목', bullets: ['요점'] });
    expect(p).toContain('16:9 widescreen landscape');
    expect(p).toContain('제목');
    expect(p).toContain('요점');
    expect(p.toLowerCase()).toContain('placeholder');
  });
});

describe('resolveDeck', () => {
  const baseSpec: SlideSpec = {
    slideId: 's1',
    elements: [
      { id: 't1', type: 'text', role: 'title', text: '제목', nbbox: { x: 0.05, y: 0.08, w: 0.9, h: 0.12 } },
      { id: 'i1', type: 'image', nbbox: { x: 0.6, y: 0.3, w: 0.3, h: 0.4 }, assetId: 'asset-1' },
    ],
  };

  it('applies default Korean fonts and resolves image asset paths', () => {
    const resolved = resolveDeck([baseSpec], (id) => (id === 'asset-1' ? '/abs/asset-1.png' : null));
    expect(resolved.slideWidthEmu).toBe(SLIDE_W_EMU);
    const [slide] = resolved.slides;
    const text = slide.elements.find((e) => e.type === 'text');
    expect(text).toMatchObject({ font: 'Pretendard', fontEA: 'Apple SD Gothic Neo', align: 'left' });
    const image = slide.elements.find((e) => e.type === 'image');
    expect(image).toMatchObject({ path: '/abs/asset-1.png' });
  });

  it('drops image elements whose asset cannot be resolved', () => {
    const resolved = resolveDeck([baseSpec], () => null);
    expect(resolved.slides[0].elements.filter((e) => e.type === 'image')).toHaveLength(0);
  });

  it('clamps out-of-range normalized coords', () => {
    const spec: SlideSpec = {
      slideId: 's2',
      elements: [{ id: 't', type: 'text', role: 'other', text: 'x', nbbox: { x: -1, y: 2, w: 5, h: 0.5 } }],
    };
    const [slide] = resolveDeck([spec], () => null).slides;
    expect(slide.elements[0].nbbox).toEqual({ x: 0, y: 1, w: 1, h: 0.5 });
  });
});

describe('validateSlideSpec', () => {
  it('flags empty text elements and missing ids', () => {
    const res = validateSlideSpec({ slideId: '', elements: [{ id: 't', type: 'text', role: 'other', text: '  ', nbbox: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('slideId'))).toBe(true);
    expect(res.errors.some((e) => e.includes('empty text'))).toBe(true);
  });
});
