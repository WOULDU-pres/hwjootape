import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { persistImageResult } from '@/lib/projects/asset-store';
import { generateImage } from '@/lib/providers/god-tibo-provider';
import { getTheme } from '@/lib/slides/themes';
import type { Theme } from '@/lib/slides/layout-types';
import type { DeckLayout, SlideLayout } from '@/lib/slides/layout-types';
import type { NBBox, SlideSpec } from '@/lib/slides/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Max slides whose imagery is generated concurrently. Keeps us from hammering
 *  the private codex backend with N parallel image_generation calls at once. */
const CONCURRENCY = 3;

/** Z for a decorative side-panel image: above any (future) full-slide background
 *  but below the title/body text (compose emits text at z:10/z:11). */
const IMAGE_Z = 5;

interface SlideFailure {
  /** Index into the deck / layout.slides array. */
  index: number;
  /** Stable slide id (mirrors the spec's slideId) when available. */
  slideId?: string;
  /** Human-readable failure reason. */
  error: string;
}

/**
 * Resolve the image zone for a slide: prefer the designer's per-slide `imageZone`,
 * else fall back to the theme archetype's `defaultImageZone`. Returns null when the
 * slide wants no imagery (text-only archetype with no zone) — that slide is skipped.
 */
function resolveImageZone(slide: SlideLayout, theme: Theme): NBBox | null {
  if (slide.imageZone) return slide.imageZone;
  const archetype = theme.layout[slide.archetype];
  return archetype?.defaultImageZone ?? null;
}

/**
 * Build the prompt for a DECORATIVE side-panel illustration. The image must carry
 * NO text (text lives in editable spec elements, not baked into the picture) and
 * should read as a tasteful graphic that complements the slide title + theme mood.
 */
function buildImagePrompt(slide: SlideLayout, theme: Theme, styleHint?: string): string {
  const subject = slide.title?.trim() || slide.notes?.trim() || 'the slide topic';
  const palette = theme.palette;
  const lines = [
    'Create a single decorative illustration / abstract graphic for a presentation slide.',
    `It accompanies a slide titled: "${subject}".`,
    `Theme mood: "${theme.name}" — a polished, professional business-deck aesthetic.`,
    `Use a restrained palette harmonizing with these colors (hex): background #${palette.bg}, foreground #${palette.fg}, accent #${palette.accent}, muted #${palette.muted}.`,
    'It will sit in a side panel of the slide, so compose it as a clean, balanced standalone graphic with comfortable margins.',
    'STRICT: absolutely NO text, NO letters, NO numbers, NO words, NO logos, NO watermarks anywhere in the image.',
    'No slide chrome, no borders, no UI; just the illustration/graphic itself on a simple background.',
  ];
  if (styleHint && styleHint.trim()) {
    lines.push(`Style direction: ${styleHint.trim()}.`);
  }
  return lines.join('\n');
}

/**
 * Generate + persist one decorative image and return the appended ImageElement.
 * Throws on failure (the caller records it per-slide and leaves that slide text-only).
 */
async function fillSlideImage(args: {
  projectRoot: string;
  index: number;
  slide: SlideLayout;
  spec: SlideSpec;
  zone: NBBox;
  theme: Theme;
  styleHint?: string;
}): Promise<void> {
  const { projectRoot, index, slide, spec, zone, theme, styleHint } = args;
  const prompt = buildImagePrompt(slide, theme, styleHint);
  const imageDataUrl = await generateImage({ prompt });
  const asset = await persistImageResult({
    projectRoot,
    imageDataUrl,
    prompt,
    provider: 'god-tibo',
    type: 'generate',
    parentId: null,
  });
  spec.elements.push({
    id: `img-${index}`,
    type: 'image',
    nbbox: zone,
    assetId: asset.historyEntry.assetId,
    z: IMAGE_Z,
  });
}

/** Run `tasks` with a fixed concurrency cap, collecting per-task failures. */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number,
  onError: (taskIndex: number, error: unknown) => void,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const taskIndex = cursor++;
      if (taskIndex >= tasks.length) return;
      try {
        await tasks[taskIndex]();
      } catch (error) {
        onError(taskIndex, error);
      }
    }
  });
  await Promise.all(workers);
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }

    const body = await request.json();
    const deck: SlideSpec[] = Array.isArray(body?.deck) ? body.deck : [];
    if (deck.length === 0) {
      return NextResponse.json({ error: 'deck (SlideSpec[]) is required' }, { status: 400 });
    }
    const layout: DeckLayout | null =
      body?.layout && Array.isArray(body.layout.slides) ? (body.layout as DeckLayout) : null;
    if (!layout) {
      return NextResponse.json({ error: 'layout (DeckLayout) is required' }, { status: 400 });
    }
    if (layout.slides.length !== deck.length) {
      return NextResponse.json(
        { error: `layout/deck length mismatch: layout has ${layout.slides.length} slides, deck has ${deck.length}` },
        { status: 400 },
      );
    }

    const theme = getTheme(typeof body?.themeId === 'string' ? body.themeId : undefined);
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;

    // Decide which slides get imagery up front: any slide with a resolvable zone
    // (per-slide imageZone, or the archetype's defaultImageZone fallback).
    const jobs: Array<{ index: number; zone: NBBox }> = [];
    for (let i = 0; i < layout.slides.length; i++) {
      const zone = resolveImageZone(layout.slides[i], theme);
      if (zone) jobs.push({ index: i, zone });
    }

    const failures: SlideFailure[] = [];
    let filledCount = 0;

    const tasks = jobs.map(({ index, zone }) => async () => {
      await fillSlideImage({
        projectRoot,
        index,
        slide: layout.slides[index],
        spec: deck[index],
        zone,
        theme,
        styleHint,
      });
      filledCount++;
    });

    await runWithConcurrency(tasks, CONCURRENCY, (taskIndex, error) => {
      const { index } = jobs[taskIndex];
      const message = error instanceof Error ? error.message : 'Image generation failed';
      console.error(`Slide imagery failed for slide ${index}:`, error);
      failures.push({ index, slideId: deck[index]?.slideId, error: message });
    });

    return NextResponse.json({ deck, filledCount, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Imagery failed';
    console.error('Slide imagery error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
