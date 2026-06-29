/**
 * style-presets — the curated set of slide design aesthetics that drive the
 * version picker. Each preset becomes one "version" the user can choose from.
 *
 * Data-driven on purpose (ADR-0002 decision): adding a preset = adding one object
 * here, no code change. The version generator defaults to the whole registry, so
 * "more presets available" just means a longer list. The user's optional free-text
 * style hint is combined with the chosen preset as a global modifier at prompt time.
 *
 * `prompt` is the English style direction handed to god-tibo (codex designs the
 * layout autonomously — we only steer the aesthetic, per the minimal-prompt decision).
 * `name` is the Korean label shown in the picker UI.
 */
export interface StylePreset {
  /** Stable id (kebab-case) used in API payloads and asset bookkeeping. */
  id: string;
  /** Korean label for the picker. */
  name: string;
  /** English style direction appended to the slide prompt. */
  prompt: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'minimal',
    name: '미니멀',
    prompt:
      'Minimalist design: lots of white space, thin clean sans-serif type, a single restrained accent color, calm grid.',
  },
  {
    id: 'bold-corporate',
    name: '볼드 코퍼릿',
    prompt:
      'Bold corporate design: a strong solid header band, high contrast, heavy confident sans-serif headings, polished business look.',
  },
  {
    id: 'flat-illustration',
    name: '플랫 일러스트',
    prompt:
      'Flat illustration style: simple vector illustrations and icons, soft pastel palette, friendly and modern.',
  },
  {
    id: 'photo-editorial',
    name: '사진 에디토리얼',
    prompt:
      'Editorial photo style: a full-bleed photographic background with a subtle gradient overlay so any text reads clearly, magazine-like composition.',
  },
  {
    id: 'gradient-modern',
    name: '그라데이션 모던',
    prompt:
      'Modern gradient style: smooth colorful gradients, soft glassmorphism cards, rounded shapes, contemporary SaaS aesthetic.',
  },
  {
    id: 'dark-tech',
    name: '다크 테크',
    prompt:
      'Dark tech style: dark background, neon accent highlights, sleek futuristic technology aesthetic.',
  },
  {
    id: 'hand-drawn',
    name: '핸드드로운',
    prompt:
      'Hand-drawn doodle style: sketchy outlines, handwritten-feel headings, warm and approachable.',
  },
  {
    id: 'typographic',
    name: '타이포그래픽',
    prompt:
      'Typographic style: large expressive typography as the main visual, minimal graphics, strong type hierarchy.',
  },
  {
    id: 'newspaper-grid',
    name: '뉴스페이퍼 그리드',
    prompt:
      'Editorial grid / newspaper style: structured multi-column grid, serif headlines, refined and informational.',
  },
  {
    id: 'memo-sticky',
    name: '메모 콜라주',
    prompt:
      'Sticky-note / scrapbook style: paper textures, sticky notes and tape, playful collage layout.',
  },
  {
    id: 'blueprint-technical',
    name: '블루프린트',
    prompt:
      'Blueprint / technical style: blueprint-grid background, technical line-art, monospaced labels, engineering aesthetic.',
  },
  {
    id: 'luxury-serif',
    name: '럭셔리 세리프',
    prompt:
      'Luxury editorial style: elegant high-contrast serif type, generous margins, cream and gold accents, premium feel.',
  },
];

/** Default number of versions generated when the caller does not specify a subset. */
export const DEFAULT_VERSION_COUNT = 8;

export function listStylePresets(): StylePreset[] {
  return STYLE_PRESETS;
}

export function getStylePreset(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((preset) => preset.id === id);
}
