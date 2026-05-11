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
  setupRequired?: boolean;
  setupStatus?: string;
  message?: string;
  setupHint?: { errorCode?: string; message?: string };
}

interface MagicLayerStatusResponse {
  installed: boolean;
  installing: boolean;
  failed: boolean;
  autoInstallSupported: boolean;
  message?: string;
  canFallback?: boolean;
}

const SETUP_POLL_INTERVAL_MS = 4000;
const SETUP_POLL_MAX_ATTEMPTS = 600;

async function waitForSetup(imageId: string): Promise<'ready' | 'failed' | 'unsupported'> {
  const store = useCanvasStore.getState();
  for (let attempt = 0; attempt < SETUP_POLL_MAX_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, SETUP_POLL_INTERVAL_MS));
    let payload: MagicLayerStatusResponse;
    try {
      const res = await fetch('/api/magic-layer/status', { cache: 'no-store' });
      payload = await res.json() as MagicLayerStatusResponse;
    } catch {
      continue;
    }
    if (!payload.autoInstallSupported) return 'unsupported';
    if (payload.failed) return 'failed';
    if (payload.installed) return 'ready';
    if (payload.message) {
      store.setMagicLayerStatus(imageId, 'preparing', payload.message);
    }
  }
  return 'failed';
}

export function useMagicLayers() {
  const focusedImageIds = useCanvasStore((s) => s.focusedImageIds);
  const focusedImage = useCanvasStore((s) => s.focusedImageIds.length === 1 ? s.images[s.focusedImageIds[0]] : undefined);

  const canActivateMagicLayer = Boolean(focusedImage && focusedImage.status === 'ready' && focusedImage.size.width > 0 && focusedImage.size.height > 0);
  const isPreparing = focusedImage?.magicLayerStatus === 'preparing';
  const isSegmenting = focusedImage?.magicLayerStatus === 'segmenting';
  const isBusy = isPreparing || isSegmenting;

  const activateMagicLayer = useCallback(async () => {
    const imageId = focusedImageIds.length === 1 ? focusedImageIds[0] : null;
    if (!imageId) return;
    const image = useCanvasStore.getState().images[imageId];
    if (!image || image.status !== 'ready') return;

    const store = useCanvasStore.getState();
    store.setMagicLayerStatus(imageId, 'segmenting');
    try {
      let file = await imageUrlToFile(image.url);
      let formData = new FormData();
      formData.set('image', file);
      formData.set('width', String(image.size.width));
      formData.set('height', String(image.size.height));

      let response = await fetch('/api/magic-layer', { method: 'POST', body: formData });

      if (response.status === 202) {
        const setupPayload = await response.json() as MagicLayerApiResponse;
        store.setMagicLayerStatus(imageId, 'preparing', setupPayload.message ?? 'Preparing AI model for first-time use…');
        const outcome = await waitForSetup(imageId);
        if (outcome === 'failed') throw new Error('Magic Layer setup failed. See server logs for details.');
        if (outcome === 'unsupported') throw new Error('Auto-install not supported on this platform.');
        store.setMagicLayerStatus(imageId, 'segmenting');
        file = await imageUrlToFile(image.url);
        formData = new FormData();
        formData.set('image', file);
        formData.set('width', String(image.size.width));
        formData.set('height', String(image.size.height));
        response = await fetch('/api/magic-layer', { method: 'POST', body: formData });
      }

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

  return { activateMagicLayer, canActivateMagicLayer, isSegmenting, isPreparing, isBusy };
}
