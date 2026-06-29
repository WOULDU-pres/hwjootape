import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult, readAssetAsDataUrl } from '@/lib/projects/asset-store';
import { generateImage } from '@/lib/providers/god-tibo-provider';
import { regenerateElementImage } from '@/lib/slides/regen-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Phase 6 (element regenerate): regenerate one image/background element with a user
 * requirement, using its current image as a style reference. Returns a new assetId
 * the client swaps onto the element.
 *
 * Body: { requirement, currentAssetId? }
 * Returns: { assetId }
 */
export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const requirement = typeof body?.requirement === 'string' ? body.requirement.trim() : '';
    if (!requirement) {
      return NextResponse.json({ error: 'requirement 가 필요합니다.' }, { status: 400 });
    }
    const currentAssetId = typeof body?.currentAssetId === 'string' ? body.currentAssetId : undefined;
    const currentImageDataUrl = currentAssetId
      ? await readAssetAsDataUrl(projectRoot, currentAssetId).catch(() => undefined)
      : undefined;

    const dataUrl = await regenerateElementImage(
      { currentImageDataUrl, requirement },
      { generateImage: (opts) => generateImage(opts) },
    );
    const asset = await persistImageResult({
      projectRoot,
      imageDataUrl: dataUrl,
      prompt: `regen-element: ${requirement}`,
      provider: 'god-tibo',
      type: 'edit',
      parentId: currentAssetId ?? null,
    });
    return NextResponse.json({ assetId: asset.historyEntry.assetId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Element regeneration failed';
    console.error('Regen-element error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
