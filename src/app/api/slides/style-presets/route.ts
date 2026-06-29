import { NextResponse } from 'next/server';
import { STYLE_PRESETS, DEFAULT_VERSION_COUNT } from '@/lib/slides/style-presets';

export const runtime = 'nodejs';

/** List the available style presets (id + name) and the default version count for the picker. */
export async function GET() {
  return NextResponse.json({
    presets: STYLE_PRESETS.map((p) => ({ id: p.id, name: p.name })),
    defaultCount: DEFAULT_VERSION_COUNT,
  });
}
