import type { MagicLayer } from '@/types/canvas';

export interface MagicLayerSegment {
  id?: string;
  label?: string;
  maskDataUrl?: string;
  bbox: { x: number; y: number; width: number; height: number };
}

export interface BuildMagicLayersOptions {
  imageUrl: string;
  imageSize: { width: number; height: number };
  segments: MagicLayerSegment[];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for Magic Layer'));
    img.src = src;
  });
}

function clampBounds(bounds: MagicLayerSegment['bbox'], size: { width: number; height: number }) {
  const x = Math.max(0, Math.min(size.width, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(size.height, Math.round(bounds.y)));
  const right = Math.max(x + 1, Math.min(size.width, Math.round(bounds.x + bounds.width)));
  const bottom = Math.max(y + 1, Math.min(size.height, Math.round(bounds.y + bounds.height)));
  return { x, y, width: right - x, height: bottom - y };
}

function rectMask(bounds: { width: number; height: number }): string {
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, bounds.width, bounds.height);
  }
  return canvas.toDataURL('image/png');
}

async function cropCutout(base: HTMLImageElement, maskDataUrl: string, bounds: { x: number; y: number; width: number; height: number }, imageSize: { width: number; height: number }): Promise<string> {
  const mask = await loadImage(maskDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.drawImage(base, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  ctx.globalCompositeOperation = 'destination-in';
  if (mask.naturalWidth === imageSize.width && mask.naturalHeight === imageSize.height) {
    ctx.drawImage(mask, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  } else {
    ctx.drawImage(mask, 0, 0, bounds.width, bounds.height);
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvas.toDataURL('image/png');
}

function fillRemovedRegion(ctx: CanvasRenderingContext2D, bounds: { x: number; y: number; width: number; height: number }, imageSize: { width: number; height: number }) {
  const sampleX = Math.max(0, Math.min(imageSize.width - 1, bounds.x - 1));
  const sampleY = Math.max(0, Math.min(imageSize.height - 1, bounds.y + Math.floor(bounds.height / 2)));
  const pixel = ctx.getImageData(sampleX, sampleY, 1, 1).data;
  ctx.fillStyle = `rgb(${pixel[0]} ${pixel[1]} ${pixel[2]})`;
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
}

export async function buildMagicLayerComposite({ imageUrl, imageSize, segments }: BuildMagicLayersOptions): Promise<{ baseUrl: string; layers: MagicLayer[] }> {
  const base = await loadImage(imageUrl);
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = imageSize.width;
  baseCanvas.height = imageSize.height;
  const baseCtx = baseCanvas.getContext('2d');
  if (!baseCtx) throw new Error('Canvas is unavailable for Magic Layer');
  baseCtx.drawImage(base, 0, 0, imageSize.width, imageSize.height);

  const layers: MagicLayer[] = [];
  for (const [index, segment] of segments.entries()) {
    const bounds = clampBounds(segment.bbox, imageSize);
    const maskDataUrl = segment.maskDataUrl || rectMask(bounds);
    const cutoutDataUrl = await cropCutout(base, maskDataUrl, bounds, imageSize);
    if (!cutoutDataUrl) continue;
    fillRemovedRegion(baseCtx, bounds, imageSize);
    layers.push({
      id: segment.id || `magic-layer-${index + 1}`,
      name: segment.label || `Layer ${index + 1}`,
      maskDataUrl,
      cutoutDataUrl,
      sourceBounds: bounds,
      position: { x: bounds.x, y: bounds.y },
      hidden: false,
    });
  }

  return { baseUrl: baseCanvas.toDataURL('image/png'), layers };
}
