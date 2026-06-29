'use client';

import { useEffect, useState } from 'react';
import { useSlideStore } from '@/stores/useSlideStore';
import SlidePreview, { ImageWithFallback } from './SlidePreview';
import RegionOverlay, { type AnalyzedSlide } from './RegionOverlay';
import type { SlideSpec } from '@/lib/slides/spec';

/**
 * Deck Builder — bake-decompose pipeline (ADR-0002), Airbnb-inspired surface.
 *
 *   setup    → POST /api/slides/versions  (per-preset fan-out → progressive grid)
 *   versions → pick one of N style versions (previewed by sample slides)
 *   building → POST /api/slides/full-deck  then  POST /api/slides/decompose-deck
 *   editing  → drag/resize/z/delete + text edit + per-element/slide regenerate
 *   export   → POST /api/slides/export  (editable .pptx + per-slide PNG)
 */

const RAUSCH = '#ff385c';
const RAUSCH_ACTIVE = '#e00b41';
const INK = '#222222';
const MUTED = '#6a6a6a';
const HAIRLINE = '#dddddd';
const CARD_SHADOW = 'rgba(0,0,0,0.02) 0 0 0 1px, rgba(0,0,0,0.04) 0 2px 6px 0, rgba(0,0,0,0.1) 0 4px 8px 0';

type Stage = 'setup' | 'versions' | 'building' | 'editing';
interface PresetInfo { id: string; name: string }
interface VersionSampleView { slideIndex: number; assetId: string | null; error?: string }
interface VersionView {
  presetId: string;
  presetName: string;
  status: 'loading' | 'done' | 'error';
  samples: VersionSampleView[];
  error?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export default function DeckBuilderPage() {
  const s = useSlideStore();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('setup');
  const [styleHint, setStyleHint] = useState('');
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [versions, setVersions] = useState<VersionView[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  // slideIndex -> the original (pre-decompose) slide image, so we can show how it was cut.
  const [sourceAssets, setSourceAssets] = useState<Record<number, string>>({});
  const [analyze, setAnalyze] = useState<{ open: boolean; loading: boolean; title: string; slides: AnalyzedSlide[]; error: string | null }>(
    { open: false, loading: false, title: '', slides: [], error: null },
  );

  useEffect(() => {
    setProjectId(new URLSearchParams(window.location.search).get('project'));
  }, []);
  useEffect(() => {
    fetch('/api/slides/style-presets')
      .then((r) => r.json())
      .then((d) => {
        // Registry may hold more than the default (extensible by data); the picker
        // shows exactly defaultCount versions (locked at 8) so cost stays 8×3=24.
        if (Array.isArray(d.presets)) setPresets(d.presets.slice(0, d.defaultCount ?? 8));
      })
      .catch(() => {});
  }, []);

  const api = (path: string) => (projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path);
  const assetUrlFor = (assetId: string) => api(`/api/projects/assets/${assetId}`);

  // ---- setup → versions: fan out one request per preset for a progressive grid ----
  async function generateVersions() {
    if (!s.outlineText.trim() || presets.length === 0) return;
    setBusy(true);
    s.setError(null);
    setStage('versions');
    setSelectedPreset(null);
    setVersions(presets.map((p) => ({ presetId: p.id, presetName: p.name, status: 'loading', samples: [] })));

    await Promise.all(
      presets.map(async (p) => {
        try {
          const data = await postJson<{ versions: Array<{ presetId: string; presetName: string; samples: VersionSampleView[] }> }>(
            api('/api/slides/versions'),
            { outlineText: s.outlineText, styleHint, presetIds: [p.id] },
          );
          const v = data.versions[0];
          setVersions((prev) => prev.map((x) => (x.presetId === p.id ? { ...x, status: 'done', samples: v?.samples ?? [] } : x)));
        } catch (e) {
          setVersions((prev) => prev.map((x) => (x.presetId === p.id ? { ...x, status: 'error', error: e instanceof Error ? e.message : '실패' } : x)));
        }
      }),
    );
    setBusy(false);
  }

  // ---- decomposition preview: show how a slide's regions are detected (no god-tibo) ----
  async function openAnalyze(title: string, slides: Array<{ slideIndex: number; assetId: string }>) {
    if (slides.length === 0) return;
    setAnalyze({ open: true, loading: true, title, slides: [], error: null });
    try {
      const data = await postJson<{ results: AnalyzedSlide[] }>(api('/api/slides/analyze'), { slides });
      setAnalyze({ open: true, loading: false, title, slides: data.results, error: null });
    } catch (e) {
      setAnalyze({ open: true, loading: false, title, slides: [], error: e instanceof Error ? e.message : '분석 실패' });
    }
  }

  // ---- versions → editing: generate full deck in chosen style, then decompose ----
  async function buildFromVersion() {
    const chosen = versions.find((v) => v.presetId === selectedPreset);
    if (!chosen) return;
    setBusy(true);
    s.setError(null);
    setStage('building');
    try {
      const samples: Record<number, string> = {};
      chosen.samples.forEach((sm) => { if (sm.assetId) samples[sm.slideIndex] = sm.assetId; });

      setProgress('전체 덱 생성 중… (선택한 스타일로)');
      const deckRes = await postJson<{ slides: Array<{ slideIndex: number; assetId: string | null }>; failed?: number }>(
        api('/api/slides/full-deck'),
        { outlineText: s.outlineText, presetId: chosen.presetId, styleHint, samples },
      );
      const slides = deckRes.slides.filter((sl) => sl.assetId).map((sl) => ({ slideIndex: sl.slideIndex, assetId: sl.assetId as string }));
      setSourceAssets(Object.fromEntries(slides.map((sl) => [sl.slideIndex, sl.assetId])));
      const dropped = deckRes.slides.length - slides.length;
      if (dropped > 0) {
        // Non-fatal: continue with the slides that succeeded, but tell the user.
        s.setError(`${dropped}개 슬라이드 이미지 생성에 실패해 제외했습니다. 나머지로 계속합니다.`);
      }
      if (slides.length === 0) throw new Error('생성된 슬라이드가 없습니다.');

      setProgress('분해 중… (텍스트/배경/객체 분리)');
      const decRes = await postJson<{ deck: SlideSpec[] }>(
        api('/api/slides/decompose-deck'),
        { outlineText: s.outlineText, styleHint, slides },
      );
      s.setDeck(decRes.deck);
      setStage('editing');
    } catch (e) {
      s.setError(e instanceof Error ? e.message : '덱 생성/분해 실패');
      setStage('versions');
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  // ---- editing: regenerate one element / one whole slide with a requirement ----
  async function regenerateElement(slideIndex: number, elementIndex: number) {
    const el = s.deck[slideIndex]?.elements[elementIndex];
    if (!el || el.type !== 'image') return;
    const requirement = window.prompt('이 요소를 어떻게 바꿀까요? (요구사항)');
    if (!requirement) return;
    setBusy(true);
    try {
      const data = await postJson<{ assetId: string }>(api('/api/slides/regen-element'), { requirement, currentAssetId: el.assetId });
      s.updateElementAsset(slideIndex, elementIndex, data.assetId);
    } catch (e) {
      s.setError(e instanceof Error ? e.message : '요소 재생성 실패');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateBackground(slideIndex: number) {
    const requirement = window.prompt('배경을 어떻게 바꿀까요? (요구사항)');
    if (!requirement) return;
    setBusy(true);
    try {
      const currentAssetId = s.deck[slideIndex]?.background?.assetId;
      const data = await postJson<{ assetId: string }>(api('/api/slides/regen-element'), { requirement, currentAssetId });
      s.setBackgroundAsset(slideIndex, data.assetId);
    } catch (e) {
      s.setError(e instanceof Error ? e.message : '배경 재생성 실패');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateSlide(slideIndex: number) {
    const requirement = window.prompt('이 슬라이드를 어떻게 바꿀까요? (요구사항)');
    if (!requirement) return;
    setBusy(true);
    try {
      // Re-bake in-family: pass the chosen version's sample slides as references so
      // the regenerated slide keeps the deck's look (mirrors the full-deck build).
      const chosen = versions.find((v) => v.presetId === selectedPreset);
      const referenceAssetIds = (chosen?.samples ?? []).map((sm) => sm.assetId).filter((x): x is string => !!x);
      const data = await postJson<{ slide: SlideSpec }>(api('/api/slides/regen-slide'), {
        outlineText: s.outlineText,
        presetId: selectedPreset,
        styleHint,
        slideIndex,
        requirement,
        referenceAssetIds,
      });
      s.setSlide(slideIndex, data.slide);
    } catch (e) {
      s.setError(e instanceof Error ? e.message : '슬라이드 재생성 실패');
    } finally {
      setBusy(false);
    }
  }

  async function exportDeck() {
    if (s.deck.length === 0) return;
    setBusy(true);
    s.setError(null);
    s.setStatus('exporting');
    try {
      const exported = await postJson<{ pptxPath: string; pngPaths: string[] }>(
        api('/api/slides/export'),
        { deck: s.deck, baseName: 'deck' },
      );
      s.setExportResult({ pptxPath: exported.pptxPath, pngPaths: exported.pngPaths });
    } catch (e) {
      s.setError(e instanceof Error ? e.message : 'Export 실패');
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    if (!s.exportResult) return;
    try {
      await postJson(api('/api/projects/open-folder'), { path: s.exportResult.pptxPath });
    } catch (e) {
      s.setError(e instanceof Error ? e.message : '폴더를 열지 못했습니다.');
    }
  }

  function restart() {
    s.reset();
    setVersions([]);
    setSelectedPreset(null);
    setSourceAssets({});
    setStage('setup');
  }

  return (
    <div className="flex h-screen w-screen bg-white" style={{ color: INK, fontFamily: 'Inter, "Helvetica Neue", system-ui, -apple-system, sans-serif' }}>
      {/* Left rail */}
      <aside className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto p-7" style={{ borderRight: `1px solid ${HAIRLINE}` }}>
        <div>
          <a href="/decks" className="text-[13px]" style={{ color: MUTED }}>← 덱 목록</a>
          <h1 className="mt-1 text-[22px] font-semibold" style={{ letterSpacing: '-0.44px' }}>
            <span style={{ color: RAUSCH }}>Deck</span> Builder
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: MUTED }}>{projectId ? `덱: ${projectId}` : '대시보드에서 덱을 여세요.'}</p>
        </div>

        <Field label="아웃라인 (마크다운)">
          <textarea
            className="h-48 w-full resize-none rounded-lg p-3 font-mono text-[13px] leading-relaxed outline-none"
            style={{ border: `1px solid ${HAIRLINE}` }}
            value={s.outlineText}
            onChange={(e) => s.setOutlineText(e.target.value)}
            disabled={busy || stage !== 'setup'}
          />
          <p className="text-[12px]" style={{ color: MUTED }}><code>---</code> 한 줄로 슬라이드를 구분합니다.</p>
        </Field>

        <Field label="스타일 힌트 (선택)">
          <input
            className="h-11 w-full rounded-lg px-3 text-[14px] outline-none"
            style={{ border: `1px solid ${HAIRLINE}` }}
            value={styleHint}
            onChange={(e) => setStyleHint(e.target.value)}
            placeholder="예: 차분한 파란 톤, 회사 발표"
            disabled={busy || stage !== 'setup'}
          />
        </Field>

        <div className="mt-1 flex flex-col gap-2.5">
          {stage === 'setup' && (
            <PrimaryButton onClick={generateVersions} disabled={busy || !s.outlineText.trim() || presets.length === 0}>
              디자인 버전 생성 ({presets.length || 8}개)
            </PrimaryButton>
          )}
          {stage === 'versions' && (
            <PrimaryButton onClick={buildFromVersion} disabled={busy || !selectedPreset}>
              {selectedPreset ? '이 디자인으로 덱 만들기' : '버전을 선택하세요'}
            </PrimaryButton>
          )}
          {stage === 'editing' && (
            <PrimaryButton onClick={exportDeck} disabled={busy || s.deck.length === 0}>
              {s.status === 'exporting' ? 'Export 중…' : '편집가능 PPTX + PNG로 Export'}
            </PrimaryButton>
          )}
          <button onClick={restart} disabled={busy} className="h-11 rounded-lg bg-white px-6 text-[15px] font-medium disabled:opacity-40" style={{ border: `1px solid ${INK}`, color: INK }}>
            처음부터
          </button>
        </div>

        {s.error && <div className="rounded-lg p-3 text-[14px]" style={{ backgroundColor: '#fff8f6', color: '#c13515' }}>{s.error}</div>}

        {s.exportResult && (
          <div className="rounded-[14px] p-4 text-[13px]" style={{ boxShadow: CARD_SHADOW }}>
            <div className="mb-1 font-semibold" style={{ color: '#008a05' }}>완료 — {s.exportResult.pngPaths.length}개 슬라이드.</div>
            <div className="break-all" style={{ color: MUTED }}>.pptx: {s.exportResult.pptxPath}</div>
            <button onClick={openFolder} className="mt-3 h-10 w-full rounded-lg text-[14px] font-medium" style={{ border: `1px solid ${INK}`, color: INK }}>결과 폴더 열기</button>
          </div>
        )}

        {stage === 'editing' && !s.exportResult && (
          <p className="text-[13px]" style={{ color: MUTED }}>요소를 드래그·리사이즈하고, 텍스트는 더블클릭해 편집하세요.</p>
        )}
      </aside>

      {/* Right canvas */}
      <main className="flex-1 overflow-auto bg-[#fafafa] p-8">
        {stage === 'setup' && (
          <div className="flex h-full items-center justify-center text-[16px]" style={{ color: '#929292' }}>
            아웃라인을 입력하고 “디자인 버전 생성”을 누르세요.
          </div>
        )}

        {stage === 'versions' && (
          <VersionGrid
            versions={versions}
            selected={selectedPreset}
            onSelect={setSelectedPreset}
            assetUrlFor={assetUrlFor}
            onAnalyze={(v) =>
              openAnalyze(
                `${v.presetName} 분해 미리보기`,
                v.samples.filter((sm) => sm.assetId).map((sm) => ({ slideIndex: sm.slideIndex, assetId: sm.assetId as string })),
              )
            }
          />
        )}

        {stage === 'building' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[15px]" style={{ color: MUTED }}>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#ff385c] border-t-transparent" />
            {progress || '생성 중…'}
          </div>
        )}

        {stage === 'editing' && (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {s.deck.map((spec, index) => (
              <div key={spec.slideId ?? index} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium" style={{ color: MUTED }}>슬라이드 {index + 1}</span>
                  <div className="flex gap-1.5">
                    {sourceAssets[index] && (
                      <SlideBtn onClick={() => openAnalyze(`슬라이드 ${index + 1} 분해 영역`, [{ slideIndex: index, assetId: sourceAssets[index] }])} disabled={busy} title="원본을 어떻게 분해했는지 보기">🔍 분해 영역</SlideBtn>
                    )}
                    <SlideBtn onClick={() => regenerateSlide(index)} disabled={busy} title="슬라이드 재생성(요구사항)">↻ 슬라이드 재생성</SlideBtn>
                    {spec.background?.assetId && (
                      <SlideBtn onClick={() => regenerateBackground(index)} disabled={busy} title="배경만 재생성(요구사항)">↻ 배경</SlideBtn>
                    )}
                    <SlideBtn onClick={() => s.reorderSlide(index, index - 1)} disabled={busy || index === 0} title="위로">↑</SlideBtn>
                    <SlideBtn onClick={() => s.reorderSlide(index, index + 1)} disabled={busy || index === s.deck.length - 1} title="아래로">↓</SlideBtn>
                    <SlideBtn onClick={() => s.deleteSlide(index)} disabled={busy} title="삭제" danger>×</SlideBtn>
                  </div>
                </div>
                <div className="rounded-[10px] bg-white p-2" style={{ boxShadow: CARD_SHADOW }}>
                  <SlidePreview
                    spec={spec}
                    slideIndex={index}
                    editable={!busy}
                    onEditText={(ei, text) => s.updateElementText(index, ei, text)}
                    onUpdateBox={(ei, nbbox) => s.updateElementBox(index, ei, nbbox)}
                    onForward={(ei) => s.bringElementForward(index, ei)}
                    onBackward={(ei) => s.sendElementBackward(index, ei)}
                    onDelete={(ei) => s.deleteElement(index, ei)}
                    onRegenerate={(ei) => regenerateElement(index, ei)}
                    assetUrlFor={assetUrlFor}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Decomposition-region preview modal */}
      {analyze.open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-6" onClick={() => setAnalyze((a) => ({ ...a, open: false }))}>
          <div className="mx-auto flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-[14px] bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b p-4" style={{ borderColor: HAIRLINE }}>
              <span className="text-[15px] font-semibold">{analyze.title}</span>
              <button onClick={() => setAnalyze((a) => ({ ...a, open: false }))} className="text-[14px]" style={{ color: MUTED }}>닫기 ✕</button>
            </div>
            <div className="flex flex-col gap-5 overflow-auto p-4">
              {analyze.loading && <div className="py-10 text-center text-[14px]" style={{ color: MUTED }}>분석 중… (OCR + SAM3, 수십 초)</div>}
              {analyze.error && <div className="rounded p-3 text-[14px]" style={{ background: '#fff8f6', color: '#c13515' }}>{analyze.error}</div>}
              {!analyze.loading &&
                analyze.slides.map((sl) => (
                  <div key={`${sl.slideIndex}-${sl.assetId}`}>
                    <div className="mb-1 text-[12px]" style={{ color: MUTED }}>슬라이드 {sl.slideIndex + 1}</div>
                    <RegionOverlay slide={sl} imageUrl={assetUrlFor(sl.assetId)} />
                  </div>
                ))}
              {!analyze.loading && !analyze.error && analyze.slides.length === 0 && (
                <div className="py-10 text-center text-[14px]" style={{ color: MUTED }}>표시할 영역이 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VersionGrid({
  versions,
  selected,
  onSelect,
  assetUrlFor,
  onAnalyze,
}: {
  versions: VersionView[];
  selected: string | null;
  onSelect: (id: string) => void;
  assetUrlFor: (id: string) => string;
  onAnalyze: (v: VersionView) => void;
}) {
  // Count produced SAMPLE images (the locked progress granularity, ~N/24), not versions.
  const totalSamples = versions.reduce((n, v) => n + (v.status === 'loading' ? 3 : v.samples.length), 0);
  const madeSamples = versions.reduce((n, v) => n + v.samples.filter((s) => s.assetId).length, 0);
  return (
    <div>
      <p className="mb-4 text-[14px]" style={{ color: MUTED }}>
        스타일을 골라주세요 — {madeSamples}/{totalSamples} 장 생성됨. (한글 텍스트는 미리보기에서 깨질 수 있어요; 디자인만 보고 고르세요.)
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {versions.map((v) => (
          <button
            key={v.presetId}
            onClick={() => v.status === 'done' && onSelect(v.presetId)}
            className="rounded-[12px] p-3 text-left transition-transform hover:-translate-y-0.5"
            style={{ boxShadow: CARD_SHADOW, outline: selected === v.presetId ? `3px solid ${RAUSCH}` : 'none' }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[14px] font-semibold">{v.presetName}</span>
              {v.status === 'loading' && <span className="text-[12px]" style={{ color: MUTED }}>생성 중…</span>}
              {v.status === 'error' && <span className="text-[12px]" style={{ color: '#c13515' }}>실패</span>}
              {v.status === 'done' && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onAnalyze(v); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onAnalyze(v); } }}
                  className="cursor-pointer text-[12px]"
                  style={{ color: RAUSCH }}
                >
                  🔍 분해 미리보기
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {v.status === 'loading' && Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="aspect-video animate-pulse rounded bg-[#eee]" />
              ))}
              {v.status === 'done' && v.samples.map((sm, i) => (
                <div key={i} className="relative aspect-video overflow-hidden rounded bg-[#f3f3f3]">
                  {sm.assetId ? (
                    <ImageWithFallback key={sm.assetId} src={assetUrlFor(sm.assetId)} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[10px]" style={{ color: '#c13515' }}>실패</div>
                  )}
                </div>
              ))}
              {v.status === 'error' && <div className="col-span-3 p-3 text-[12px]" style={{ color: '#c13515' }}>{v.error}</div>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[14px] font-medium" style={{ color: MUTED }}>{label}</label>
      {children}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  const [down, setDown] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onPointerLeave={() => setDown(false)}
      className="h-12 rounded-lg px-6 text-[16px] font-medium text-white transition-colors disabled:cursor-not-allowed"
      style={{ backgroundColor: disabled ? '#ffd1da' : down ? RAUSCH_ACTIVE : RAUSCH }}
    >
      {children}
    </button>
  );
}

function SlideBtn({ children, onClick, disabled, title, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} className="flex h-8 min-w-8 items-center justify-center rounded-md bg-white px-2 text-[13px] font-medium transition-colors disabled:opacity-30" style={{ border: `1px solid ${HAIRLINE}`, color: danger ? '#c13515' : INK }}>
      {children}
    </button>
  );
}
