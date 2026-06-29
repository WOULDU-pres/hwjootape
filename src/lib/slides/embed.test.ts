import { describe, it, expect } from 'vitest';
import { layoutEmbedImages, srcToDataUrl } from './embed';

function within01(b: { x: number; y: number; w: number; h: number }): boolean {
  return b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001;
}

describe('layoutEmbedImages', () => {
  it('returns nothing for no images', () => {
    expect(layoutEmbedImages([])).toEqual([]);
  });

  it('preserves a landscape image aspect ratio and stays on the slide', () => {
    const [box] = layoutEmbedImages([{ width: 1600, height: 900 }]);
    expect(box.w / box.h).toBeCloseTo(1600 / 900, 2);
    expect(within01(box)).toBe(true);
    // sits in the bottom band
    expect(box.y).toBeGreaterThanOrEqual(0.58 - 1e-9);
  });

  it('preserves a portrait image aspect ratio (height-limited)', () => {
    const [box] = layoutEmbedImages([{ width: 900, height: 1600 }]);
    expect(box.w / box.h).toBeCloseTo(900 / 1600, 2);
    expect(within01(box)).toBe(true);
  });

  it('lays out multiple images without horizontal overlap and increments z', () => {
    const boxes = layoutEmbedImages([
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
      { width: 1000, height: 1000 },
    ]);
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(within01(b)).toBe(true);
    // ordered left-to-right, non-overlapping
    expect(boxes[0].x + boxes[0].w).toBeLessThanOrEqual(boxes[1].x + 1e-9);
    expect(boxes[1].x + boxes[1].w).toBeLessThanOrEqual(boxes[2].x + 1e-9);
    expect(boxes[0].z).toBe(100);
    expect(boxes[2].z).toBe(102);
  });

  it('falls back to a square when dims are missing', () => {
    const [box] = layoutEmbedImages([{ width: 0, height: 0 }]);
    expect(box.w / box.h).toBeCloseTo(1, 2);
    expect(within01(box)).toBe(true);
  });
});

function fakeResponse(opts: { ok?: boolean; status?: number; contentType?: string; bytes?: Uint8Array }): Response {
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3, 4]);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? 'image/png' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('srcToDataUrl', () => {
  it('passes data URLs through and parses their mime', async () => {
    const dataUrl = 'data:image/jpeg;base64,AAAA';
    const out = await srcToDataUrl(dataUrl, (async () => { throw new Error('should not fetch'); }) as typeof fetch);
    expect(out.dataUrl).toBe(dataUrl);
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('re-encodes non-base64 data URLs to base64 so persistence does not throw', async () => {
    const svg = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E';
    const out = await srcToDataUrl(svg, (async () => { throw new Error('should not fetch'); }) as typeof fetch);
    expect(out.mimeType).toBe('image/svg+xml');
    expect(out.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(out.dataUrl.split(',')[1], 'base64').toString('utf8')).toBe('<svg></svg>');
  });

  it('fetches http(s) URLs and re-encodes as a data URL', async () => {
    const fetchImpl = (async () => fakeResponse({ contentType: 'image/png', bytes: new Uint8Array([255, 216, 255]) })) as unknown as typeof fetch;
    const out = await srcToDataUrl('https://example.com/a.png', fetchImpl);
    expect(out.mimeType).toBe('image/png');
    expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects non-image content types', async () => {
    const fetchImpl = (async () => fakeResponse({ contentType: 'text/html' })) as unknown as typeof fetch;
    await expect(srcToDataUrl('https://example.com/x', fetchImpl)).rejects.toThrow(/이미지가 아닙니다/);
  });

  it('rejects non-http protocols', async () => {
    await expect(srcToDataUrl('ftp://example.com/x.png')).rejects.toThrow(/http/);
  });

  it('rejects failed responses', async () => {
    const fetchImpl = (async () => fakeResponse({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(srcToDataUrl('https://example.com/missing.png', fetchImpl)).rejects.toThrow(/404/);
  });
});
