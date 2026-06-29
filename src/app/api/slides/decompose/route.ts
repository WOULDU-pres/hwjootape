import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult } from '@/lib/projects/asset-store';
import { resolveInsideProject } from '@/lib/projects/paths';
import { decomposeDraft } from '@/lib/slides/pipeline';
import { cleanBackground } from '@/lib/slides/pptx-runner';
import { regenerateImageElements } from '@/lib/slides/regenerate';
import { layoutEmbedImages, srcToDataUrl, type EmbedImageDims } from '@/lib/slides/embed';
import type { SlideOutline } from '@/lib/slides/deck';

interface EmbedImageInput {
  src: string;
  name?: string;
  width?: number;
  height?: number;
}

/** Parse the embed images the user attached to the outline (role: "embed"):
 *  each is placed onto the slide as-is. Dims (from the browser) drive aspect. */
function parseEmbedImages(value: unknown): EmbedImageInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'))
    .map((v) => ({
      src: typeof v.src === 'string' ? v.src.trim() : '',
      name: typeof v.name === 'string' ? v.name : undefined,
      width: typeof v.width === 'number' && Number.isFinite(v.width) ? v.width : undefined,
      height: typeof v.height === 'number' && Number.isFinite(v.height) ? v.height : undefined,
    }))
    .filter((v) => v.src.startsWith('data:image/') || v.src.startsWith('http://') || v.src.startsWith('https://'))
    .slice(0, 12);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let scratch: string | null = null;
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const slideId: string = typeof body?.slideId === 'string' ? body.slideId : 's1';
    const draftAssetPath: string | undefined = typeof body?.draftAssetPath === 'string' ? body.draftAssetPath : undefined;
    const draftAssetId: string | undefined = typeof body?.draftAssetId === 'string' ? body.draftAssetId : undefined;
    const outline: SlideOutline = {
      title: typeof body?.outline?.title === 'string' ? body.outline.title : '',
      bullets: Array.isArray(body?.outline?.bullets) ? body.outline.bullets : [],
    };
    if (!draftAssetPath) {
      return NextResponse.json({ error: 'draftAssetPath is required' }, { status: 400 });
    }

    const draftAbsPath = await resolveInsideProject(projectRoot, draftAssetPath);

    const { spec, wipeBoxes, ocrLines, draftDims } = await decomposeDraft({ slideId, draftPath: draftAbsPath, outline, draftAssetId });

    // Wipe baked draft text -> clean background, persisted as a project asset.
    // Transient files go in a per-request scratch dir that is removed in `finally`.
    const tmpDir = await resolveInsideProject(projectRoot, 'tmp');
    scratch = await mkdtemp(path.join(tmpDir, 'decompose-'));
    const cleanedPath = path.join(scratch, 'bg.png');
    await cleanBackground(draftAbsPath, wipeBoxes, { outPath: cleanedPath, tmpDir: scratch });
    const cleanedBuf = await readFile(cleanedPath);
    const bgAsset = await persistImageResult({
      projectRoot,
      imageDataUrl: `data:image/png;base64,${cleanedBuf.toString('base64')}`,
      prompt: 'cleaned slide background',
      provider: 'god-tibo',
      type: 'edit',
      parentId: draftAssetId ?? null,
    });

    spec.background = { assetId: bgAsset.historyEntry.assetId };

    // Phase 2 (D4): regenerate non-text image elements via SAM3 + god-tibo img2img,
    // with a fidelity gate + raw-cutout fallback. Default on; slow (~per-element god-tibo).
    const regenerate = body?.regenerateImages !== false;
    const imageElements: Array<{ source: string; fidelity: number }> = [];
    if (regenerate) {
      const els = await regenerateImageElements({ draftPath: draftAbsPath, ocrLines, dims: draftDims, workDir: scratch });
      for (const [i, el] of els.entries()) {
        const buf = await readFile(el.pngPath);
        const asset = await persistImageResult({
          projectRoot,
          imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`,
          prompt: `image element: ${el.label} (${el.source})`,
          provider: 'god-tibo',
          type: 'edit',
          parentId: draftAssetId ?? null,
        });
        spec.elements.push({ id: `i-${i}`, type: 'image', nbbox: el.nbbox, assetId: asset.historyEntry.assetId, z: el.z });
        imageElements.push({ source: el.source, fidelity: el.fidelity });
      }
    }

    // Embed images: user-attached pictures placed onto the slide as-is (role:
    // "embed"). Persist each as a project asset and append an image element with
    // an aspect-correct placement (the sidecar stretches to nbbox, so aspect
    // must match — dims come from the browser).
    const embedImages = parseEmbedImages(body?.embedImages);
    let embedCount = 0;
    let embedSkipped = 0;
    if (embedImages.length > 0) {
      // Resolve sequentially with graceful degradation: one bad/oversized/invalid
      // embed must not abort the whole decompose, and we cap total embed bytes
      // (data-URL inflation across up to 12 images could otherwise OOM).
      const MAX_TOTAL_EMBED_BYTES = 60 * 1024 * 1024;
      const resolved: Array<{ dataUrl: string; dims: EmbedImageDims; name?: string }> = [];
      let totalBytes = 0;
      for (const img of embedImages) {
        const width = img.width ?? 0;
        const height = img.height ?? 0;
        // Unknown dims → unknown aspect; the sidecar stretches to nbbox, so we
        // skip rather than fabricate an aspect and ship a distorted picture.
        if (!(width > 0 && height > 0)) { embedSkipped++; continue; }
        try {
          const { dataUrl } = await srcToDataUrl(img.src);
          const approxBytes = Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
          if (totalBytes + approxBytes > MAX_TOTAL_EMBED_BYTES) { embedSkipped++; continue; }
          totalBytes += approxBytes;
          resolved.push({ dataUrl, dims: { width, height }, name: img.name });
        } catch (err) {
          console.error('Embed image resolve failed:', err);
          embedSkipped++;
        }
      }
      const boxes = layoutEmbedImages(resolved.map((r) => r.dims));
      for (const [i, r] of resolved.entries()) {
        const asset = await persistImageResult({
          projectRoot,
          imageDataUrl: r.dataUrl,
          prompt: `embedded image: ${r.name ?? `embed-${i}`}`,
          provider: 'god-tibo',
          type: 'edit',
          parentId: draftAssetId ?? null,
        });
        const box = boxes[i];
        spec.elements.push({
          id: `embed-${i}`,
          type: 'image',
          nbbox: { x: box.x, y: box.y, w: box.w, h: box.h },
          assetId: asset.historyEntry.assetId,
          z: box.z,
        });
        embedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      spec,
      backgroundAssetId: bgAsset.historyEntry.assetId,
      backgroundAssetPath: bgAsset.historyEntry.assetPath,
      wipeCount: wipeBoxes.length,
      imageElements,
      embedCount,
      embedSkipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Decompose failed';
    console.error('Slide decompose error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
