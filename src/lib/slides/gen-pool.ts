/**
 * gen-pool — shared concurrency + retry primitives for the deck generation
 * orchestrators (versions, full-deck, regenerate). Extracted so every fan-out of
 * god-tibo calls shares one tested implementation of "cap the parallelism" and
 * "retry a flaky call with backoff". The `sleep` is injectable so tests run instantly.
 */

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `jobs` with at most `limit` running at once, preserving input order in the
 * returned results. A job that rejects propagates (callers wrap per-job error
 * handling themselves — e.g. via withRetry + a catch that yields a failure marker).
 */
export async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, jobs.length || 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Call `fn`, retrying up to `retries` extra times on rejection with linear backoff
 * (500ms × attempt). Returns the first success; throws the last error if all attempts
 * fail. `retries = 2` means up to 3 total tries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('operation failed after retries');
}
