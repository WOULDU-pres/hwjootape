import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult } from '@/lib/projects/asset-store';
import { generateSlideDraft } from '@/lib/slides/pipeline';
import { buildDraftPrompt, type SlideOutline } from '@/lib/slides/deck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REFERENCE_IMAGES = 8;

function isOutline(v: unknown): v is SlideOutline {
  return Boolean(v && typeof v === 'object' && typeof (v as SlideOutline).title === 'string');
}

/** Does this god-tibo error look like the backend rejecting a reference image
 *  (vs. an unrelated failure we should surface)? Matches the backend's
 *  "does not represent a valid image" / invalid image-data responses. */
function isReferenceImageRejection(message: string): boolean {
  return /valid image|image data|invalid_value/i.test(message);
}

/** Reference image sources: base64 data URLs or http(s) URLs, passed straight to
 *  god-tibo (its image_url field accepts both). Capped and lightly validated. */
function parseReferenceImages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.startsWith('data:image/') || v.startsWith('http://') || v.startsWith('https://'))
    .slice(0, MAX_REFERENCE_IMAGES);
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const outline: SlideOutline = isOutline(body?.outline)
      ? { title: body.outline.title, bullets: Array.isArray(body.outline.bullets) ? body.outline.bullets : [] }
      : { title: '', bullets: [] };
    if (!outline.title.trim()) {
      return NextResponse.json({ error: 'outline.title is required' }, { status: 400 });
    }

    const referenceImages = parseReferenceImages(body?.referenceImages);
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;

    // Generate with references; if the backend rejects a reference image (bad
    // URL, unusable/degenerate image), degrade to outline-only so the draft
    // still generates instead of failing entirely, and tell the client.
    let dataUrl: string;
    let referencesDropped = false;
    try {
      ({ dataUrl } = await generateSlideDraft(outline, styleHint, referenceImages));
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (referenceImages.length > 0 && isReferenceImageRejection(msg)) {
        ({ dataUrl } = await generateSlideDraft(outline, styleHint, []));
        referencesDropped = true;
      } else {
        throw error;
      }
    }

    const persisted = await persistImageResult({
      projectRoot,
      imageDataUrl: dataUrl,
      prompt: buildDraftPrompt(outline, body?.styleHint),
      provider: 'god-tibo',
      type: 'generate',
    });

    return NextResponse.json({
      success: true,
      assetId: persisted.historyEntry.assetId,
      assetPath: persisted.historyEntry.assetPath,
      assetUrl: persisted.assetUrl,
      referencesDropped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Draft generation failed';
    console.error('Slide draft error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
