"use client";

import { useCallback } from 'react';
import { buildMagicLayerComposite, type MagicLayerSegment } from '@/lib/canvas/magic-layer';
import { useCanvasStore } from '@/stores/useCanvasStore';
import { useEditorStore } from '@/stores/useEditorStore';

async function imageUrlToFile(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Unable to read selected image pixels');
  const blob = await response.blob();
  return new File([blob], 'magic-layer-source.png', { type: blob.type || 'image/png' });
}

interface MagicLayerApiResponse {
  success?: boolean;
  source?: 'sam3' | 'fallback';
  segments?: MagicLayerSegment[];
  error?: string;
}

export function useMagicLayers() {
  const focusedImageIds = useCanvasStore((s) => s.focusedImageIds);
  const focusedImage = useCanvasStore((s) => s.focusedImageIds.length === 1 ? s.images[s.focusedImageIds[0]] : undefined);

  const canActivateMagicLayer = Boolean(focusedImage && focusedImage.status === 'ready' && focusedImage.size.width > 0 && focusedImage.size.height > 0);
  const isSegmenting = focusedImage?.magicLayerStatus === 'segmenting';

  const activateMagicLayer = useCallback(async () => {
    const imageId = focusedImageIds.length === 1 ? focusedImageIds[0] : null;
    if (!imageId) return;
    const image = useCanvasStore.getState().images[imageId];
    if (!image || image.status !== 'ready') return;

    const store = useCanvasStore.getState();
    store.setMagicLayerStatus(imageId, 'segmenting');
    try {
      const file = await imageUrlToFile(image.url);
      const formData = new FormData();
      formData.set('image', file);
      formData.set('width', String(image.size.width));
      formData.set('height', String(image.size.height));

      const response = await fetch('/api/magic-layer', { method: 'POST', body: formData });
      const payload = await response.json() as MagicLayerApiResponse;
      if (!response.ok || !payload.segments?.length) {
        throw new Error(payload.error || 'Magic Layer did not find movable elements');
      }

      const composite = await buildMagicLayerComposite({
        imageUrl: image.url,
        imageSize: image.size,
        segments: payload.segments,
      });
      if (composite.layers.length === 0) throw new Error('Magic Layer did not create any cutouts');
      useCanvasStore.getState().setMagicLayers(imageId, composite.layers, composite.baseUrl);
      useEditorStore.getState().setActiveTool('magic-layer');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Magic Layer failed';
      useCanvasStore.getState().setMagicLayerStatus(imageId, 'error', message);
    }
  }, [focusedImageIds]);

  return { activateMagicLayer, canActivateMagicLayer, isSegmenting };
}
