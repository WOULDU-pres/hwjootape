/**
 * Outline parsing — turn a markdown-ish outline into a per-slide structure.
 *
 * Slides are separated by a `---` line. Within a slide, the first heading
 * (`#`/`##`/...) or the first non-bullet line is the title; `-`/`*`/`•` lines
 * are bullets. Blank lines are ignored. This is the user-facing entry format
 * (D1: the user supplies title + bullets per slide).
 */

export interface SlideOutline {
  title: string;
  bullets: string[];
}

const SLIDE_SEPARATOR = /^\s*---\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*\S)\s*$/;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;

function parseSlideBlock(block: string): SlideOutline | null {
  const lines = block.split('\n');
  let title = '';
  const bullets: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const heading = line.match(HEADING);
    if (heading) {
      if (!title) title = heading[1];
      else bullets.push(heading[1]);
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    // plain line: first becomes title, rest become bullets
    if (!title) title = line.trim();
    else bullets.push(line.trim());
  }

  if (!title && bullets.length === 0) return null;
  return { title, bullets };
}

export function parseOutline(markdown: string): SlideOutline[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of markdown.split('\n')) {
    if (SLIDE_SEPARATOR.test(line)) {
      blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join('\n'));

  return blocks
    .map(parseSlideBlock)
    .filter((s): s is SlideOutline => s !== null);
}

/** Compose the god-tibo draft prompt for one slide. Drives 16:9 via prompt text
 *  (the `size` param is ignored by the backend) and tells the model the text is
 *  placeholder-only, since the final text comes from the outline. */
export function buildDraftPrompt(outline: SlideOutline, styleHint?: string): string {
  const bullets = outline.bullets.length
    ? `\nKey points:\n${outline.bullets.map((b) => `- ${b}`).join('\n')}`
    : '';
  const style = styleHint?.trim()
    ? `\nStyle: ${styleHint.trim()}`
    : '\nStyle: clean, modern corporate presentation design.';
  return [
    'A 16:9 widescreen landscape presentation slide (wide, much wider than tall).',
    `Title: ${outline.title}`,
    bullets,
    style,
    'Leave clear regions for text. Rendered text may be placeholder; it will be replaced.',
  ].join('') ;
}
