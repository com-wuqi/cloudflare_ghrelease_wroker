import { describe, expect, it } from 'vitest';

import { clampInt } from '../src/lib/config';

describe('clampInt', () => {
  it('falls back for missing or invalid input', () => {
    expect(clampInt(undefined, 7, 1, 30)).toBe(7);
    expect(clampInt('', 7, 1, 30)).toBe(7);
    expect(clampInt('not-a-number', 7, 1, 30)).toBe(7);
    expect(clampInt(Number.NaN, 7, 1, 30)).toBe(7);
  });

  it('clamps to the configured range', () => {
    expect(clampInt('0', 7, 1, 30)).toBe(1);
    expect(clampInt('999', 7, 1, 30)).toBe(30);
    expect(clampInt(0, 7, 1, 30)).toBe(1);
    expect(clampInt(999, 7, 1, 30)).toBe(30);
  });

  it('truncates fractional values', () => {
    expect(clampInt('12.9', 7, 1, 30)).toBe(12);
    expect(clampInt(12.9, 7, 1, 30)).toBe(12);
  });
});
