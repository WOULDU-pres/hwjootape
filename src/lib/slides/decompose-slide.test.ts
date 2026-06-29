import { describe, it, expect, vi } from 'vitest';
import { decomposeSlide, type DecomposeSlideDeps } from './decompose-slide';
import type { TextElement, ImageElement, SlideSpec } from './spec';

const dims = { imageWidth: 1000, imageHeight: 562 };
const ocrLines = [
  { text: 'garble-title', confidence: 1, bbox: { x: 50, y: 40, width: 800, height: 90 } },
  { text: 'garble-body', confidence: 1, bbox: { x: 60, y: 300, width: 400, height: 30 } },
];

function deps(over: Partial<DecomposeSlideDeps> = {}): DecomposeSlideDeps {
  return {
    runOcr: vi.fn(async () => ({ ...dims, lines: ocrLines })),
    generateLayout: vi.fn(async () => '{"titleBox": 0, "bulletBoxes": [1]}'),
    generateImage: vi.fn(async () => 'data:image/png;base64,BG'),
    regenerateObjects: vi.fn(async () => [
      { id: 'img-0', type: 'image' as const, nbbox: { x: 0.7, y: 0.2, w: 0.2, h: 0.3 }, assetId: 'obj1', z: 5 },
    ]),
    persistImage: vi.fn(async () => 'bg-asset'),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

const input = {
  slideId: 's1',
  slideIndex: 0,
  imagePath: '/abs/slide.png',
  imageDataUrl: 'data:image/png;base64,SLIDE',
  outline: { title: '제목', bullets: ['불릿'] },
};

const texts = (s: SlideSpec): TextElement[] => s.elements.filter((e): e is TextElement => e.type === 'text');
const images = (s: SlideSpec): ImageElement[] => s.elements.filter((e): e is ImageElement => e.type === 'image');

describe('decomposeSlide', () => {
  it('produces editable text (real outline text), a regenerated background plate, and object elements', async () => {
    const d = deps();
    const spec = await decomposeSlide(input, d);

    // text: real outline text, placed at the LLM-mapped boxes
    const t = texts(spec);
    expect(t.find((e) => e.role === 'title')?.text).toBe('제목');
    expect(t.find((e) => e.role === 'bullet')?.text).toBe('불릿');

    // background: regenerated clean plate, persisted, referenced by assetId
    expect(spec.background?.assetId).toBe('bg-asset');
    // bg prompt must forbid text/foreground and pass the original as a reference
    const bgCall = (d.generateImage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(bgCall.prompt.toLowerCase()).toMatch(/no text/);
    expect(bgCall.images).toEqual(['data:image/png;base64,SLIDE']);

    // objects: appended as image elements
    expect(images(spec).map((e) => e.assetId)).toEqual(['obj1']);
  });

  it('falls back to geometry mapping when gpt-5.5 returns garbage', async () => {
    const d = deps({ generateLayout: vi.fn(async () => 'not json at all') });
    const spec = await decomposeSlide(input, d);
    // geometry: title = tallest region (box 0). Still yields the real outline text.
    expect(texts(spec).find((e) => e.role === 'title')?.text).toBe('제목');
    expect(texts(spec).find((e) => e.role === 'title')?.nbbox.y).toBeCloseTo(40 / 562, 2);
  });

  it('still produces a spec when background regeneration fails (non-fatal)', async () => {
    const d = deps({ generateImage: vi.fn(async () => { throw new Error('bg down'); }) });
    const spec = await decomposeSlide(input, d);
    expect(spec.background).toBeNull();
    expect(texts(spec).length).toBeGreaterThan(0); // text still placed
  });

  it('still produces a spec when object regeneration fails (non-fatal)', async () => {
    const d = deps({ regenerateObjects: vi.fn(async () => { throw new Error('sam3 down'); }) });
    const spec = await decomposeSlide(input, d);
    expect(images(spec)).toHaveLength(0);
    expect(spec.background?.assetId).toBe('bg-asset'); // bg unaffected
  });
});
