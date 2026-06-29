import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult, readAssetAsDataUrl } from '@/lib/projects/asset-store';
import { generateImage } from '@/lib/providers/god-tibo-provider';
import { parseOutline } from '@/lib/slides/deck';
import { generateDeckSlides, type DeckSlideJob } from '@/lib/slides/full-deck';
import { getStylePreset } from '@/lib/slides/style-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 3 entry point (ADR-0002): after a version is picked, render the FULL deck in
 * that style. Sample slides already generated for the chosen version are reused as-is;
 * every other slide is generated here with the chosen samples passed as god-tibo
 * references so the look stays consistent.
 *
 * Body: { outlineText, presetId, styleHint?, samples: { [slideIndex]: assetId } }
 *   - samples: the chosen version's already-generated slides, by slide index.
 * Returns: { slides: [{ slideIndex, assetId|null, error? }] }  (full deck, in order)
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }

    const body = await request.json();
    const outlines = parseOutline(typeof body?.outlineText === 'string' ? body.outlineText : '');
    if (outlines.length === 0) {
      return NextResponse.json({ error: '아웃라인이 비어 있습니다.' }, { status: 400 });
    }
    const preset = getStylePreset(typeof body?.presetId === 'string' ? body.presetId : '');
    if (!preset) {
      return NextResponse.json({ error: '알 수 없는 presetId 입니다.' }, { status: 400 });
    }
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;
    const samples: Record<string, string> =
      body?.samples && typeof body.samples === 'object' ? body.samples : {};

    // Reused sample slides (by index) vs. slides we still need to generate.
    const reused = new Map<number, string>();
    for (const [key, assetId] of Object.entries(samples)) {
      const idx = Number(key);
      if (Number.isInteger(idx) && idx >= 0 && idx < outlines.length && typeof assetId === 'string') {
        reused.set(idx, assetId);
      }
    }

    // Load the reused samples as data URLs to steer the new slides toward the same look.
    const referenceImages = (
      await Promise.all([...reused.values()].map((id) => readAssetAsDataUrl(projectRoot, id).catch(() => null)))
    ).filter((x): x is string => x !== null);

    const jobs: DeckSlideJob[] = [];
    outlines.forEach((outline, slideIndex) => {
      if (!reused.has(slideIndex)) jobs.push({ slideIndex, outline });
    });

    const result = await generateDeckSlides(
      { jobs, preset, styleHint, referenceImages },
      { generateImage: (opts) => generateImage(opts) },
    );

    // Persist newly generated slides → assetIds, indexed by slideIndex.
    const newAssetByIndex = new Map<number, { assetId: string | null; error?: string }>();
    await Promise.all(
      result.slides.map(async (slide) => {
        if (!slide.dataUrl) {
          newAssetByIndex.set(slide.slideIndex, { assetId: null, error: slide.error });
          return;
        }
        const asset = await persistImageResult({
          projectRoot,
          imageDataUrl: slide.dataUrl,
          prompt: `full-deck:${preset.id} slide:${slide.slideIndex}`,
          provider: 'god-tibo',
          type: 'generate',
          parentId: null,
        });
        newAssetByIndex.set(slide.slideIndex, { assetId: asset.historyEntry.assetId });
      }),
    );

    // Merge reused + new into the full ordered deck.
    const slides = outlines.map((_, slideIndex) => {
      if (reused.has(slideIndex)) {
        return { slideIndex, assetId: reused.get(slideIndex)!, reused: true };
      }
      const made = newAssetByIndex.get(slideIndex);
      return { slideIndex, assetId: made?.assetId ?? null, error: made?.error, reused: false };
    });

    return NextResponse.json({ slides, generated: result.generated, failed: result.failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Full-deck generation failed';
    console.error('Full-deck error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
