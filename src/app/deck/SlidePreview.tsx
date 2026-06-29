'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { SlideSpec, SlideElement, NBBox } from '@/lib/slides/spec';

/**
 * SlidePreview — a faithful, EDITABLE 16:9 preview of one SlideSpec (ADR-0002).
 *
 * Renders the regenerated background plate (full-bleed image) + positioned elements.
 * In edit mode every element can be dragged (move), resized (corner handle), reordered
 * (z), deleted, or regenerated; text is edited by double-clicking. Geometry edits are
 * reported as normalized nbbox so they round-trip through the store and the exporter.
 *
 * Font px matches scripts/render-png.py (fontSizePt * width / 960) so the preview is
 * close to the exported PNG. Images carry an onError fallback so a failed asset shows
 * a visible message instead of a silent broken-image icon (the Phase 0 render bug).
 */

function hexColor(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}` : fallback;
}

const PT_TO_PX_OVER_WIDTH = 1 / 960;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface SlidePreviewProps {
  spec: SlideSpec;
  slideIndex: number;
  editable: boolean;
  onEditText: (elementIndex: number, text: string) => void;
  onUpdateBox: (elementIndex: number, nbbox: NBBox) => void;
  onForward: (elementIndex: number) => void;
  onBackward: (elementIndex: number) => void;
  onDelete: (elementIndex: number) => void;
  onRegenerate: (elementIndex: number) => void;
  assetUrlFor: (assetId: string) => string;
  bgColor?: string;
  fontLatin?: string;
  fontEA?: string;
}

type DragMode = 'move' | 'resize';
interface DragState {
  elementIndex: number;
  mode: DragMode;
  startX: number;
  startY: number;
  startBox: NBBox;
  containerW: number;
  containerH: number;
}

function BrokenImage() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center text-[11px]"
      style={{ background: '#fff1f0', color: '#c13515', border: '1px dashed #f0a' }}
    >
      이미지 로드 실패
    </div>
  );
}

export default function SlidePreview({
  spec,
  slideIndex,
  editable,
  onEditText,
  onUpdateBox,
  onForward,
  onBackward,
  onDelete,
  onRegenerate,
  assetUrlFor,
  bgColor,
  fontLatin,
  fontEA,
}: SlidePreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const fontFamily = [fontLatin, fontEA, 'system-ui', '-apple-system', 'sans-serif']
    .filter(Boolean)
    .map((f) => (f && /\s/.test(f) ? `"${f}"` : f))
    .join(', ');

  function beginDrag(e: React.PointerEvent, elementIndex: number, mode: DragMode, box: NBBox) {
    if (!editable) return;
    const node = containerRef.current;
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      elementIndex,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startBox: box,
      containerW: node.clientWidth,
      containerH: node.clientHeight,
    };
    setSelected(elementIndex);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || d.containerW === 0 || d.containerH === 0) return;
    const dx = (e.clientX - d.startX) / d.containerW;
    const dy = (e.clientY - d.startY) / d.containerH;
    const b = d.startBox;
    let next: NBBox;
    if (d.mode === 'move') {
      next = { x: clamp01(b.x + dx), y: clamp01(b.y + dy), w: b.w, h: b.h };
    } else {
      next = { x: b.x, y: b.y, w: Math.max(0.03, Math.min(1 - b.x, b.w + dx)), h: Math.max(0.03, Math.min(1 - b.y, b.h + dy)) };
    }
    onUpdateBox(d.elementIndex, next);
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-[8px] select-none"
      style={{ aspectRatio: '16 / 9', backgroundColor: hexColor(bgColor, '#ffffff') }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onPointerDown={() => { setSelected(null); setEditingText(null); }}
    >
      {/* Background plate (regenerated, full-bleed). Sentinel-low z so an element
          sent all the way to the back (negative z) still paints above the plate. */}
      {spec.background?.assetId && (
        <ImageWithFallback key={spec.background.assetId} src={assetUrlFor(spec.background.assetId)} className="absolute inset-0 h-full w-full object-cover" style={{ zIndex: -9999 }} />
      )}

      {spec.elements.map((el, elementIndex) => {
        const boxStyle = {
          left: `${el.nbbox.x * 100}%`,
          top: `${el.nbbox.y * 100}%`,
          width: `${el.nbbox.w * 100}%`,
          height: `${el.nbbox.h * 100}%`,
        } as const;
        const isSelected = selected === elementIndex;
        const z = (el.z ?? 0) + 1; // keep above bg (z0)

        return (
          <div
            key={el.id}
            className="absolute"
            style={{ ...boxStyle, zIndex: z, outline: isSelected ? '2px solid #ff385c' : 'none' }}
            onPointerDown={(e) => beginDrag(e, elementIndex, 'move', el.nbbox)}
            onDoubleClick={(e) => { if (el.type === 'text') { e.stopPropagation(); setEditingText(elementIndex); setSelected(elementIndex); } }}
          >
            <ElementBody
              el={el}
              width={width}
              fontFamily={fontFamily}
              editingText={editingText === elementIndex}
              assetUrlFor={assetUrlFor}
              onChange={(text) => onEditText(elementIndex, text)}
              onBlur={() => setEditingText(null)}
            />
            {editable && isSelected && (
              <>
                {/* resize handle (bottom-right) */}
                <div
                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm"
                  style={{ background: '#ff385c' }}
                  onPointerDown={(e) => beginDrag(e, elementIndex, 'resize', el.nbbox)}
                />
                {/* element toolbar */}
                <div
                  className="absolute -top-7 left-0 flex gap-1"
                  style={{ zIndex: 9999 }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <ToolBtn title="앞으로" onClick={() => onForward(elementIndex)}>⤒</ToolBtn>
                  <ToolBtn title="뒤로" onClick={() => onBackward(elementIndex)}>⤓</ToolBtn>
                  {el.type === 'image' && <ToolBtn title="재생성" onClick={() => onRegenerate(elementIndex)}>↻</ToolBtn>}
                  <ToolBtn title="삭제" danger onClick={() => onDelete(elementIndex)}>×</ToolBtn>
                </div>
              </>
            )}
          </div>
        );
      })}

      {spec.elements.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: '#929292' }}>
          빈 슬라이드 #{slideIndex + 1}
        </div>
      )}
    </div>
  );
}

function ElementBody({
  el,
  width,
  fontFamily,
  editingText,
  assetUrlFor,
  onChange,
  onBlur,
}: {
  el: SlideElement;
  width: number;
  fontFamily: string;
  editingText: boolean;
  assetUrlFor: (assetId: string) => string;
  onChange: (text: string) => void;
  onBlur: () => void;
}) {
  if (el.type === 'image') {
    if (!el.assetId) return null;
    return <ImageWithFallback key={el.assetId} src={assetUrlFor(el.assetId)} className="h-full w-full object-contain" />;
  }

  const fontPx = width > 0 ? (el.fontSizePt ?? 24) * width * PT_TO_PX_OVER_WIDTH : 0;
  const common = {
    color: hexColor(el.color, '#141414'),
    fontWeight: el.bold ? 700 : 400,
    fontSize: fontPx ? `${fontPx}px` : undefined,
    lineHeight: 1.25,
    textAlign: el.align ?? 'left',
    fontFamily,
  } as const;

  if (editingText) {
    return (
      <textarea
        autoFocus
        className="h-full w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-white/70 p-0 outline-none"
        style={common}
        value={el.text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onPointerDown={(e) => e.stopPropagation()}
        spellCheck={false}
      />
    );
  }
  return (
    <div className="h-full w-full overflow-hidden whitespace-pre-wrap break-words" style={common}>
      {el.text}
    </div>
  );
}

// NOTE: callers pass `key={src}` so a changed src remounts this and clears `failed`
// (a stale load-failure must not stick after a regenerate). See call sites.
export function ImageWithFallback({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <BrokenImage />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} style={style} draggable={false} onError={() => setFailed(true)} />;
}

function ToolBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded bg-white text-[13px] shadow"
      style={{ border: '1px solid #ddd', color: danger ? '#c13515' : '#222' }}
    >
      {children}
    </button>
  );
}
