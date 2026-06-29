import { test, expect } from '@playwright/test';

/**
 * Deck version-pick → edit flow (ADR-0002). All god-tibo/sidecar routes are mocked, so
 * this exercises the UI seam — progressive version grid, selection, decompose→editing,
 * and element drag — deterministically, with zero live backend calls.
 */

// 1x1 transparent PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const PRESETS = [
  { id: 'minimal', name: '미니멀' },
  { id: 'bold-corporate', name: '볼드 코퍼릿' },
];

test.beforeEach(async ({ page }) => {
  await page.route('**/api/slides/style-presets', (route) =>
    route.fulfill({ json: { presets: PRESETS, defaultCount: 2 } }),
  );

  // Any asset request returns a real PNG so <img> loads (no broken-image fallback).
  await page.route('**/api/projects/assets/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PNG_1x1 }),
  );

  await page.route('**/api/slides/versions**', async (route) => {
    const body = route.request().postDataJSON() as { presetIds?: string[] };
    const presetId = body.presetIds?.[0] ?? 'minimal';
    const presetName = PRESETS.find((p) => p.id === presetId)?.name ?? presetId;
    await route.fulfill({
      json: {
        versions: [
          {
            presetId,
            presetName,
            samples: [0, 1, 2].map((slideIndex) => ({ slideIndex, assetId: `${presetId}-s${slideIndex}` })),
          },
        ],
        generated: 3,
        failed: 0,
      },
    });
  });

  await page.route('**/api/slides/full-deck**', (route) =>
    route.fulfill({
      json: { slides: [0, 1, 2].map((slideIndex) => ({ slideIndex, assetId: `final-s${slideIndex}` })), generated: 3, failed: 0 },
    }),
  );

  await page.route('**/api/slides/decompose-deck**', (route) =>
    route.fulfill({
      json: {
        deck: [
          {
            slideId: 's-0',
            background: { assetId: 'bg-0' },
            elements: [
              { id: 'title', type: 'text', role: 'title', text: '진짜 제목', nbbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 }, z: 10 },
              { id: 'pic', type: 'image', nbbox: { x: 0.6, y: 0.5, w: 0.3, h: 0.3 }, assetId: 'obj-0', z: 5 },
            ],
          },
        ],
        failures: [],
      },
    }),
  );
});

test('pick a version, build the deck, and see editable decomposed slides', async ({ page }) => {
  await page.goto('/deck?project=test');

  // Setup → generate versions.
  await page.getByRole('button', { name: /디자인 버전 생성/ }).click();

  // Progressive version grid shows both preset names.
  await expect(page.getByText('미니멀')).toBeVisible();
  await expect(page.getByText('볼드 코퍼릿')).toBeVisible();

  // Select a version, then build.
  await page.getByText('볼드 코퍼릿').click();
  await page.getByRole('button', { name: /이 디자인으로 덱 만들기/ }).click();

  // Editing stage: the decomposed real outline text is shown.
  await expect(page.getByText('진짜 제목')).toBeVisible();
});

test('dragging a text element moves it (geometry edit round-trips)', async ({ page }) => {
  await page.goto('/deck?project=test');
  await page.getByRole('button', { name: /디자인 버전 생성/ }).click();
  await page.getByText('미니멀').click();
  await page.getByRole('button', { name: /이 디자인으로 덱 만들기/ }).click();

  const title = page.getByText('진짜 제목');
  await expect(title).toBeVisible();
  // The element's positioned wrapper is its parent; capture left% before/after a drag.
  const wrapper = title.locator('xpath=ancestor::div[contains(@style,"left")][1]');
  const leftPct = () => wrapper.evaluate((el) => parseFloat((el as HTMLElement).style.left));
  const topPct = () => wrapper.evaluate((el) => parseFloat((el as HTMLElement).style.top));
  const beforeLeft = await leftPct();
  const beforeTop = await topPct();

  const box = await title.boundingBox();
  if (!box) throw new Error('no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  // A rightward+down drag must INCREASE both left% and top% (not just change them).
  expect(await leftPct()).toBeGreaterThan(beforeLeft);
  expect(await topPct()).toBeGreaterThan(beforeTop);
});
