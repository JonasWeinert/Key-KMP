import { describe, expect, it } from 'vitest';
import { distributeTabWidths, readableTabWidth } from './tab-widths';

const base = {
  minimumTitleCharacters: 15,
  documentIconWidth: 13,
  closeButtonWidth: 18,
  segmentGap: 6,
  horizontalPadding: 12,
  separatorWidth: 1,
};

describe('readable tab widths', () => {
  it('measures only the configured readable filename prefix', () => {
    const measured: string[] = [];
    const width = readableTabWidth(
      ['123456789012345-rest-of-name.pdf'],
      base,
      text => {
        measured.push(text);
        return text.length * 7;
      },
    );

    expect(measured).toEqual(['123456789012345…']);
    expect(width).toBe(179);
  });

  it('preserves a readable prefix for both sides of a split pill', () => {
    const width = readableTabWidth(
      ['left-document.pdf', 'right-document.pdf'],
      { ...base, horizontalPadding: 4 },
      text => text.length * 7,
    );

    expect(width).toBe(319);
  });

  it('fills the rail equally while every tab remains readable', () => {
    expect(distributeTabWidths([140, 150, 160], 600)).toEqual([200, 200, 200]);
  });

  it('holds wide tabs at their floor and shares the remainder', () => {
    expect(distributeTabWidths([140, 260, 140], 600)).toEqual([170, 260, 170]);
  });

  it('overflows at readable floors instead of shrinking further', () => {
    expect(distributeTabWidths([180, 190, 200], 500)).toEqual([180, 190, 200]);
  });
});
