import { describe, it, expect } from 'vitest';
import { decomposeToSpec, type OcrLine } from './heuristics';
import type { SlideSpec, TextElement } from './spec';

const dims = { width: 1672, height: 941 };

function line(text: string, x: number, y: number, w: number, h: number, conf = 1): OcrLine {
  return { text, confidence: conf, bbox: { x, y, width: w, height: h } };
}

const texts = (spec: SlideSpec): TextElement[] =>
  spec.elements.filter((e): e is TextElement => e.type === 'text');

describe('decomposeToSpec', () => {
  it('maps the largest-height region to the title and the rest to bullets in order', () => {
    const ocr = [
      line('garbled-title', 28, 84, 1094, 84), // tallest -> title
      line('b1', 80, 300, 400, 30),
      line('b2', 80, 360, 420, 30),
    ];
    const { spec } = decomposeToSpec({
      slideId: 's1',
      outline: { title: '진짜 제목', bullets: ['첫째', '둘째'] },
      ocrLines: ocr,
      draftDims: dims,
    });
    const title = texts(spec).find((e) => e.role === 'title');
    expect(title?.text).toBe('진짜 제목');
    // title nbbox derived from the tall region (y=84/941)
    expect(title?.nbbox.y).toBeCloseTo(84 / 941, 3);
    const bullets = texts(spec).filter((e) => e.role === 'bullet');
    expect(bullets.map((b) => b.text)).toEqual(['첫째', '둘째']);
    // bullets keep top->bottom order from OCR geometry
    expect(bullets[0].nbbox.y).toBeLessThan(bullets[1].nbbox.y);
  });

  it('returns every OCR region as a wipe box (baked text removal)', () => {
    const ocr = [line('a', 0, 0, 10, 10), line('b', 0, 50, 10, 10)];
    const { wipeBoxes } = decomposeToSpec({ slideId: 's', outline: { title: 'T' }, ocrLines: ocr, draftDims: dims });
    expect(wipeBoxes).toHaveLength(2);
  });

  it('derives font size from bbox height, not glyph reading', () => {
    const ocr = [line('x', 28, 84, 1094, 94)]; // 94/941*540 ~= 53.9 -> 54
    const { spec } = decomposeToSpec({ slideId: 's', outline: { title: 'T' }, ocrLines: ocr, draftDims: dims });
    expect(texts(spec)[0].fontSizePt).toBe(54);
  });

  it('falls back to default positions when outline has more items than OCR regions', () => {
    const { spec } = decomposeToSpec({
      slideId: 's',
      outline: { title: 'T', bullets: ['only-one-region', 'no-region-for-this'] },
      ocrLines: [line('r', 80, 300, 400, 30)],
      draftDims: dims,
    });
    const bullets = texts(spec).filter((e) => e.role === 'bullet');
    expect(bullets).toHaveLength(2);
    // second bullet has no OCR region -> default-positioned, no ocrText
    expect(bullets[1].ocrText).toBeUndefined();
  });

  it('handles zero OCR regions by placing title at a default position', () => {
    const { spec, wipeBoxes } = decomposeToSpec({ slideId: 's', outline: { title: '제목만' }, ocrLines: [], draftDims: dims });
    expect(wipeBoxes).toHaveLength(0);
    const title = texts(spec).find((e) => e.role === 'title');
    expect(title?.text).toBe('제목만');
    expect(title?.nbbox).toEqual({ x: 0.06, y: 0.08, w: 0.88, h: 0.14 });
  });
});
