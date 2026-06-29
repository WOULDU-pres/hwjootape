import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { layoutToSpec } from '@/lib/slides/compose';
import { getTheme } from '@/lib/slides/themes';
import { validateSlideSpec, type SlideSpec } from '@/lib/slides/spec';
import type { DeckLayout } from '@/lib/slides/layout-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * recompose — the INSTANT theme-swap step. Pure and LLM-free.
 *
 * Given an already-designed `DeckLayout` (from the design route) and an optional
 * `themeId`, this re-applies the requested curated theme to the SAME layout and
 * returns fresh editable `SlideSpec[]`. No provider/LLM call: layout is the
 * authoritative content, the theme only supplies geometry/typography/color, so
 * swapping the theme is a deterministic `layoutToSpec(layout, getTheme(themeId))`.
 */

/** Shallow guard that `body.layout` is a usable DeckLayout (slides: SlideLayout[]). */
function isDeckLayout(v: unknown): v is DeckLayout {
  return Boolean(v && typeof v === 'object' && Array.isArray((v as DeckLayout).slides));
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();

    if (!isDeckLayout(body?.layout)) {
      return NextResponse.json(
        { error: 'layout (DeckLayout) is required' },
        { status: 400 },
      );
    }
    const layout: DeckLayout = body.layout;

    const themeId = typeof body?.themeId === 'string' ? body.themeId : undefined;

    // Resolve the curated theme (falls back to the default theme if unknown).
    const theme = getTheme(themeId);

    // Apply the theme → editable, text-only SlideSpec[]. Pure mapping; no LLM call.
    const deck: SlideSpec[] = layoutToSpec(layout, theme);

    // Every emitted spec MUST pass validateSlideSpec before we hand it onward.
    const specErrors = deck.flatMap((spec, i) =>
      validateSlideSpec(spec).errors.map((e) => `slide ${i}: ${e}`),
    );
    if (specErrors.length > 0) {
      return NextResponse.json({ error: 'Invalid composed deck', details: specErrors }, { status: 500 });
    }

    return NextResponse.json({
      deck,
      themeId: theme.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Recompose failed';
    console.error('Slide recompose error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
