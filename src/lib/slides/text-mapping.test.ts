import { describe, it, expect } from 'vitest';
import { parseTextMapping, buildMappingPrompt, decomposeWithMapping } from './text-mapping';
import type { OcrLine } from './heuristics';
import type { TextElement, SlideSpec } from './spec';

const dims = { width: 1000, height: 562 };
function line(text: string, x: number, y: number, w: number, h: number): OcrLine {
  return { text, confidence: 1, bbox: { x, y, width: w, height: h } };
}
const texts = (spec: SlideSpec): TextElement[] => spec.elements.filter((e): e is TextElement => e.type === 'text');

describe('parseTextMapping', () => {
  it('parses a clean assignment of title + bullet boxes', () => {
    const m = parseTextMapping('{"titleBox": 0, "bulletBoxes": [1, 2]}', 3, 2);
    expect(m).toEqual({ titleIndex: 0, bulletIndices: [1, 2] });
  });

  it('strips code fences before parsing', () => {
    const m = parseTextMapping('```json\n{"titleBox": 1, "bulletBoxes": [0]}\n```', 2, 1);
    expect(m).toEqual({ titleIndex: 1, bulletIndices: [0] });
  });

  it('coerces out-of-range or missing indices to null', () => {
    const m = parseTextMapping('{"titleBox": 9, "bulletBoxes": [0, 7]}', 2, 2);
    expect(m).toEqual({ titleIndex: null, bulletIndices: [0, null] });
  });

  it('pads/truncates bulletBoxes to the bullet count', () => {
    const m = parseTextMapping('{"titleBox": 0, "bulletBoxes": [1]}', 3, 2);
    expect(m).toEqual({ titleIndex: 0, bulletIndices: [1, null] });
  });

  it('enforces single-use: a box claimed by the title cannot also be a bullet', () => {
    // title takes box 2; the bullet that also names box 2 falls back to null
    const m = parseTextMapping('{"titleBox": 2, "bulletBoxes": [2, 1]}', 3, 2);
    expect(m).toEqual({ titleIndex: 2, bulletIndices: [null, 1] });
  });

  it('enforces single-use across bullets too', () => {
    const m = parseTextMapping('{"titleBox": null, "bulletBoxes": [0, 0]}', 3, 2);
    expect(m).toEqual({ titleIndex: null, bulletIndices: [0, null] });
  });

  it('returns null on unparseable input', () => {
    expect(parseTextMapping('not json', 3, 2)).toBeNull();
    expect(parseTextMapping('{"foo": 1}', 3, 2)).toBeNull();
  });
});

describe('buildMappingPrompt', () => {
  it('includes the outline text and each OCR box index + garbled text', () => {
    const prompt = buildMappingPrompt(
      [line('GARBLE1', 50, 40, 800, 90), line('xyz', 60, 200, 400, 30)],
      { title: '진짜 제목', bullets: ['첫째 불릿'] },
    );
    expect(prompt).toContain('진짜 제목');
    expect(prompt).toContain('첫째 불릿');
    expect(prompt).toContain('GARBLE1');
    expect(prompt).toMatch(/\b0\b/); // box index 0 referenced
  });
});

describe('decomposeWithMapping', () => {
  const ocr = [
    line('garble-body', 60, 300, 420, 30), // index 0 — smaller, lower
    line('garble-title', 50, 40, 820, 96), // index 1 — biggest, but NOT chosen by geometry-as-title here
  ];

  it('places outline text at the LLM-assigned boxes (overriding geometry)', () => {
    // Mapping says title = box 0 (the small one), bullet 0 = box 1 (the big one).
    const spec = decomposeWithMapping({
      slideId: 's1',
      outline: { title: '제목', bullets: ['불릿'] },
      ocrLines: ocr,
      draftDims: dims,
      mapping: { titleIndex: 0, bulletIndices: [1] },
    });
    const t = texts(spec);
    const title = t.find((e) => e.role === 'title')!;
    const bullet = t.find((e) => e.role === 'bullet')!;
    expect(title.text).toBe('제목');
    expect(bullet.text).toBe('불릿');
    // title mapped to box 0 (y≈300/562) not the geometry pick (box1 y≈40)
    expect(title.nbbox.y).toBeCloseTo(300 / 562, 2);
    expect(bullet.nbbox.y).toBeCloseTo(40 / 562, 2);
  });

  it('falls back to geometry decomposition when mapping is null', () => {
    const spec = decomposeWithMapping({
      slideId: 's1',
      outline: { title: '제목', bullets: ['불릿'] },
      ocrLines: ocr,
      draftDims: dims,
      mapping: null,
    });
    const title = texts(spec).find((e) => e.role === 'title')!;
    // geometry: title = tallest region = box 1 (y≈40)
    expect(title.nbbox.y).toBeCloseTo(40 / 562, 2);
  });

  it('uses a fallback position for an outline item with a null mapped box', () => {
    const spec = decomposeWithMapping({
      slideId: 's1',
      outline: { title: '제목', bullets: ['불릿'] },
      ocrLines: ocr,
      draftDims: dims,
      mapping: { titleIndex: 0, bulletIndices: [null] },
    });
    const bullet = texts(spec).find((e) => e.role === 'bullet')!;
    expect(bullet.ocrText).toBeUndefined(); // no OCR region attached
  });
});
