/**
 * layout-designer — the LAYOUT-FIRST deck generator's design step.
 *
 * Given a user outline (title + bullets per slide) and a curated `Theme`, ask
 * gpt-5.5 (the private codex backend, via `generateLayout`) to design a
 * `DeckLayout`: an archetype + title + bullets + optional `imageZone` per slide.
 * The PROVEN prompt shape is mirrored from scripts/qa-layout-probe.mjs.
 *
 * `designDeck` is defensive by contract: it STRICTLY validates the returned JSON
 * (slide count, archetype enum, bbox bounds) and, on ANY parse/validation
 * failure, returns a deterministic FALLBACK `DeckLayout` derived from the outline
 * + theme so the pipeline never hard-fails. The fallback is annotated (logged +
 * carried on the result) so callers can tell a designed deck from a fallback one.
 */
import { generateLayout as godTiboGenerateLayout } from '@/lib/providers/god-tibo-provider';
import type { SlideOutline } from './deck';
import type {
  Archetype,
  DeckLayout,
  ImageZone,
  SlideLayout,
  Theme,
} from './layout-types';
import type { NBBox } from './spec';

/** The exact archetype set the designer may emit (proven in the spike). */
export const ARCHETYPES: Archetype[] = [
  'title',
  'section',
  'bullets',
  'bullets-image-right',
  'quote',
  'closing',
];

/** Human-readable archetype menu embedded in the prompt (mirrors the probe). */
const ARCHETYPE_MENU: Record<Archetype, string> = {
  title: 'title: 표지/커버 슬라이드 (큰 제목, 불릿/이미지 없음).',
  section: 'section: 섹션 구분 슬라이드 (제목만).',
  bullets: 'bullets: 제목 + 불릿 목록 (이미지 없음).',
  'bullets-image-right': 'bullets-image-right: 제목 + 좌측 불릿 + 우측 이미지 영역.',
  quote: 'quote: 인용/강조 문구 슬라이드.',
  closing: 'closing: 마무리/감사 슬라이드.',
};

/**
 * Injectable dependency surface so tests can stub the provider call without any
 * live backend traffic. `generateLayout` returns the raw assistant text (one JSON
 * object); the caller strips code fences + JSON.parse + validates.
 */
export interface DesignDeckDeps {
  generateLayout: (options: { prompt: string }) => Promise<string>;
}

const defaultDeps: DesignDeckDeps = {
  generateLayout: (options) => godTiboGenerateLayout(options),
};

/**
 * Build the designer prompt. Mirrors the PROVEN probe PROMPT:
 * - archetype enum limited to the theme's archetypes (which is the full set),
 * - normalized 0..1 coords, (x,y) top-left, (w,h) size,
 * - slides.length === outlines.length,
 * - imageZone null unless the outline item clearly warrants an image, and never
 *   overlapping the title (title typically occupies the top band).
 *
 * The outline (title + bullets per slide) and the allowed archetypes are embedded.
 */
export function buildLayoutPrompt(outlines: SlideOutline[], theme: Theme): string {
  // The allowed archetypes ARE the keys the theme supplies a layout for.
  const allowed = (Object.keys(theme.layout) as Archetype[]).filter((a) =>
    ARCHETYPES.includes(a),
  );

  const themeBlock = [
    `이 덱은 16:9 프레젠테이션 테마 "${theme.name}"이다.`,
    `각 슬라이드의 archetype은 다음 중에서만 고른다: ${allowed.join(', ')}.`,
    ...allowed.map((a) => `- ${ARCHETYPE_MENU[a]}`),
  ].join('\n');

  const outlineBlock = outlines
    .map((o, i) => {
      const bullets = o.bullets.length
        ? `\n   - 불릿: ${o.bullets.map((b) => `"${b}"`).join(', ')}`
        : '\n   - 불릿: 없음';
      return `${i + 1}) 제목: "${o.title}"${bullets}`;
    })
    .join('\n');

  return [
    '너는 슬라이드 레이아웃 디자이너다. 아래 아웃라인의 각 항목을 16:9 캔버스의 슬라이드 하나로 설계하라.',
    '',
    themeBlock,
    '',
    '출력 규칙 (반드시 지킬 것):',
    '- 오직 하나의 JSON 객체만 출력한다. 산문, 설명, 마크다운 코드펜스(```)를 절대 쓰지 마라.',
    '- JSON 형태:',
    '  {"slides":[{"archetype":"' +
      allowed.join('|') +
      '","title":"문자열","bullets":["..."],"imageZone":{"x":0~1,"y":0~1,"w":0~1,"h":0~1} 또는 null}]}',
    '- 좌표(x,y,w,h)는 16:9 캔버스에서 0..1로 정규화된 값이다. (x,y)는 좌상단, (w,h)는 너비/높이.',
    '- 텍스트만 있는 슬라이드는 imageZone을 null로 둔다.',
    '- imageZone은 아웃라인 항목이 이미지를 명확히 필요로 할 때만 둔다(예: 제품/사진/다이어그램 언급).',
    '- imageZone은 제목 영역과 절대 겹치면 안 된다 (제목은 보통 캔버스 상단을 차지한다).',
    '- 모든 좌표는 0 이상 1 이하이며, x+w<=1, y+h<=1 이어야 한다.',
    `- slides 배열의 길이는 아웃라인 항목 수와 정확히 같아야 한다 (총 ${outlines.length}개).`,
    '- 각 슬라이드의 title은 해당 아웃라인 항목의 제목을 그대로 사용한다.',
    '- bullets가 없는 archetype(title/section/quote/closing 등)이면 bullets는 빈 배열로 둔다.',
    '',
    '아웃라인:',
    outlineBlock,
  ].join('\n');
}

/** Strip leading/trailing markdown code fences if present. */
export function stripCodeFences(text: string): string {
  let t = text.trim();
  const fenced = t.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '');
  if (t.endsWith('```')) t = t.replace(/\n?```$/, '');
  return t.trim();
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A single bbox is valid iff every field is finite, in [0,1], and fits the unit box. */
function isValidImageZone(z: unknown): z is ImageZone {
  if (z == null || typeof z !== 'object') return false;
  const { x, y, w, h } = z as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
    return false;
  }
  if (x < 0 || y < 0 || w < 0 || h < 0) return false;
  if (x > 1 || y > 1 || w > 1 || h > 1) return false;
  // Small epsilon tolerance, matching the spike's bboxesWithinUnit.
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  return true;
}

/**
 * STRICTLY validate a parsed value into a `DeckLayout`. Returns the typed layout
 * on success or `null` on ANY failure (which triggers the deterministic fallback):
 *  - top-level `slides` is an array of exactly `expectedCount`,
 *  - every slide.archetype is in the allowed enum,
 *  - every slide.title is a string, bullets is a string[],
 *  - every imageZone, if present (not null), has x/y/w/h in [0,1] with x+w<=1, y+h<=1.
 */
export function validateDeckLayout(
  parsed: unknown,
  expectedCount: number,
  allowed: Archetype[] = ARCHETYPES,
): DeckLayout | null {
  if (parsed == null || typeof parsed !== 'object') return null;
  const slides = (parsed as { slides?: unknown }).slides;
  if (!Array.isArray(slides)) return null;
  if (slides.length !== expectedCount) return null;

  const allowedSet = new Set<string>(allowed);
  const out: SlideLayout[] = [];

  for (const raw of slides) {
    if (raw == null || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;

    if (typeof s.archetype !== 'string' || !allowedSet.has(s.archetype)) return null;
    if (typeof s.title !== 'string') return null;

    let bullets: string[] = [];
    if (Array.isArray(s.bullets)) {
      if (!s.bullets.every((b) => typeof b === 'string')) return null;
      bullets = s.bullets as string[];
    } else if (s.bullets != null) {
      return null;
    }

    let imageZone: ImageZone | null = null;
    if (s.imageZone != null) {
      if (!isValidImageZone(s.imageZone)) return null;
      const z = s.imageZone as NBBox;
      imageZone = { x: z.x, y: z.y, w: z.w, h: z.h };
    }

    const slide: SlideLayout = {
      archetype: s.archetype as Archetype,
      title: s.title,
      bullets,
      imageZone,
    };
    if (typeof s.notes === 'string') slide.notes = s.notes;
    out.push(slide);
  }

  return { slides: out };
}

/**
 * Deterministic FALLBACK layout derived purely from the outline + theme.
 * Slide 1 -> title, last -> closing, all middle slides -> bullets. imageZone null.
 * Single-slide decks collapse to just `title`. Used whenever the designer call or
 * its validation fails, so the pipeline degrades gracefully instead of erroring.
 */
export function fallbackDeckLayout(outlines: SlideOutline[], theme: Theme): DeckLayout {
  const allowed = new Set<string>(Object.keys(theme.layout));
  const last = outlines.length - 1;

  const pick = (preferred: Archetype, alt: Archetype): Archetype =>
    allowed.has(preferred) ? preferred : alt;

  const slides: SlideLayout[] = outlines.map((o, i) => {
    let archetype: Archetype;
    if (i === 0) archetype = pick('title', 'bullets');
    else if (i === last) archetype = pick('closing', 'bullets');
    else archetype = pick('bullets', 'title');

    // Title-only archetypes carry no bullets even if the outline supplied some.
    const wantsBullets = archetype === 'bullets' || archetype === 'bullets-image-right';
    return {
      archetype,
      title: o.title,
      bullets: wantsBullets ? o.bullets : [],
      imageZone: null,
    };
  });

  return { slides };
}

/** Result of `designDeck`: the layout plus whether the deterministic fallback was used. */
export interface DesignDeckResult {
  layout: DeckLayout;
  usedFallback: boolean;
}

/**
 * Design a `DeckLayout` for the outline using the curated theme. Calls
 * `generateLayout` (the gpt-5.5 layout twin of generateImage), strips code
 * fences, JSON.parses, then STRICTLY validates (exactly outlines.length slides,
 * archetypes in enum, every imageZone bounded in the unit box). On ANY failure
 * it returns the deterministic fallback and annotates `usedFallback`.
 *
 * `deps` is injectable so tests can mock the provider with zero live calls.
 */
export async function designDeck(
  outlines: SlideOutline[],
  theme: Theme,
  deps: DesignDeckDeps = defaultDeps,
): Promise<DesignDeckResult> {
  const allowed = (Object.keys(theme.layout) as Archetype[]).filter((a) =>
    ARCHETYPES.includes(a),
  );

  const fallback = (reason: string): DesignDeckResult => {
    // Annotate so callers/operators can tell a fallback deck from a designed one.
    console.warn(`[layout-designer] using fallback DeckLayout: ${reason}`);
    return { layout: fallbackDeckLayout(outlines, theme), usedFallback: true };
  };

  const prompt = buildLayoutPrompt(outlines, theme);

  let raw: string;
  try {
    raw = await deps.generateLayout({ prompt });
  } catch (error) {
    return fallback(`generateLayout threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback('empty assistant text');
  }

  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return fallback(`JSON.parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const layout = validateDeckLayout(parsed, outlines.length, allowed);
  if (!layout) {
    return fallback('validation failed (slide count / archetype / bbox)');
  }

  return { layout, usedFallback: false };
}
