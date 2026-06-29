import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolveRequestProjectRoot } from '@/lib/projects/session';
import { resolveInsideProject } from '@/lib/projects/paths';
import { resolveDeck, validateSlideSpec, type Deck } from '@/lib/slides/spec';
import { exportDeck } from '@/lib/slides/pptx-runner';

const MIN_PNG_WIDTH = 320;
const MAX_PNG_WIDTH = 7680;

function clampPngWidth(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 1920;
  return Math.max(MIN_PNG_WIDTH, Math.min(MAX_PNG_WIDTH, n));
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Build an assetId -> absolute path map from the project's assets/ + references/. */
async function buildAssetMap(projectRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const dir of ['assets', 'references']) {
    let abs: string;
    try {
      abs = await resolveInsideProject(projectRoot, dir);
    } catch {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(abs);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = name.replace(/\.[^.]+$/, '');
      if (!map.has(id)) map.set(id, path.join(abs, name));
    }
  }
  return map;
}

export async function POST(request: Request) {
  try {
    const projectRoot = await resolveRequestProjectRoot(request);
    if (!projectRoot) {
      return NextResponse.json({ error: '선택된 덱이 없습니다. 대시보드에서 덱을 여세요.' }, { status: 400 });
    }
    const body = await request.json();
    const deck: Deck = Array.isArray(body?.deck) ? body.deck : Array.isArray(body?.slides) ? body.slides : [];
    if (deck.length === 0) {
      return NextResponse.json({ error: 'deck (SlideSpec[]) is required' }, { status: 400 });
    }
    const specErrors = deck.flatMap((spec, i) =>
      validateSlideSpec(spec).errors.map((e) => `slide ${i}: ${e}`),
    );
    if (specErrors.length > 0) {
      return NextResponse.json({ error: 'Invalid deck', details: specErrors }, { status: 400 });
    }
    const baseName = typeof body?.baseName === 'string' && body.baseName.trim() ? body.baseName.trim() : 'deck';

    const assetMap = await buildAssetMap(projectRoot);
    const resolved = resolveDeck(deck, (assetId) => assetMap.get(assetId) ?? null);

    const outDir = await resolveInsideProject(projectRoot, 'exports');
    const tmpDir = await resolveInsideProject(projectRoot, 'tmp');
    const result = await exportDeck(resolved, {
      outDir,
      tmpDir,
      baseName,
      pngWidth: clampPngWidth(body?.pngWidth),
    });

    return NextResponse.json({
      success: true,
      pptxPath: result.pptxPath,
      pngPaths: result.pngPaths,
      slideCount: resolved.slides.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    console.error('Slide export error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
