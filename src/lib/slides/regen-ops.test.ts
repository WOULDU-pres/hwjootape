import { describe, it, expect, vi } from 'vitest';
import { regenerateElementImage, buildElementRegenPrompt } from './regen-ops';

const noSleep = () => Promise.resolve();

describe('buildElementRegenPrompt', () => {
  it('embeds the user requirement and forbids baked text', () => {
    const p = buildElementRegenPrompt('파란색 로켓으로 바꿔줘');
    expect(p).toContain('파란색 로켓으로 바꿔줘');
    expect(p.toLowerCase()).toMatch(/no text|no letters/);
  });
});

describe('regenerateElementImage', () => {
  it('regenerates with the requirement and passes the current image as a reference', async () => {
    const generateImage = vi.fn<(o: { prompt: string; images?: string[] }) => Promise<string>>(
      async () => 'data:image/png;base64,NEW',
    );
    const out = await regenerateElementImage(
      { currentImageDataUrl: 'data:image/png;base64,CUR', requirement: '더 밝게' },
      { generateImage, sleep: noSleep },
    );
    expect(out).toBe('data:image/png;base64,NEW');
    const call = generateImage.mock.calls[0][0];
    expect(call.prompt).toContain('더 밝게');
    expect(call.images).toEqual(['data:image/png;base64,CUR']);
  });

  it('works without a current image (pure-prompt regeneration)', async () => {
    const generateImage = vi.fn<(o: { prompt: string; images?: string[] }) => Promise<string>>(
      async () => 'data:image/png;base64,NEW',
    );
    await regenerateElementImage({ requirement: '아이콘 새로' }, { generateImage, sleep: noSleep });
    expect(generateImage.mock.calls[0][0].images).toBeUndefined();
  });

  it('retries on failure then succeeds', async () => {
    const generateImage = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('data:image/png;base64,OK');
    const out = await regenerateElementImage({ requirement: 'r', retries: 2 }, { generateImage, sleep: noSleep });
    expect(out).toBe('data:image/png;base64,OK');
    expect(generateImage).toHaveBeenCalledTimes(2);
  });
});
