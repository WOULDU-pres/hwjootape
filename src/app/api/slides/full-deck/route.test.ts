import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestProjectRoot: vi.fn<(r: Request) => Promise<string | null>>(),
  generateImage: vi.fn<(o: { prompt: string; images?: string[] }) => Promise<string>>(),
  persistImageResult: vi.fn(),
  readAssetAsDataUrl: vi.fn<(root: string, id: string) => Promise<string>>(),
}));

vi.mock('@/lib/projects/session', () => ({ resolveRequestProjectRoot: mocks.resolveRequestProjectRoot }));
vi.mock('@/lib/providers/god-tibo-provider', () => ({ generateImage: mocks.generateImage }));
vi.mock('@/lib/projects/asset-store', () => ({
  persistImageResult: mocks.persistImageResult,
  readAssetAsDataUrl: mocks.readAssetAsDataUrl,
}));

import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/slides/full-deck?project=demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OUTLINE_4 = ['# T1', '---', '# T2', '---', '# T3', '---', '# T4'].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestProjectRoot.mockResolvedValue('/proj');
  mocks.generateImage.mockResolvedValue('data:image/png;base64,NEW');
  mocks.readAssetAsDataUrl.mockImplementation(async (_root, id) => `data:ref:${id}`);
  let n = 0;
  mocks.persistImageResult.mockImplementation(async () => ({
    historyEntry: { assetId: `new-${++n}` },
    assetUrl: `/api/projects/assets/new-${n}`,
  }));
});

describe('POST /api/slides/full-deck', () => {
  it('reuses sample slides, generates only the rest, and merges into an ordered deck', async () => {
    const res = await POST(req({ outlineText: OUTLINE_4, presetId: 'minimal', samples: { 0: 'a0', 2: 'a2' } }));
    const json = await res.json();

    // Only the two NON-sample slides (indices 1 and 3) are generated.
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    const prompts = mocks.generateImage.mock.calls.map((c) => c[0].prompt);
    expect(prompts.some((p) => p.includes('T2'))).toBe(true);
    expect(prompts.some((p) => p.includes('T4'))).toBe(true);
    expect(prompts.some((p) => p.includes('T1') || p.includes('T3'))).toBe(false);

    // Reused samples are loaded and forwarded as god-tibo references.
    expect(mocks.readAssetAsDataUrl).toHaveBeenCalledWith('/proj', 'a0');
    expect(mocks.readAssetAsDataUrl).toHaveBeenCalledWith('/proj', 'a2');
    expect(mocks.generateImage.mock.calls[0][0].images).toEqual(['data:ref:a0', 'data:ref:a2']);

    // Ordered 4-slide deck: reused keep their assetIds, new ones are persisted.
    expect(json.slides).toHaveLength(4);
    expect(json.slides.map((s: { slideIndex: number }) => s.slideIndex)).toEqual([0, 1, 2, 3]);
    expect(json.slides[0]).toMatchObject({ slideIndex: 0, assetId: 'a0', reused: true });
    expect(json.slides[2]).toMatchObject({ slideIndex: 2, assetId: 'a2', reused: true });
    expect(json.slides[1].reused).toBe(false);
    expect(json.slides[1].assetId).toMatch(/^new-/);
    expect(json.slides[3].reused).toBe(false);
  });

  it('ignores out-of-range / malformed sample keys', async () => {
    await POST(req({ outlineText: OUTLINE_4, presetId: 'minimal', samples: { 9: 'x', '-1': 'y' } }));
    // No valid reuse → all 4 slides generated.
    expect(mocks.generateImage).toHaveBeenCalledTimes(4);
    expect(mocks.readAssetAsDataUrl).not.toHaveBeenCalled();
  });

  it('surfaces a per-slide generation failure as assetId:null without aborting the deck', async () => {
    mocks.generateImage.mockImplementation(async ({ prompt }) => {
      if (prompt.includes('T2')) throw new Error('boom');
      return 'data:image/png;base64,NEW';
    });
    const res = await POST(req({ outlineText: OUTLINE_4, presetId: 'minimal', samples: { 0: 'a0' } }));
    const json = await res.json();
    expect(json.failed).toBe(1);
    expect(json.slides[1].assetId).toBeNull();
    expect(json.slides[0].assetId).toBe('a0');
  });

  it('400s on an unknown presetId', async () => {
    const res = await POST(req({ outlineText: OUTLINE_4, presetId: 'nope', samples: {} }));
    expect(res.status).toBe(400);
  });
});
