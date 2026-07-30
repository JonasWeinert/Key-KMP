import { describe, expect, it } from 'vitest';
import squareSource from '../../../../assets/ui/variations/square-opaque.json';
import {
  classifyWidth,
  designSystemCss,
  keyGlass,
  mergeDesignSystem,
  resolveDesignSystem,
  utilitiesInTabRow,
  validateDesignSystem,
  type DesignSystemConfig,
} from './design-system';

const defaults = {
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
};

describe('renderer-independent design system', () => {
  it('uses the GPUI source of truth and resolves responsive chrome', () => {
    expect(() => validateDesignSystem(keyGlass)).not.toThrow();
    expect(classifyWidth(keyGlass, 700)).toBe('compact');
    expect(classifyWidth(keyGlass, 900)).toBe('regular');
    expect(classifyWidth(keyGlass, 1200)).toBe('comfortable');
    const compact = resolveDesignSystem(keyGlass, 700, defaults);
    expect(compact.chrome.tab_width).toBe(190);
    expect(designSystemCss(compact)['--key-tab-width']).toBe('190px');
  });

  it('cascades root accessibility and feature policy before rendering', () => {
    const square = mergeDesignSystem(keyGlass, squareSource);
    const resolved = resolveDesignSystem(
      square as DesignSystemConfig,
      1200,
      {
        reduceMotion: true,
        reduceTransparency: true,
        increaseContrast: true,
      },
    );
    const css = designSystemCss(resolved);
    expect(resolved.motionAllowed).toBe(false);
    expect(resolved.translucencyAllowed).toBe(false);
    expect(resolved.materials.floating.opacity).toBe(1);
    expect(resolved.materials.floating.shadow_opacity).toBe(0);
    expect(css['--key-radius-floating']).toBe('0px');
    expect(css['--key-motion-medium']).toBe('0ms');
  });

  it('places workspace utilities in whichever chrome row is topmost', () => {
    const tabsFirst = keyGlass.workspace.chrome.regular;
    expect(utilitiesInTabRow(tabsFirst)).toBe(true);
    expect(
      utilitiesInTabRow({
        ...tabsFirst,
        row_order: 'controls_then_tabs',
      }),
    ).toBe(false);
  });

  it('rejects unknown schema versions and invalid responsive bounds', () => {
    expect(() =>
      validateDesignSystem({ ...keyGlass, schema_version: 2 }),
    ).toThrow(/unsupported/);
    expect(() =>
      validateDesignSystem({
        ...keyGlass,
        responsive: {
          compact_max_width: 1200,
          comfortable_min_width: 800,
        },
      }),
    ).toThrow(/compact width/);
  });
});
