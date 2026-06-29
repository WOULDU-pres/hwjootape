import { describe, it, expect, vi } from 'vitest';
import { generateVersions, selectSampleIndices, buildVersionPrompt } from './versions';
import type { StylePreset } from './style-presets';
import type { SlideOutline } from './deck';

const noSleep = () => Promise.resolve();

function outline(title: string, bullets: string[] = []): SlideOutline {
  return { title, bullets };
}

const presets: StylePreset[] = [
  { id: 'a', name: '에이', prompt: 'style A' },
  { id: 'b', name: '비', prompt: 'style B' },
];

const deck = [outline('타이틀', ['t']), outline('둘째', ['x']), outline('셋째', ['y']), outline('넷째')];

describe('selectSampleIndices', () => {
  it('takes the first `count` slides (title + content)', () => {
    expect(selectSampleIndices(4, 3)).toEqual([0, 1, 2]);
  });

  it('caps at the number of slides available for short decks', () => {
    expect(selectSampleIndices(1, 3)).toEqual([0]);
    expect(selectSampleIndices(0, 3)).toEqual([]);
  });
});

describe('buildVersionPrompt', () => {
  it('includes the outline content and the preset style direction', () => {
    const prompt = buildVersionPrompt(outline('양자컴퓨팅', ['빠르다', '강력하다']), presets[0], '파란 톤');
    expect(prompt).toContain('양자컴퓨팅');
    expect(prompt).toContain('빠르다');
    expect(prompt).toContain('style A');
    expect(prompt).toContain('파란 톤');
    expect(prompt).toMatch(/16:9/);
  });
});

describe('generateVersions', () => {
  it('fans out presets × sample slides and groups results by version', async () => {
    const generateImage = vi.fn(async () => 'data:image/png;base64,AAAA');
    const result = await generateVersions(
      { outlines: deck, presets, sampleCount: 3 },
      { generateImage, sleep: noSleep },
    );

    // 2 presets × 3 samples = 6 calls
    expect(generateImage).toHaveBeenCalledTimes(6);
    expect(result.versions).toHaveLength(2);
    expect(result.versions[0].presetId).toBe('a');
    expect(result.versions[0].presetName).toBe('에이');
    expect(result.versions[0].samples.map((s) => s.slideIndex)).toEqual([0, 1, 2]);
    expect(result.versions[1].presetId).toBe('b');
    expect(result.generated).toBe(6);
    expect(result.failed).toBe(0);
    expect(result.versions[0].samples.every((s) => s.dataUrl === 'data:image/png;base64,AAAA')).toBe(true);
  });

  it('retries a failing call and succeeds within the retry budget', async () => {
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(new Error('5xx'))
      .mockResolvedValue('data:image/png;base64,OK');
    const result = await generateVersions(
      { outlines: [outline('one')], presets: [presets[0]], sampleCount: 1, retries: 2 },
      { generateImage, sleep: noSleep },
    );
    expect(generateImage).toHaveBeenCalledTimes(2); // 1 fail + 1 success
    expect(result.generated).toBe(1);
    expect(result.versions[0].samples[0].dataUrl).toBe('data:image/png;base64,OK');
  });

  it('tolerates a sample that fails every attempt (null dataUrl + error, others unaffected)', async () => {
    const generateImage = vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.includes('둘째')) throw new Error('always fails');
      return 'data:image/png;base64,OK';
    });
    const result = await generateVersions(
      { outlines: deck, presets: [presets[0]], sampleCount: 3, retries: 1 },
      { generateImage, sleep: noSleep },
    );
    const samples = result.versions[0].samples;
    expect(samples[0].dataUrl).toBe('data:image/png;base64,OK');
    expect(samples[1].dataUrl).toBeNull();
    expect(samples[1].error).toBe('always fails');
    expect(samples[2].dataUrl).toBe('data:image/png;base64,OK');
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('defaults to the first 8 presets when none are given', async () => {
    const generateImage = vi.fn(async () => 'data:image/png;base64,AAAA');
    const result = await generateVersions(
      { outlines: [outline('one')], sampleCount: 1 },
      { generateImage, sleep: noSleep },
    );
    expect(result.versions).toHaveLength(8);
  });
});
