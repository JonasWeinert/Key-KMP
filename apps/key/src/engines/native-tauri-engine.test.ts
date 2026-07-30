import { describe, expect, it } from 'vitest';
import { bgraToImageData, contextFromPreview } from './native-tauri-engine';

describe('native engine conversion boundary', () => {
  it('converts PDFium BGRA pixels into browser RGBA pixels', () => {
    const output = bgraToImageData(
      new Uint8Array([
        10, 20, 30, 255,
        0, 64, 128, 128,
      ]),
      2,
      1,
    );
    expect([...output.data]).toEqual([
      30, 20, 10, 255,
      255, 128, 0, 128,
    ]);
    expect(output.width).toBe(2);
    expect(output.height).toBe(1);
  });

  it('preserves case in search previews while locating case-insensitively', () => {
    expect(contextFromPreview('Before KEY after', 'key')).toEqual({
      before: 'Before ',
      match: 'KEY',
      after: ' after',
      truncatedLeft: true,
      truncatedRight: true,
    });
  });
});
