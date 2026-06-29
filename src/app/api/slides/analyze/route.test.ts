import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRequestProjectRoot: vi.fn<(r: Request) => Promise<string | null>>(),
  resolveAssetAbsolutePath: vi.fn<(root: string, id: string) => Promise<string>>(),
  runOcr: vi.fn(),
  runSam3Segments: vi.fn(),
}));

vi.mock('@/lib/projects/session', () => ({ resolveRequestProjectRoot: mocks.resolveRequestProjectRoot }));
vi.mock('@/lib/projects/asset-store', () => ({ resolveAssetAbsolutePath: mocks.resolveAssetAbsolutePath }));
vi.mock('@/lib/slides/ocr-runner', () => ({ runOcr: mocks.runOcr }));
vi.mock('@/lib/slides/sam3', () => ({ runSam3Segments: mocks.runSam3Segments }));

import { POST } from './route';

function req(body: unknown): Request {
  return new Request('http://localhost/api/slides/analyze?project=demo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestProjectRoot.mockResolvedValue('/proj');
  mocks.resolveAssetAbsolutePath.mockImplementation(async (_r, id) => `/proj/assets/${id}.png`);
});

describe('POST /api/slides/analyze', () => {
  it('returns OCR + SAM3 regions and flags which segments decompose would keep vs drop', async () => {
    mocks.runOcr.mockResolvedValue({
      imageWidth: 1000,
      imageHeight: 562,
      lines: [{ text: '제목', confidence: 1, bbox: { x: 50, y: 40, width: 400, height: 80 } }],
    });
    mocks.runSam3Segments.mockResolvedValue([
      { id: 'logo', label: 'logo', bbox: { x: 700, y: 300, width: 120, height: 120 } }, // no overlap -> kept
      { id: 'titletext', label: 'segment', bbox: { x: 55, y: 45, width: 380, height: 70 } }, // over the title OCR -> dropped
    ]);

    const res = await POST(req({ slides: [{ slideIndex: 0, assetId: 'a0' }] }));
    const json = await res.json();

    expect(json.results).toHaveLength(1);
    const r = json.results[0];
    expect(r).toMatchObject({ slideIndex: 0, assetId: 'a0', imageWidth: 1000, imageHeight: 562 });
    expect(r.ocr).toEqual([{ text: '제목', bbox: { x: 50, y: 40, width: 400, height: 80 } }]);
    const kept = Object.fromEntries(r.segments.map((s: { id: string; kept: boolean }) => [s.id, s.kept]));
    expect(kept).toEqual({ logo: true, titletext: false });
  });

  it('isolates a per-slide analyze failure', async () => {
    mocks.runOcr.mockRejectedValue(new Error('ocr binary missing'));
    mocks.runSam3Segments.mockResolvedValue([]);
    const res = await POST(req({ slides: [{ slideIndex: 0, assetId: 'a0' }] }));
    const json = await res.json();
    expect(json.results).toHaveLength(0);
    expect(json.failures).toEqual([{ slideIndex: 0, error: 'ocr binary missing' }]);
  });

  it('400s when no valid slides are given', async () => {
    const res = await POST(req({ slides: [] }));
    expect(res.status).toBe(400);
  });
});
