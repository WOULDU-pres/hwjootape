'use client';

/**
 * RegionOverlay — visualizes how a slide will be DECOMPOSED: the original slide image
 * with the detected regions drawn on top. OCR text regions (green), SAM3 object
 * segments that decompose will KEEP (blue, become editable image elements), and
 * segments it will DROP because they overlap text (gray dashed). Boxes are positioned
 * as percentages of the image's native pixel size. Presentational only.
 */

export interface RegionBBox { x: number; y: number; width: number; height: number }
export interface AnalyzedSlide {
  slideIndex: number;
  assetId: string;
  imageWidth: number;
  imageHeight: number;
  ocr: Array<{ text: string; bbox: RegionBBox }>;
  segments: Array<{ id: string; label: string; bbox: RegionBBox; kept: boolean }>;
}

const GREEN = '#0a8a2a';
const BLUE = '#1d4ed8';
const GRAY = '#9aa0a6';

function pct(b: RegionBBox, W: number, H: number) {
  return {
    left: `${(b.x / W) * 100}%`,
    top: `${(b.y / H) * 100}%`,
    width: `${(b.width / W) * 100}%`,
    height: `${(b.height / H) * 100}%`,
  } as const;
}

export default function RegionOverlay({ slide, imageUrl }: { slide: AnalyzedSlide; imageUrl: string }) {
  const W = slide.imageWidth || 1;
  const H = slide.imageHeight || 1;
  const kept = slide.segments.filter((s) => s.kept);
  const dropped = slide.segments.filter((s) => !s.kept);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <Legend color={GREEN} label={`텍스트 영역 (OCR) · ${slide.ocr.length}`} />
        <Legend color={BLUE} label={`객체로 분해 · ${kept.length}`} />
        <Legend color={GRAY} dashed label={`텍스트 겹쳐 제외 · ${dropped.length}`} />
      </div>
      <div
        className="relative w-full overflow-hidden rounded-[8px] bg-[#f3f3f3]"
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />

        {slide.segments.map((s) => (
          <div
            key={s.id}
            className="absolute"
            style={{
              ...pct(s.bbox, W, H),
              border: `2px ${s.kept ? 'solid' : 'dashed'} ${s.kept ? BLUE : GRAY}`,
              background: s.kept ? 'rgba(29,78,216,0.08)' : 'transparent',
            }}
          >
            <span
              className="absolute left-0 top-0 px-1 text-[10px] font-medium text-white"
              style={{ background: s.kept ? BLUE : GRAY, transform: 'translateY(-100%)' }}
            >
              {s.kept ? `객체: ${s.label}` : '제외'}
            </span>
          </div>
        ))}

        {slide.ocr.map((o, i) => (
          <div
            key={`ocr-${i}`}
            className="absolute"
            style={{ ...pct(o.bbox, W, H), border: `2px solid ${GREEN}`, background: 'rgba(10,138,42,0.08)' }}
          >
            <span
              className="absolute left-0 top-0 max-w-full truncate px-1 text-[10px] font-medium text-white"
              style={{ background: GREEN, transform: 'translateY(-100%)' }}
            >
              T: {o.text || '∅'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ color: '#444' }}>
      <span className="inline-block h-3 w-4" style={{ border: `2px ${dashed ? 'dashed' : 'solid'} ${color}`, background: dashed ? 'transparent' : `${color}22` }} />
      {label}
    </span>
  );
}
