/**
 * embed — support for images the user drops into the outline that should be
 * placed onto the slide *as-is* (role: "embed"), as opposed to reference images
 * that merely guide god-tibo's draft (role: "reference").
 *
 * Two concerns live here:
 *  - `layoutEmbedImages`: a pure, deterministic placement that lays embed images
 *    out in a bottom band, each fit to its own aspect ratio. The build-pptx
 *    sidecar stretches a picture to its nbbox (no aspect preservation), so the
 *    nbbox we emit MUST already match the image's aspect or the .pptx distorts.
 *    Aspect comes from the browser (naturalWidth/Height), threaded in as dims.
 *  - `srcToDataUrl`: resolve a user-supplied image source (a base64 data URL, or
 *    an http(s) URL) to PNG/JPEG/etc. bytes as a data URL, so the route can
 *    persist it as a project asset and embed it in the export.
 */
import type { NBBox } from './spec';

export interface EmbedImageDims {
  width: number;
  height: number;
}

// Bottom band the embed row occupies, in normalized [0,1] slide coordinates.
const BAND = { x0: 0.05, x1: 0.95, y0: 0.58, y1: 0.96 } as const;
// Fraction of each per-image slot left as horizontal padding (split both sides).
const SLOT_PADDING = 0.12;
// Base z so embeds sit above the background and regenerated image elements.
const EMBED_Z_BASE = 100;

/**
 * Lay out N embed images in a centered bottom-band row, each fit (aspect
 * preserved) within its slot. Returns one nbbox per input, in input order.
 */
export function layoutEmbedImages(dims: EmbedImageDims[]): Array<NBBox & { z: number }> {
  const n = dims.length;
  if (n === 0) return [];
  const bandW = BAND.x1 - BAND.x0;
  const bandH = BAND.y1 - BAND.y0;
  const slotW = bandW / n;
  const innerW = slotW * (1 - SLOT_PADDING);

  return dims.map((d, i) => {
    const aspect = d.width > 0 && d.height > 0 ? d.width / d.height : 1;
    const slotAspect = innerW / bandH;
    let w: number;
    let h: number;
    if (aspect > slotAspect) {
      w = innerW;
      h = w / aspect;
    } else {
      h = bandH;
      w = h * aspect;
    }
    const slotX = BAND.x0 + i * slotW;
    const x = slotX + (slotW - w) / 2;
    const y = BAND.y0 + (bandH - h) / 2;
    return { x, y, w, h, z: EMBED_Z_BASE + i };
  });
}

export interface ResolvedSrc {
  dataUrl: string;
  mimeType: string;
}

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 15000;
const DATA_URL = /^data:([^;,]*)((?:;[^,]*)*),([\s\S]*)$/;

/**
 * Resolve an embed image source to a base64 data URL.
 * - base64 `data:` URLs pass through; non-base64 `data:` URLs (e.g. a pasted
 *   `data:image/svg+xml,<svg…>`) are re-encoded to base64 so the downstream
 *   persistence (which requires `;base64,`) doesn't throw.
 * - `http(s)` URLs are fetched server-side (avoids browser CORS), validated to
 *   be an image, size-capped, and encoded as a data URL.
 */
export async function srcToDataUrl(
  src: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ResolvedSrc> {
  if (src.startsWith('data:')) {
    const match = src.match(DATA_URL);
    if (!match) throw new Error('data URL 형식이 올바르지 않습니다.');
    const mimeType = match[1] || 'image/png';
    const params = match[2] || '';
    if (/;base64/i.test(params)) {
      return { dataUrl: src, mimeType };
    }
    // Non-base64 (percent-encoded text payload) → re-encode as base64.
    const buffer = Buffer.from(decodeURIComponent(match[3]), 'utf8');
    return { dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`, mimeType };
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error(`이미지 주소를 해석할 수 없습니다: ${src.slice(0, 80)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('이미지 URL은 http(s)만 지원합니다.');
  }

  const response = await fetchImpl(src, { signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`이미지 URL을 불러오지 못했습니다 (HTTP ${response.status}).`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    throw new Error(`URL이 이미지가 아닙니다 (content-type: ${contentType || 'unknown'}).`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error('이미지 URL의 응답이 비어 있습니다.');
  }
  if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`이미지가 너무 큽니다 (>${Math.round(MAX_REMOTE_IMAGE_BYTES / 1024 / 1024)}MB).`);
  }
  return { dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`, mimeType: contentType };
}
