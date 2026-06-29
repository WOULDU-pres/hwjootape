import { NextResponse } from 'next/server';
import { readAsset } from '@/lib/projects/asset-store';
import { readProjectHistory, readProjectSettings } from '@/lib/projects/metadata-store';
import { resolveRequestProjectRoot } from '@/lib/projects/session';

export const runtime = 'nodejs';

function contentTypeForAssetPath(assetPath: string): string {
  if (assetPath.endsWith('.jpg') || assetPath.endsWith('.jpeg')) return 'image/jpeg';
  if (assetPath.endsWith('.webp')) return 'image/webp';
  if (assetPath.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await params;
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: 'No active BananaTape project' }, { status: 400 });
    }
    const [history, settings] = await Promise.all([
      readProjectHistory(projectRoot),
      readProjectSettings(projectRoot),
    ]);
    const entry = history.entries.find((item) => item.assetId === assetId)
      ?? settings.referenceImages.find((item) => item.assetId === assetId);
    if (!entry) return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    const buffer = await readAsset(projectRoot, assetId, entry.assetPath);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentTypeForAssetPath(entry.assetPath),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read asset';
    const status = message.includes('not found') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
