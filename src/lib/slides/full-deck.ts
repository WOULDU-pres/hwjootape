/**
 * full-deck — Phase 3 of the bake-decompose pipeline (ADR-0002). After the user
 * picks a version, the full deck is rendered in that look: the chosen sample slides
 * are reused as-is (the route handles that), and the remaining slides are generated
 * here with those samples passed to god-tibo as REFERENCE IMAGES so the new slides
 * inherit the same style.
 *
 * Like `versions`, this is the orchestration seam: generation + backoff are injected,
 * fan-out is capped, per-slide failure is tolerated, and no project I/O happens here.
 */
import type { SlideOutline } from './deck';
import type { StylePreset } from './style-presets';
import { buildVersionPrompt } from './versions';
import { runWithConcurrency, withRetry } from './gen-pool';

export interface GenerateDeckSlidesDeps {
  generateImage: (options: { prompt: string; images?: string[] }) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeckSlideJob {
  /** Index into the full deck this slide occupies. */
  slideIndex: number;
  outline: SlideOutline;
}

export interface GenerateDeckSlidesInput {
  jobs: DeckSlideJob[];
  preset: StylePreset;
  styleHint?: string;
  /** The chosen version's sample images, forwarded as god-tibo references. */
  referenceImages: string[];
  concurrency?: number;
  retries?: number;
}

export interface FullDeckSlide {
  slideIndex: number;
  dataUrl: string | null;
  error?: string;
}

export interface GenerateDeckSlidesResult {
  slides: FullDeckSlide[];
  generated: number;
  failed: number;
}

export async function generateDeckSlides(
  input: GenerateDeckSlidesInput,
  deps: GenerateDeckSlidesDeps,
): Promise<GenerateDeckSlidesResult> {
  const concurrency = input.concurrency ?? 8;
  const retries = input.retries ?? 2;
  const images = input.referenceImages.length > 0 ? input.referenceImages : undefined;

  const slides = await runWithConcurrency(
    input.jobs.map((job) => async (): Promise<FullDeckSlide> => {
      const prompt = buildVersionPrompt(job.outline, input.preset, input.styleHint);
      try {
        const dataUrl = await withRetry(() => deps.generateImage({ prompt, images }), retries, deps.sleep);
        return { slideIndex: job.slideIndex, dataUrl };
      } catch (error) {
        return {
          slideIndex: job.slideIndex,
          dataUrl: null,
          error: error instanceof Error ? error.message : 'Image generation failed',
        };
      }
    }),
    concurrency,
  );

  let generated = 0;
  let failed = 0;
  for (const slide of slides) {
    if (slide.dataUrl) generated++;
    else failed++;
  }
  return { slides, generated, failed };
}
