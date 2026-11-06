import { expect, it } from 'vitest';
import { justifiedLayout } from '../src/lib/justifiedLayout';

it('keeps ordered image rows within the viewport with usable metadata widths', () => {
  const ratios = [.56, .75, 1.5, 2, .56, 1, 1.2];
  const layout = justifiedLayout(ratios, 1000);
  expect(layout).toHaveLength(ratios.length);
  let rowWidth = 0;
  for (const item of layout) {
    expect(item.width).toBeGreaterThanOrEqual(220);
    expect(item.height).toBeGreaterThan(0);
    expect(item.height).toBeLessThanOrEqual(260);
    if (rowWidth && rowWidth + 16 + item.width > 1000.001) rowWidth = 0;
    rowWidth += (rowWidth ? 16 : 0) + item.width;
    expect(rowWidth).toBeLessThanOrEqual(1000.001);
  }
  expect(layout[0]!.width).toBeLessThan(layout[2]!.width);
  expect(layout[2]!.width / layout[2]!.height).toBeCloseTo(1.5);
});

it('bounds extreme ratios and keeps a short last row compact', () => {
  const portrait = justifiedLayout([.1], 1000)[0]!;
  expect(portrait.width).toBe(220);
  expect(portrait.height).toBeCloseTo(260);
  for (const width of [180, 272, 320, 375, 768]) {
    for (const item of justifiedLayout([.01, 10, 1, NaN], width)) {
      expect(item.width).toBeLessThanOrEqual(width + .001);
      expect(item.width).toBeGreaterThanOrEqual(Math.min(220, width));
      expect(item.height).toBeGreaterThan(100);
    }
  }
});
