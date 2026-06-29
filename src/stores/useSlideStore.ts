import { create } from 'zustand';
import type { NBBox, SlideSpec, TextElement } from '@/lib/slides/spec';
import type { DeckLayout, SlideLayout } from '@/lib/slides/layout-types';

/**
 * Deck-level store for the two-phase, multi-slide builder.
 *
 * Phase 1 (design): the design route returns ALL slides as `deck: SlideSpec[]`
 * plus the authoritative `layout: DeckLayout` (one SlideLayout per slide). The
 * deck is what we render/edit; the layout is the content source we keep so we
 * can re-roll a slide, recompose a new theme instantly, or generate imagery.
 *
 * INVARIANT: `deck[i]` and `layout.slides[i]` describe the SAME slide. Every
 * structural mutation (reorder/add/delete) MUST keep both arrays index-aligned —
 * imagery/recompose routes reject a length mismatch.
 */

export type SlideBuilderStatus =
  | 'idle'
  | 'designing'
  | 'reviewing'
  | 'generating'
  | 'exporting'
  | 'done'
  | 'error';

export interface ExportResult {
  pptxPath: string;
  pngPaths: string[];
}

interface SlideBuilderState {
  outlineText: string;
  themeId: string;
  status: SlideBuilderStatus;
  error: string | null;
  deck: SlideSpec[];
  layout: DeckLayout | null;
  exportResult: ExportResult | null;
}

interface SlideBuilderActions {
  setOutlineText: (text: string) => void;
  setThemeId: (themeId: string) => void;
  setStatus: (status: SlideBuilderStatus) => void;
  setError: (error: string | null) => void;
  /** Phase-1 result: the full composed deck + its layout + the resolved theme. */
  setDesign: (design: { deck: SlideSpec[]; layout: DeckLayout; themeId: string }) => void;
  /** Replace just the specs (e.g. instant theme recompose, or imagery fill). */
  setDeck: (specs: SlideSpec[]) => void;
  /** Edit one text element's text immutably; no-op for image elements / out of range. */
  updateElementText: (slideIndex: number, elementIndex: number, text: string) => void;
  /** Move/resize an element by setting its normalized bbox; no-op out of range. */
  updateElementBox: (slideIndex: number, elementIndex: number, nbbox: NBBox) => void;
  /** Raise an element above all siblings (z-order); no-op out of range. */
  bringElementForward: (slideIndex: number, elementIndex: number) => void;
  /** Drop an element below all siblings (z-order); no-op out of range. */
  sendElementBackward: (slideIndex: number, elementIndex: number) => void;
  /** Delete an element from a slide; no-op out of range. */
  deleteElement: (slideIndex: number, elementIndex: number) => void;
  /** Swap an image element's assetId (after element regenerate); no-op for text/out of range. */
  updateElementAsset: (slideIndex: number, elementIndex: number, assetId: string) => void;
  /** Replace a single slide spec (after whole-slide regenerate); no-op out of range. */
  setSlide: (slideIndex: number, spec: SlideSpec) => void;
  /** Swap a slide's background plate assetId (after background regenerate); no-op out of range. */
  setBackgroundAsset: (slideIndex: number, assetId: string) => void;
  /** Move a slide; keeps deck[] and layout.slides[] index-aligned. */
  reorderSlide: (from: number, to: number) => void;
  /** Insert a blank slide after `afterIndex` (-1 inserts at the front). */
  addSlide: (afterIndex: number) => void;
  /** Remove a slide; keeps deck[] and layout.slides[] index-aligned. */
  deleteSlide: (index: number) => void;
  setExportResult: (result: ExportResult) => void;
  reset: () => void;
}

const DEFAULT_OUTLINE = [
  '# 발표 제목',
  '부제 또는 한 줄 설명',
  '',
  '---',
  '',
  '## 핵심 메시지',
  '- 첫 번째 요점',
  '- 두 번째 요점',
  '- 세 번째 요점',
  '',
  '---',
  '',
  '## 감사합니다',
].join('\n');

const initialState: SlideBuilderState = {
  outlineText: DEFAULT_OUTLINE,
  themeId: 'academy-blue',
  status: 'idle',
  error: null,
  deck: [],
  layout: null,
  exportResult: null,
};

// Monotonic counter so inserted slides get ids that never collide with existing
// ones. (The old code derived ids from the insertion POSITION, which reused ids of
// slides already in the deck.) Module-scoped: unique within a session.
let blankUid = 0;

/** Build a fresh, valid blank layout slide + matching spec with collision-free ids. */
function blankSlide(): { layout: SlideLayout; spec: SlideSpec } {
  const title = '새 슬라이드';
  const uid = ++blankUid;
  return {
    layout: { archetype: 'bullets', title, bullets: ['요점'], imageZone: null },
    spec: {
      slideId: `new-${uid}`,
      outline: { title, bullets: ['요점'] },
      background: null,
      elements: [
        {
          id: `new-${uid}-t`,
          type: 'text',
          role: 'title',
          text: title,
          nbbox: { x: 0.07, y: 0.1, w: 0.86, h: 0.16 },
          color: '1a3a8f',
          fontSizePt: 36,
          align: 'left',
          bold: true,
          z: 10,
        },
        {
          id: `new-${uid}-b`,
          type: 'text',
          role: 'bullet',
          text: '• 요점',
          nbbox: { x: 0.07, y: 0.3, w: 0.86, h: 0.6 },
          color: '1c1f26',
          fontSizePt: 22,
          align: 'left',
          z: 11,
        },
      ],
    },
  };
}

/** Move element `from`→`to` in a copy of `arr` (both indices assumed valid). */
function moved<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export const useSlideStore = create<SlideBuilderState & SlideBuilderActions>((set) => ({
  ...initialState,

  setOutlineText: (outlineText) => set({ outlineText }),
  setThemeId: (themeId) => set({ themeId }),
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, ...(error ? { status: 'error' as const } : {}) }),

  setDesign: ({ deck, layout, themeId }) =>
    set({ deck, layout, themeId, status: 'reviewing', error: null }),

  setDeck: (deck) => set({ deck }),

  updateElementText: (slideIndex, elementIndex, text) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      if (!spec) return {};
      const el = spec.elements[elementIndex];
      if (!el || el.type !== 'text') return {};
      const elements = spec.elements.map((e, i) =>
        i === elementIndex ? ({ ...e, text } as TextElement) : e,
      );
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  updateElementBox: (slideIndex, elementIndex, nbbox) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      if (!spec || !spec.elements[elementIndex]) return {};
      const elements = spec.elements.map((e, i) => (i === elementIndex ? { ...e, nbbox } : e));
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  bringElementForward: (slideIndex, elementIndex) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      if (!spec || !spec.elements[elementIndex]) return {};
      const top = Math.max(0, ...spec.elements.map((e) => e.z ?? 0));
      const elements = spec.elements.map((e, i) => (i === elementIndex ? { ...e, z: top + 1 } : e));
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  sendElementBackward: (slideIndex, elementIndex) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      if (!spec || !spec.elements[elementIndex]) return {};
      const bottom = Math.min(0, ...spec.elements.map((e) => e.z ?? 0));
      const elements = spec.elements.map((e, i) => (i === elementIndex ? { ...e, z: bottom - 1 } : e));
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  deleteElement: (slideIndex, elementIndex) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      if (!spec || !spec.elements[elementIndex]) return {};
      const elements = spec.elements.filter((_, i) => i !== elementIndex);
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  updateElementAsset: (slideIndex, elementIndex, assetId) =>
    set((state) => {
      const spec = state.deck[slideIndex];
      const el = spec?.elements[elementIndex];
      if (!el || el.type !== 'image') return {};
      const elements = spec.elements.map((e, i) => (i === elementIndex ? { ...e, assetId } : e));
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, elements } : s));
      return { deck };
    }),

  setSlide: (slideIndex, spec) =>
    set((state) => {
      if (slideIndex < 0 || slideIndex >= state.deck.length) return {};
      const deck = state.deck.map((s, i) => (i === slideIndex ? spec : s));
      return { deck };
    }),

  setBackgroundAsset: (slideIndex, assetId) =>
    set((state) => {
      if (slideIndex < 0 || slideIndex >= state.deck.length) return {};
      const deck = state.deck.map((s, i) => (i === slideIndex ? { ...s, background: { assetId } } : s));
      return { deck };
    }),

  reorderSlide: (from, to) =>
    set((state) => {
      const n = state.deck.length;
      if (from < 0 || from >= n || to < 0 || to >= n || from === to) return {};
      const deck = moved(state.deck, from, to);
      const layout = state.layout
        ? { ...state.layout, slides: moved(state.layout.slides, from, to) }
        : state.layout;
      return { deck, layout };
    }),

  addSlide: (afterIndex) =>
    set((state) => {
      const at = Math.max(0, Math.min(state.deck.length, afterIndex + 1));
      const { layout: newLayout, spec: newSpec } = blankSlide();
      const deck = state.deck.slice();
      deck.splice(at, 0, newSpec);
      const slides = (state.layout?.slides ?? []).slice();
      slides.splice(at, 0, newLayout);
      const layout: DeckLayout = { ...(state.layout ?? { slides: [] }), slides };
      return { deck, layout };
    }),

  deleteSlide: (index) =>
    set((state) => {
      if (index < 0 || index >= state.deck.length) return {};
      const deck = state.deck.filter((_, i) => i !== index);
      const layout = state.layout
        ? { ...state.layout, slides: state.layout.slides.filter((_, i) => i !== index) }
        : state.layout;
      return { deck, layout };
    }),

  setExportResult: (exportResult) => set({ exportResult, status: 'done' }),

  reset: () => set({ ...initialState }),
}));
