/**
 * regen-ops — Phase 6 (ADR-0002): regenerate a single element on demand with a user
 * requirement. Text elements are edited directly in the UI; this handles image
 * elements (objects) and background plates by asking god-tibo for a fresh image,
 * passing the element's current image as a reference so the result stays in-family.
 *
 * Generation + backoff are injected (testable, no live calls). Slide-level regenerate
 * is composed at the route from the existing full-deck + decompose orchestrators.
 */
import { withRetry } from './gen-pool';

export interface RegenerateElementDeps {
  generateImage: (options: { prompt: string; images?: string[] }) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface RegenerateElementInput {
  /** The element's current image as a data URL, used as a style reference (optional). */
  currentImageDataUrl?: string;
  /** The user's free-text requirement for the regeneration. */
  requirement: string;
  retries?: number;
}

export function buildElementRegenPrompt(requirement: string): string {
  return [
    'Regenerate this single graphic / illustration element for a presentation slide.',
    `Requirement: ${requirement.trim()}`,
    'Center it as a clean standalone element on a plain/transparent background.',
    'STRICT: no text, no letters, no numbers, no watermarks.',
  ].join('\n');
}

/** Regenerate one element's image; returns a PNG data URL (caller persists it). */
export async function regenerateElementImage(
  input: RegenerateElementInput,
  deps: RegenerateElementDeps,
): Promise<string> {
  const images = input.currentImageDataUrl ? [input.currentImageDataUrl] : undefined;
  return withRetry(
    () => deps.generateImage({ prompt: buildElementRegenPrompt(input.requirement), images }),
    input.retries ?? 2,
    deps.sleep,
  );
}
