import { describe, it, expect, vi } from 'vitest';
import { generateDeckSlides } from './full-deck';
import type { StylePreset } from './style-presets';
import type { SlideOutline } from './deck';

const noSleep = () => Promise.resolve();
const preset: StylePreset = { id: 'a', name: '에이', prompt: 'style A' };
const o = (t: string): SlideOutline => ({ title: t, bullets: [] });

describe('generateDeckSlides', () => {
  it('generates an image per job, passes references through, and preserves slide order', async () => {
    const generateImage = vi.fn<(o: { prompt: string; images?: string[] }) => Promise<string>>(
      async () => 'data:image/png;base64,OK',
    );
    const refs = ['data:image/png;base64,REF1', 'data:image/png;base64,REF2'];
    const result = await generateDeckSlides(
      {
        jobs: [
          { slideIndex: 3, outline: o('넷째') },
          { slideIndex: 4, outline: o('다섯째') },
        ],
        preset,
        referenceImages: refs,
      },
      { generateImage, sleep: noSleep },
    );

    expect(generateImage).toHaveBeenCalledTimes(2);
    // references are forwarded to god-tibo so the new slides match the chosen look
    expect(generateImage.mock.calls[0][0].images).toEqual(refs);
    expect(result.slides.map((s) => s.slideIndex)).toEqual([3, 4]);
    expect(result.slides.every((s) => s.dataUrl === 'data:image/png;base64,OK')).toBe(true);
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('tolerates a slide that fails every attempt (null + error, others unaffected)', async () => {
    const generateImage = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('다섯째')) throw new Error('boom');
      return 'data:image/png;base64,OK';
    });
    const result = await generateDeckSlides(
      {
        jobs: [
          { slideIndex: 3, outline: o('넷째') },
          { slideIndex: 4, outline: o('다섯째') },
        ],
        preset,
        referenceImages: [],
        retries: 1,
      },
      { generateImage, sleep: noSleep },
    );
    expect(result.slides[0].dataUrl).toBe('data:image/png;base64,OK');
    expect(result.slides[1].dataUrl).toBeNull();
    expect(result.slides[1].error).toBe('boom');
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(1);
  });
});
