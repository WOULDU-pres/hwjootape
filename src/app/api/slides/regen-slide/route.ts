import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import {
  persistImageResult,
  readAssetAsDataUrl,
  resolveAssetAbsolutePath,
} from '@/lib/projects/asset-store';
import { generateImage } from '@/lib/providers/god-tibo-provider';
import { parseOutline } from '@/lib/slides/deck';
import { generateDeckSlides } from '@/lib/slides/full-deck';
import { decomposeSlide } from '@/lib/slides/decompose-slide';
import { makeDecomposeDeps } from '@/lib/slides/decompose-server';
import { getStylePreset } from '@/lib/slides/style-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 6 (slide regenerate): re-bake ONE slide with a user requirement (folded into
 * the style direction, chosen-version samples as references), then re-decompose it into
 * an editable spec. Reuses the full-deck + decompose orchestrators.
 *
 * Body: { outlineText, presetId, styleHint?, slideIndex, requirement, referenceAssetIds? }
 * Returns: { slide: SlideSpec }
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const outlines = parseOutline(typeof body?.outlineText === 'string' ? body.outlineText : '');
    const slideIndex = Number(body?.slideIndex);
    if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= outlines.length) {
      return NextResponse.json({ error: '유효한 slideIndex 가 필요합니다.' }, { status: 400 });
    }
    const preset = getStylePreset(typeof body?.presetId === 'string' ? body.presetId : '');
    if (!preset) {
      return NextResponse.json({ error: '알 수 없는 presetId 입니다.' }, { status: 400 });
    }
    const requirement = typeof body?.requirement === 'string' ? body.requirement.trim() : '';
    const baseHint = typeof body?.styleHint === 'string' ? body.styleHint : '';
    // Fold the requirement into the style direction so codex honors it on the re-bake.
    const styleHint = [baseHint, requirement].filter(Boolean).join(' — ') || undefined;

    const referenceAssetIds: string[] = Array.isArray(body?.referenceAssetIds) ? body.referenceAssetIds : [];
    const referenceImages = (
      await Promise.all(referenceAssetIds.map((id) => readAssetAsDataUrl(projectRoot, id).catch(() => null)))
    ).filter((x): x is string => x !== null);

    // 1. Re-bake the single slide image.
    const baked = await generateDeckSlides(
      { jobs: [{ slideIndex, outline: outlines[slideIndex] }], preset, styleHint, referenceImages },
      { generateImage: (opts) => generateImage(opts) },
    );
    const dataUrl = baked.slides[0]?.dataUrl;
    if (!dataUrl) {
      return NextResponse.json({ error: baked.slides[0]?.error ?? '슬라이드 재생성 실패' }, { status: 502 });
    }
    const asset = await persistImageResult({
      projectRoot,
      imageDataUrl: dataUrl,
      prompt: `regen-slide:${preset.id} slide:${slideIndex} ${requirement}`,
      provider: 'god-tibo',
      type: 'edit',
      parentId: null,
    });

    // 2. Re-decompose the freshly baked slide.
    const slideId = `s-${slideIndex}`;
    const imagePath = await resolveAssetAbsolutePath(projectRoot, asset.historyEntry.assetId);
    const imageDataUrl = await readAssetAsDataUrl(projectRoot, asset.historyEntry.assetId);
    const slide = await decomposeSlide(
      { slideId, slideIndex, imagePath, imageDataUrl, outline: outlines[slideIndex], styleHint: baseHint || undefined },
      makeDecomposeDeps(projectRoot, slideId),
    );

    return NextResponse.json({ slide });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Slide regeneration failed';
    console.error('Regen-slide error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
