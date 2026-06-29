import { describe, it, expect, beforeEach } from 'vitest';
import { useSlideStore } from './useSlideStore';
import type { SlideSpec } from '@/lib/slides/spec';

function seed(): SlideSpec {
  return {
    slideId: 's-0',
    background: null,
    elements: [
      { id: 'title', type: 'text', role: 'title', text: '제목', nbbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, z: 10 },
      { id: 'pic', type: 'image', nbbox: { x: 0.6, y: 0.4, w: 0.3, h: 0.3 }, assetId: 'a1', z: 5 },
    ],
  };
}

beforeEach(() => {
  useSlideStore.setState({ deck: [seed()], layout: null });
});

const deck0 = () => useSlideStore.getState().deck[0];

describe('updateElementBox', () => {
  it('moves/resizes an element by setting its nbbox immutably', () => {
    const before = deck0();
    useSlideStore.getState().updateElementBox(0, 1, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    const after = deck0();
    expect(after.elements[1].nbbox).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    expect(after).not.toBe(before); // new reference (immutability)
    expect(after.elements[0]).toBe(before.elements[0]); // untouched element shares reference
  });

  it('is a no-op for an out-of-range slide or element', () => {
    const before = deck0();
    useSlideStore.getState().updateElementBox(9, 0, { x: 0, y: 0, w: 1, h: 1 });
    useSlideStore.getState().updateElementBox(0, 9, { x: 0, y: 0, w: 1, h: 1 });
    expect(deck0()).toBe(before);
  });
});

describe('z-order', () => {
  it('bringElementForward puts an element above all siblings', () => {
    useSlideStore.getState().bringElementForward(0, 1); // pic (z5) above title (z10)
    expect(deck0().elements[1].z).toBeGreaterThan(deck0().elements[0].z ?? 0);
  });

  it('sendElementBackward puts an element below all siblings', () => {
    useSlideStore.getState().sendElementBackward(0, 0); // title (z10) below pic (z5)
    expect(deck0().elements[0].z).toBeLessThan(deck0().elements[1].z ?? 0);
  });
});

describe('deleteElement', () => {
  it('removes the element at the given index', () => {
    useSlideStore.getState().deleteElement(0, 1);
    const after = deck0();
    expect(after.elements).toHaveLength(1);
    expect(after.elements[0].id).toBe('title');
  });

  it('is a no-op out of range', () => {
    const before = deck0();
    useSlideStore.getState().deleteElement(0, 9);
    expect(deck0()).toBe(before);
  });
});

describe('updateElementAsset', () => {
  it('swaps an image element assetId (used after element regenerate)', () => {
    useSlideStore.getState().updateElementAsset(0, 1, 'a2');
    const el = deck0().elements[1];
    expect(el.type === 'image' && el.assetId).toBe('a2');
  });

  it('is a no-op for a text element or out of range', () => {
    const before = deck0();
    useSlideStore.getState().updateElementAsset(0, 0, 'nope'); // text element
    expect(deck0()).toBe(before);
  });
});

describe('setBackgroundAsset', () => {
  it('swaps the slide background plate assetId', () => {
    useSlideStore.getState().setBackgroundAsset(0, 'bg-new');
    expect(deck0().background?.assetId).toBe('bg-new');
  });

  it('is a no-op out of range', () => {
    const before = deck0();
    useSlideStore.getState().setBackgroundAsset(9, 'bg-new');
    expect(deck0()).toBe(before);
  });
});

describe('setSlide', () => {
  it('replaces one slide spec (used after whole-slide regenerate)', () => {
    const replacement: SlideSpec = { slideId: 's-0', background: null, elements: [] };
    useSlideStore.getState().setSlide(0, replacement);
    expect(deck0()).toBe(replacement);
  });

  it('is a no-op out of range', () => {
    const before = deck0();
    useSlideStore.getState().setSlide(9, { slideId: 'x', background: null, elements: [] });
    expect(deck0()).toBe(before);
  });
});
