import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { parseOutline, type SlideOutline } from '@/lib/slides/deck';
import { designDeck } from '@/lib/slides/layout-designer';
import { layoutToSpec } from '@/lib/slides/compose';
import { getTheme } from '@/lib/slides/themes';
import { validateSlideSpec, type SlideSpec } from '@/lib/slides/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A structured outline item from the body (mirrors draft/route.ts's isOutline). */
function isOutline(v: unknown): v is SlideOutline {
  return Boolean(v && typeof v === 'object' && typeof (v as SlideOutline).title === 'string');
}

/** Normalize a structured outline item: title string + bullets string[]. */
function normalizeOutline(v: SlideOutline): SlideOutline {
  return {
    title: v.title,
    bullets: Array.isArray(v.bullets) ? v.bullets.filter((b): b is string => typeof b === 'string') : [],
  };
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();

    // Outline can arrive as raw text (parsed via parseOutline → ALL slides) or as
    // a pre-structured SlideOutline[]. parseOutline NEVER takes just [0]; it
    // returns every slide block in the outline.
    let outlines: SlideOutline[];
    if (typeof body?.outlineText === 'string' && body.outlineText.trim()) {
      outlines = parseOutline(body.outlineText);
    } else if (Array.isArray(body?.outlines)) {
      outlines = body.outlines.filter(isOutline).map(normalizeOutline);
    } else {
      outlines = [];
    }
    if (outlines.length === 0) {
      return NextResponse.json(
        { error: 'outlineText or outlines (SlideOutline[]) is required' },
        { status: 400 },
      );
    }

    const themeId = typeof body?.themeId === 'string' ? body.themeId : undefined;
    const styleHint = typeof body?.styleHint === 'string' ? body.styleHint : undefined;
    void styleHint; // reserved for the imagery route; carried through the body contract.

    // Resolve the curated theme (falls back to the default theme if unknown).
    const theme = getTheme(themeId);

    // gpt-5.5 designs the layout (archetype + title + bullets + imageZone per
    // slide); designDeck STRICTLY validates and degrades to a deterministic
    // fallback on any failure, so this never hard-fails.
    const { layout } = await designDeck(outlines, theme);

    // Apply the theme → editable, text-only SlideSpec[] (imagery route appends
    // image elements + bakes any background later).
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
      layout,
      themeId: theme.id,
      slideCount: deck.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Design failed';
    console.error('Slide design error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
