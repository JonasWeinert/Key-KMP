import { describe, expect, it } from 'vitest';
import type { NativeTextPage } from '../engines/types';
import { characterIndexAtPoint } from './text-overlays';

const page: NativeTextPage = {
  page: 0,
  text: 'Wide',
  characters: [
    { value: 'W', bounds: { left: 0.1, top: 0.2, right: 0.18, bottom: 0.24 } },
    { value: 'i', bounds: { left: 0.18, top: 0.2, right: 0.2, bottom: 0.24 } },
    { value: 'd', bounds: { left: 0.2, top: 0.2, right: 0.24, bottom: 0.24 } },
    { value: 'e', bounds: { left: 0.24, top: 0.2, right: 0.28, bottom: 0.24 } },
  ],
};

describe('backend character hit testing', () => {
  it('uses the PDF character boxes rather than assumed browser glyph widths', () => {
    expect(characterIndexAtPoint(page, 0.19, 0.22, 1_000, 1_400)).toBe(1);
    expect(characterIndexAtPoint(page, 0.215, 0.22, 1_000, 1_400)).toBe(2);
  });

  it('chooses the closest character at a boundary or small text gap', () => {
    expect(characterIndexAtPoint(page, 0.199, 0.22, 1_000, 1_400)).toBe(1);
    expect(characterIndexAtPoint(page, 0.201, 0.22, 1_000, 1_400)).toBe(2);
  });

  it('does not snap a pointer far outside the text to an unrelated character', () => {
    expect(characterIndexAtPoint(page, 0.8, 0.8, 1_000, 1_400)).toBeNull();
  });
});
