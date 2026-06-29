import { describe, it, expect } from 'vitest';
import { detectImageRegions } from './regenerate';
import type { Sam3Segment } from './sam3';
import type { OcrLine } from './heuristics';

function seg(id: string, label: string, x: number, y: number, w: number, h: number): Sam3Segment {
  return { id, label, bbox: { x, y, width: w, height: h } };
}
function ocr(x: number, y: number, w: number, h: number): OcrLine {
  return { text: 't', confidence: 1, bbox: { x, y, width: w, height: h } };
}

describe('detectImageRegions', () => {
  it('keeps image segments and drops those overlapping an OCR text box', () => {
    const segments = [
      seg('logo1', 'logo', 95, 280, 121, 124), // icon, no text overlap -> keep
      seg('txt', 'segment', 30, 84, 1090, 84), // sits under the title OCR region -> drop
      seg('bld', 'building', 1523, 701, 45, 88), // skyline, no overlap -> keep
    ];
    const ocrLines = [ocr(28, 84, 1094, 84)]; // title region
    const kept = detectImageRegions(segments, ocrLines);
    expect(kept.map((s) => s.id).sort()).toEqual(['bld', 'logo1']);
  });

  it('keeps everything when there are no OCR text regions', () => {
    const segments = [seg('a', 'logo', 0, 0, 50, 50), seg('b', 'building', 100, 100, 30, 60)];
    expect(detectImageRegions(segments, [])).toHaveLength(2);
  });

  it('respects the overlap threshold (partial overlap below 0.4 is kept)', () => {
    const segments = [seg('partial', 'logo', 0, 0, 100, 100)];
    // OCR box covers only the top 20% of the segment -> 0.2 overlap < 0.4 -> keep
    const kept = detectImageRegions(segments, [ocr(0, 0, 100, 20)]);
    expect(kept).toHaveLength(1);
  });

  it('drops a segment mostly covered by text (overlap above 0.4)', () => {
    const segments = [seg('mostly', 'logo', 0, 0, 100, 100)];
    const kept = detectImageRegions(segments, [ocr(0, 0, 100, 60)]); // 0.6 overlap -> drop
    expect(kept).toHaveLength(0);
  });
});
