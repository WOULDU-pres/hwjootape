/**
 * decompose-server — wires the REAL sidecars (OCR, SAM3 object regen, god-tibo,
 * project asset persistence) into the injectable `DecomposeSlideDeps` used by
 * `decomposeSlide`. Kept separate from the pure orchestrator so the orchestrator stays
 * unit-testable, and shared by every route that decomposes (decompose-deck, regen-slide).
 */
import { readFile, rm } from 'node:fs/promises';
import { persistImageResult } from '@/lib/projects/asset-store';
import { resolveInsideProject } from '@/lib/projects/paths';
import { generateImage, generateLayout } from '@/lib/providers/god-tibo-provider';
import { runOcr } from './ocr-runner';
import { regenerateImageElements } from './regenerate';
import type { DecomposeSlideDeps } from './decompose-slide';
import type { ImageElement } from './spec';

export function makeDecomposeDeps(projectRoot: string, slideId: string): DecomposeSlideDeps {
  const persistImage = async (dataUrl: string, label: string) => {
    const asset = await persistImageResult({
      projectRoot,
      imageDataUrl: dataUrl,
      prompt: label,
      provider: 'god-tibo',
      type: 'generate',
      parentId: null,
    });
    return asset.historyEntry.assetId;
  };

  return {
    runOcr: (p) => runOcr(p),
    generateLayout: (opts) => generateLayout(opts),
    generateImage: (opts) => generateImage(opts),
    persistImage,
    regenerateObjects: async ({ imagePath, ocrLines, draftDims }) => {
      const workDir = await resolveInsideProject(projectRoot, `tmp/decompose-${slideId}`);
      try {
        const objects = await regenerateImageElements({ draftPath: imagePath, ocrLines, dims: draftDims, workDir });
        return await Promise.all(
          objects.map(async (obj, i): Promise<ImageElement> => {
            const buf = await readFile(obj.pngPath);
            const assetId = await persistImage(
              `data:image/png;base64,${buf.toString('base64')}`,
              `object:${slideId}:${i}`,
            );
            return { id: `img-${slideId}-${i}`, type: 'image', nbbox: obj.nbbox, assetId, z: obj.z };
          }),
        );
      } finally {
        // Object PNGs are now persisted as assets; reclaim the scratch dir so it
        // doesn't accumulate in the user's project folder across runs.
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
