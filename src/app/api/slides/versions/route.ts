import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult } from '@/lib/projects/asset-store';
import { generateImage } from '@/lib/providers/god-tibo-provider';
import { parseOutline } from '@/lib/slides/deck';
import { generateVersions } from '@/lib/slides/versions';
import { STYLE_PRESETS, DEFAULT_VERSION_COUNT, type StylePreset } from '@/lib/slides/style-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 1 entry point (ADR-0002): generate design VERSIONS for the version picker.
 * Each version = a style preset; each is previewed by representative sample slides.
 *
 * Body: { outlineText, styleHint?, presetIds?, sampleCount? }
 *   - presetIds: optional subset of preset ids. Lets the client fan out one request
 *     per version for a progressive grid, OR omit to get the default 8 in one call.
 * Returns: { versions: [{ presetId, presetName, samples: [{ slideIndex, assetId|null, error? }] }],
 *            generated, failed }
 *
 * Sample data URLs are persisted to the project asset store; the response carries
 * assetIds so the picker loads them via /api/projects/assets/[assetId].
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }

    const body = await request.json();
    const outlineText = typeof body?.outlineText === 'string' ? body.outlineText : '';
    const outlines = parseOutline(outlineText);
    if (outlines.length === 0) {
      return NextResponse.json({ error: '아웃라인이 비어 있습니다.' }, { status: 400 });
    }
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;
    const sampleCount = typeof body?.sampleCount === 'number' ? body.sampleCount : undefined;

    // Resolve which presets to render: an explicit subset (by id) or the default 8.
    let presets: StylePreset[];
    if (Array.isArray(body?.presetIds) && body.presetIds.length > 0) {
      const ids = new Set(body.presetIds as string[]);
      presets = STYLE_PRESETS.filter((p) => ids.has(p.id));
      if (presets.length === 0) {
        return NextResponse.json({ error: '알 수 없는 presetIds 입니다.' }, { status: 400 });
      }
    } else {
      presets = STYLE_PRESETS.slice(0, DEFAULT_VERSION_COUNT);
    }

    const result = await generateVersions(
      { outlines, styleHint, presets, sampleCount },
      { generateImage: (opts) => generateImage(opts) },
    );

    // Persist each produced sample and swap the data URL for an assetId.
    const versions = await Promise.all(
      result.versions.map(async (version) => {
        const samples = await Promise.all(
          version.samples.map(async (sample) => {
            if (!sample.dataUrl) {
              return { slideIndex: sample.slideIndex, assetId: null as string | null, error: sample.error };
            }
            const asset = await persistImageResult({
              projectRoot,
              imageDataUrl: sample.dataUrl,
              prompt: `version:${version.presetId} slide:${sample.slideIndex}`,
              provider: 'god-tibo',
              type: 'generate',
              parentId: null,
            });
            return { slideIndex: sample.slideIndex, assetId: asset.historyEntry.assetId };
          }),
        );
        return { presetId: version.presetId, presetName: version.presetName, samples };
      }),
    );

    return NextResponse.json({ versions, generated: result.generated, failed: result.failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Version generation failed';
    console.error('Slide versions error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
