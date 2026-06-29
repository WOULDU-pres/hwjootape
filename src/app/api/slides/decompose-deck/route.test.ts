import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlideSpec } from '@/lib/slides/spec';

const mocks = vi.hoisted(() => ({
  resolveRequestProjectRoot: vi.fn<(r: Request) => Promise<string | null>>(),
  resolveAssetAbsolutePath: vi.fn<(root: string, id: string) => Promise<string>>(),
  readAssetAsDataUrl: vi.fn<(root: string, id: string) => Promise<string>>(),
  decomposeSlide: vi.fn(),
  makeDecomposeDeps: vi.fn(() => ({})),
}));

vi.mock('@/lib/projects/session', () => ({ resolveRequestProjectRoot: mocks.resolveRequestProjectRoot }));
vi.mock('@/lib/projects/asset-store', () => ({
  resolveAssetAbsolutePath: mocks.resolveAssetAbsolutePath,
  readAssetAsDataUrl: mocks.readAssetAsDataUrl,
}));
vi.mock('@/lib/slides/decompose-slide', () => ({ decomposeSlide: mocks.decomposeSlide }));
vi.mock('@/lib/slides/decompose-server', () => ({ makeDecomposeDeps: mocks.makeDecomposeDeps }));

import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/slides/decompose-deck?project=demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OUTLINE_3 = ['# T1', '---', '# T2', '---', '# T3'].join('\n');
const spec = (id: string): SlideSpec => ({ slideId: id, background: null, elements: [] });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestProjectRoot.mockResolvedValue('/proj');
  mocks.resolveAssetAbsolutePath.mockImplementation(async (_r, id) => `/proj/assets/${id}.png`);
  mocks.readAssetAsDataUrl.mockImplementation(async (_r, id) => `data:img:${id}`);
});

describe('POST /api/slides/decompose-deck', () => {
  it('isolates a per-slide failure: good slides land in deck, the failure in failures', async () => {
    mocks.decomposeSlide.mockImplementation(async (input: { slideIndex: number; slideId: string }) => {
      if (input.slideIndex === 1) throw new Error('sam3 down');
      return spec(input.slideId);
    });

    const res = await POST(
      req({
        outlineText: OUTLINE_3,
        slides: [
          { slideIndex: 0, assetId: 'a0' },
          { slideIndex: 1, assetId: 'a1' },
          { slideIndex: 2, assetId: 'a2' },
        ],
      }),
    );
    const json = await res.json();

    expect(json.deck).toHaveLength(2);
    expect(json.deck.map((s: SlideSpec) => s.slideId).sort()).toEqual(['s-0', 's-2']);
    expect(json.failures).toEqual([{ slideIndex: 1, error: 'sam3 down' }]);
  });

  it('passes each slide its matching outline', async () => {
    mocks.decomposeSlide.mockImplementation(async (input: { slideId: string }) => spec(input.slideId));
    await POST(req({ outlineText: OUTLINE_3, slides: [{ slideIndex: 2, assetId: 'a2' }] }));
    const call = mocks.decomposeSlide.mock.calls[0][0] as { outline: { title: string }; imageDataUrl: string };
    expect(call.outline.title).toBe('T3');
    expect(call.imageDataUrl).toBe('data:img:a2');
  });

  it('drops out-of-range slideIndex before decomposing', async () => {
    mocks.decomposeSlide.mockResolvedValue(spec('x'));
    const res = await POST(req({ outlineText: OUTLINE_3, slides: [{ slideIndex: 9, assetId: 'a9' }] }));
    expect(res.status).toBe(400); // no valid slides remain
    expect(mocks.decomposeSlide).not.toHaveBeenCalled();
  });
});
