import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { readAssetAsDataUrl, resolveAssetAbsolutePath } from '@/lib/projects/asset-store';
import { parseOutline } from '@/lib/slides/deck';
import { decomposeSlide } from '@/lib/slides/decompose-slide';
import { makeDecomposeDeps } from '@/lib/slides/decompose-server';
import { runWithConcurrency } from '@/lib/slides/gen-pool';
import type { SlideSpec } from '@/lib/slides/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Slides are heavy (OCR + SAM3 + multiple god-tibo calls); decompose a few at a time. */
const SLIDE_CONCURRENCY = 2;

/**
 * Phase 4 entry point (ADR-0002): decompose the chosen full deck into editable specs.
 * Each slide: OCR → gpt-5.5 text mapping → real outline text → clean background plate
 * (god-tibo) → foreground objects (SAM3 + god-tibo). Per-slide failures are isolated.
 *
 * Body: { outlineText, styleHint?, slides: [{ slideIndex, assetId }] }
 * Returns: { deck: SlideSpec[], failures: [{ slideIndex, error }] }
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }

    const body = await request.json();
    const outlines = parseOutline(typeof body?.outlineText === 'string' ? body.outlineText : '');
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;
    const slides: Array<{ slideIndex: number; assetId: string }> = Array.isArray(body?.slides)
      ? body.slides.filter((s: unknown) => {
          const slide = s as { slideIndex?: unknown; assetId?: unknown };
          return (
            Number.isInteger(slide.slideIndex) &&
            (slide.slideIndex as number) >= 0 &&
            (slide.slideIndex as number) < outlines.length &&
            typeof slide.assetId === 'string'
          );
        })
      : [];
    if (slides.length === 0) {
      return NextResponse.json({ error: 'slides (slideIndex + assetId) is required' }, { status: 400 });
    }

    const failures: Array<{ slideIndex: number; error: string }> = [];
    const results = await runWithConcurrency(
      slides.map((slide) => async (): Promise<SlideSpec | null> => {
        try {
          const imagePath = await resolveAssetAbsolutePath(projectRoot, slide.assetId);
          const imageDataUrl = await readAssetAsDataUrl(projectRoot, slide.assetId);
          const slideId = `s-${slide.slideIndex}`;
          const outline = outlines[slide.slideIndex] ?? { title: '', bullets: [] };

          return await decomposeSlide(
            { slideId, slideIndex: slide.slideIndex, imagePath, imageDataUrl, outline, styleHint },
            makeDecomposeDeps(projectRoot, slideId),
          );
        } catch (error) {
          failures.push({
            slideIndex: slide.slideIndex,
            error: error instanceof Error ? error.message : 'decompose failed',
          });
          return null;
        }
      }),
      SLIDE_CONCURRENCY,
    );

    const deck = results.filter((s): s is SlideSpec => s !== null);
    return NextResponse.json({ deck, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Decompose failed';
    console.error('Decompose-deck error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
