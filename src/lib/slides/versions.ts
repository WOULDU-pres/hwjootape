/**
 * versions — Phase 1 of the bake-decompose pipeline (ADR-0002): generate N design
 * VERSIONS of the deck so the user can pick one. Each version = one style preset;
 * each version is previewed by a few representative sample slides (title + content).
 *
 * This module is the orchestration seam: it fans out god-tibo image calls with a
 * concurrency cap + retry, tolerates per-call failure, and returns a structured
 * result. Generation (`generateImage`) and the backoff `sleep` are INJECTED so the
 * whole flow is unit-testable with zero live backend calls (mirrors layout-designer's
 * `deps` pattern). Asset persistence is the caller's job (the route), keeping this
 * module pure of project I/O.
 */
import type { SlideOutline } from './deck';
import { STYLE_PRESETS, DEFAULT_VERSION_COUNT, type StylePreset } from './style-presets';
import { runWithConcurrency, withRetry } from './gen-pool';

export interface GenerateVersionsDeps {
  generateImage: (options: { prompt: string; images?: string[] }) => Promise<string>;
  /** Backoff between retries. Injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

export interface GenerateVersionsInput {
  /** The full deck outline (sample slides are chosen from this). */
  outlines: SlideOutline[];
  /** Optional global style modifier, applied to every version on top of its preset. */
  styleHint?: string;
  /** Presets to render as versions. Defaults to the first DEFAULT_VERSION_COUNT presets. */
  presets?: StylePreset[];
  /** Representative sample slides per version (title + content). Default 3. */
  sampleCount?: number;
  /** Max concurrent god-tibo calls. Default 8. */
  concurrency?: number;
  /** Extra attempts after the first on failure. Default 2 (so up to 3 tries). */
  retries?: number;
}

export interface VersionSample {
  presetId: string;
  /** Index into `outlines` this sample renders. */
  slideIndex: number;
  /** PNG data URL, or null if every attempt failed. */
  dataUrl: string | null;
  /** Failure reason when dataUrl is null. */
  error?: string;
}

export interface DeckVersion {
  presetId: string;
  presetName: string;
  /** Samples in slide order; length = min(sampleCount, outlines.length). */
  samples: VersionSample[];
}

export interface GenerateVersionsResult {
  versions: DeckVersion[];
  /** Count of samples that produced an image. */
  generated: number;
  /** Count of samples that failed every attempt. */
  failed: number;
}

/**
 * Pick representative sample slides: the title slide plus the next content slides,
 * capped at `count` and at the number of slides available. Falls back gracefully for
 * short decks (e.g. a 1-slide outline yields a single sample).
 */
export function selectSampleIndices(slideCount: number, count: number): number[] {
  const n = Math.max(0, Math.min(count, slideCount));
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Compose the prompt for ONE sample slide in a given preset. Asks for a COMPLETE,
 * polished 16:9 slide with the content laid out (codex designs the layout itself).
 * Korean text may render garbled here — these are previews for judging DESIGN; the
 * real text is laid back in after decompose (ADR-0002).
 */
export function buildVersionPrompt(outline: SlideOutline, preset: StylePreset, styleHint?: string): string {
  const bullets = outline.bullets.length
    ? `\nKey points:\n${outline.bullets.map((b) => `- ${b}`).join('\n')}`
    : '';
  const lines = [
    'Design ONE complete 16:9 widescreen presentation slide (wide, much wider than tall) — a full finished layout, not just a background.',
    `Title: ${outline.title}`,
    bullets,
    `Lay the title and key points into the slide as part of the design (text may be approximate; it will be refined later).`,
    `Style: ${preset.prompt}`,
  ];
  if (styleHint && styleHint.trim()) {
    lines.push(`Additional style direction: ${styleHint.trim()}.`);
  }
  lines.push('Compose it as a clean, professional, presentation-ready slide.');
  return lines.join('');
}

interface SampleJob {
  versionIndex: number;
  presetId: string;
  slideIndex: number;
  prompt: string;
}

/**
 * Generate N versions × M sample slides. Never rejects on a single call's failure:
 * a sample that exhausts its retries comes back with `dataUrl: null` and an `error`,
 * so the picker can show the rest and mark the failed cell.
 */
export async function generateVersions(
  input: GenerateVersionsInput,
  deps: GenerateVersionsDeps,
): Promise<GenerateVersionsResult> {
  const presets = input.presets ?? STYLE_PRESETS.slice(0, DEFAULT_VERSION_COUNT);
  const sampleCount = input.sampleCount ?? 3;
  const concurrency = input.concurrency ?? 8;
  const retries = input.retries ?? 2;

  const sampleIndices = selectSampleIndices(input.outlines.length, sampleCount);

  const jobs: SampleJob[] = [];
  presets.forEach((preset, versionIndex) => {
    sampleIndices.forEach((slideIndex) => {
      jobs.push({
        versionIndex,
        presetId: preset.id,
        slideIndex,
        prompt: buildVersionPrompt(input.outlines[slideIndex], preset, input.styleHint),
      });
    });
  });

  const samples = await runWithConcurrency(
    jobs.map((job) => async (): Promise<VersionSample> => {
      try {
        const dataUrl = await withRetry(() => deps.generateImage({ prompt: job.prompt }), retries, deps.sleep);
        return { presetId: job.presetId, slideIndex: job.slideIndex, dataUrl };
      } catch (error) {
        return {
          presetId: job.presetId,
          slideIndex: job.slideIndex,
          dataUrl: null,
          error: error instanceof Error ? error.message : 'Image generation failed',
        };
      }
    }),
    concurrency,
  );

  // Regroup flat samples back into versions, preserving preset + slide order.
  const versions: DeckVersion[] = presets.map((preset) => ({
    presetId: preset.id,
    presetName: preset.name,
    samples: [],
  }));
  jobs.forEach((job, i) => {
    versions[job.versionIndex].samples.push(samples[i]);
  });

  let generated = 0;
  let failed = 0;
  for (const sample of samples) {
    if (sample.dataUrl) generated++;
    else failed++;
  }

  return { versions, generated, failed };
}
