import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { resolveSam3Command, startInstallInBackground, isAutoInstallSupported } from '@/lib/magic-layer/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface SegmentResponse {
  id?: string;
  label?: string;
  bbox: { x: number; y: number; width: number; height: number };
  maskDataUrl?: string;
}

function isFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0;
}

function sanitizeSegments(value: unknown): SegmentResponse[] {
  const raw = Array.isArray(value) ? value : (value && typeof value === 'object' && Array.isArray((value as { segments?: unknown }).segments) ? (value as { segments: unknown[] }).segments : []);
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as { id?: unknown; label?: unknown; bbox?: unknown; box?: unknown; maskDataUrl?: unknown; mask?: unknown };
    const box = candidate.bbox ?? candidate.box;
    if (!box || typeof box !== 'object') return [];
    const b = box as { x?: unknown; y?: unknown; width?: unknown; height?: unknown; w?: unknown; h?: unknown };
    const x = Number(b.x);
    const y = Number(b.y);
    const width = Number(b.width ?? b.w);
    const height = Number(b.height ?? b.h);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    return [{
      id: typeof candidate.id === 'string' ? candidate.id : `sam3-${index + 1}`,
      label: typeof candidate.label === 'string' ? candidate.label : `SAM3 layer ${index + 1}`,
      bbox: { x, y, width, height },
      maskDataUrl: typeof candidate.maskDataUrl === 'string' ? candidate.maskDataUrl : (typeof candidate.mask === 'string' ? candidate.mask : undefined),
    }];
  });
}

async function runSam3Command(image: File, argv: string[]): Promise<SegmentResponse[] | null> {
  if (!argv.length) return null;
  const dir = await mkdtemp(path.join(/*turbopackIgnore: true*/ tmpdir(), 'bananatape-sam3-'));
  const inputPath = path.join(dir, 'input.png');
  const outputPath = path.join(dir, 'segments.json');
  try {
    await writeFile(inputPath, Buffer.from(await image.arrayBuffer()));
    const [bin, ...configuredArgs] = argv;
    const args = configuredArgs.map((arg) => arg.replaceAll('{input}', inputPath).replaceAll('{output}', outputPath));
    if (!args.some((arg) => arg.includes(inputPath))) args.push('--input', inputPath);
    if (!args.some((arg) => arg.includes(outputPath))) args.push('--output', outputPath);
    await execFileAsync(bin, args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
    const segments = sanitizeSegments(parsed);
    if (segments.length === 0) throw new Error('SAM3 command did not return any usable segments');
    return segments;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fallbackSegments(width: number, height: number): SegmentResponse[] {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return [
    { id: 'text-band', label: 'Text / foreground band', bbox: { x: Math.round(w * 0.12), y: Math.round(h * 0.1), width: Math.round(w * 0.76), height: Math.round(h * 0.2) } },
    { id: 'subject-center', label: 'Main subject', bbox: { x: Math.round(w * 0.22), y: Math.round(h * 0.28), width: Math.round(w * 0.56), height: Math.round(h * 0.5) } },
    { id: 'lower-detail', label: 'Lower detail', bbox: { x: Math.round(w * 0.18), y: Math.round(h * 0.72), width: Math.round(w * 0.64), height: Math.round(h * 0.18) } },
  ];
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const image = formData.get('image');
    const width = Number(formData.get('width'));
    const height = Number(formData.get('height'));
    if (!isFile(image)) return NextResponse.json({ error: 'image file is required' }, { status: 400 });
    if (image.size > MAX_IMAGE_BYTES) return NextResponse.json({ error: 'image must be 20 MB or smaller' }, { status: 413 });
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return NextResponse.json({ error: 'width and height are required' }, { status: 400 });
    }

    const resolved = await resolveSam3Command();

    if (resolved.source === 'auto-mlx' && resolved.argv) {
      const segments = await runSam3Command(image, resolved.argv);
      return NextResponse.json({ success: true, source: 'sam3', segments: segments ?? fallbackSegments(width, height) });
    }

    if (resolved.source === 'env' && resolved.argv) {
      const segments = await runSam3Command(image, resolved.argv);
      return NextResponse.json({ success: true, source: 'sam3', segments: segments ?? fallbackSegments(width, height) });
    }

    if (isAutoInstallSupported()) {
      const attempt = await startInstallInBackground();
      if (attempt.status === 'started' || attempt.status === 'already-installing') {
        return NextResponse.json(
          { success: false, setupRequired: true, setupStatus: attempt.status, message: attempt.message },
          { status: 202, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (attempt.status === 'missing-uv' || attempt.status === 'failed') {
        return NextResponse.json({
          success: true,
          source: 'fallback',
          segments: fallbackSegments(width, height),
          setupHint: { errorCode: attempt.errorCode, message: attempt.message },
        });
      }
    }

    return NextResponse.json({ success: true, source: 'fallback', segments: fallbackSegments(width, height) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Magic Layer segmentation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
