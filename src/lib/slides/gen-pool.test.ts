import { describe, it, expect, vi } from 'vitest';
import { runWithConcurrency, withRetry } from './gen-pool';

const noSleep = () => Promise.resolve();

describe('runWithConcurrency', () => {
  it('runs all jobs and preserves input order in results', async () => {
    const results = await runWithConcurrency(
      [async () => 'a', async () => 'b', async () => 'c'],
      2,
    );
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('never exceeds the concurrency limit at any instant', async () => {
    let active = 0;
    let peak = 0;
    const job = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return active;
    };
    await runWithConcurrency([job(), job(), job(), job(), job()], 2);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('withRetry', () => {
  it('returns the value on first success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const value = await withRetry(fn, 2, noSleep);
    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to the budget then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    const value = await withRetry(fn, 2, noSleep);
    expect(value).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after exhausting the budget', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always'));
    await expect(withRetry(fn, 2, noSleep)).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});
