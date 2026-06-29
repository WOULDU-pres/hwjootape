import { NextResponse } from 'next/server';
import { listThemes } from '@/lib/slides/themes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * themes — the authoritative list of curated themes for the SETUP selector and the
 * client-side PREVIEW. It exposes ONLY the fields the UI needs (id + name for the
 * <select>, and palette.bg + the font pair for SlidePreview), derived from
 * `listThemes()` (stable order, default theme first). This retires the hardcoded
 * client-side mirror in deck/page.tsx so the server stays the single source of truth.
 *
 * Static theme DATA — no project context required (unlike the design/recompose
 * siblings), so this is a plain GET with no resolveRequestProjectRoot call. It keeps
 * the same runtime/dynamic config and the `{ error }` envelope as its siblings.
 */
export async function GET() {
  try {
    const themes = listThemes().map((t) => ({
      id: t.id,
      name: t.name,
      bg: t.palette.bg,
      fontLatin: t.fonts.latin,
      fontEA: t.fonts.ea,
    }));
    return NextResponse.json({ themes });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list themes';
    console.error('Slide themes error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
