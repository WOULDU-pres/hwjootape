import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { resolveAssetAbsolutePath } from '@/lib/projects/asset-store';
import { runOcr } from '@/lib/slides/ocr-runner';
import { runSam3Segments } from '@/lib/slides/sam3';
import { detectImageRegions } from '@/lib/slides/regenerate';
import { runWithConcurrency } from '@/lib/slides/gen-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** OCR + SAM3 are local but heavy; analyze a couple of slides at a time. */
const CONCURRENCY = 2;

/**
 * Decomposition PREVIEW (ADR-0002 transparency): show how a slide WOULD be cut up
 * before committing to the (slow, costly) full decompose. Runs only the local
 * detectors — Apple Vision OCR for text regions and SAM3 for object segments — and
 * returns their pixel boxes plus, for each segment, whether decompose would KEEP it
 * (treated as an image object) or DROP it (overlaps a text region). No god-tibo calls,
 * no asset persistence — purely diagnostic.
 *
 * Body: { slides: [{ slideIndex, assetId }] }
 * Returns: { results: [{ slideIndex, assetId, imageWidth, imageHeight,
 *            ocr: [{text, bbox}], segments: [{id, label, bbox, kept}] }], failures }
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const slides: Array<{ slideIndex: number; assetId: string }> = Array.isArray(body?.slides)
      ? body.slides.filter((s: unknown) => {
          const slide = s as { slideIndex?: unknown; assetId?: unknown };
          return Number.isInteger(slide.slideIndex) && typeof slide.assetId === 'string';
        })
      : [];
    if (slides.length === 0) {
      return NextResponse.json({ error: 'slides (slideIndex + assetId) is required' }, { status: 400 });
    }

    const failures: Array<{ slideIndex: number; error: string }> = [];
    const results = await runWithConcurrency(
      slides.map((slide) => async () => {
        try {
          const imagePath = await resolveAssetAbsolutePath(projectRoot, slide.assetId);
          const ocr = await runOcr(imagePath);
          const segments = await runSam3Segments(imagePath);
          const keptIds = new Set(detectImageRegions(segments, ocr.lines).map((s) => s.id));
          return {
            slideIndex: slide.slideIndex,
            assetId: slide.assetId,
            imageWidth: ocr.imageWidth,
            imageHeight: ocr.imageHeight,
            ocr: ocr.lines.map((l) => ({ text: l.text, bbox: l.bbox })),
            segments: segments.map((s) => ({ id: s.id, label: s.label, bbox: s.bbox, kept: keptIds.has(s.id) })),
          };
        } catch (error) {
          failures.push({ slideIndex: slide.slideIndex, error: error instanceof Error ? error.message : 'analyze failed' });
          return null;
        }
      }),
      CONCURRENCY,
    );

    return NextResponse.json({ results: results.filter(Boolean), failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analyze failed';
    console.error('Analyze error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
