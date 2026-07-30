import { describe, expect, it } from 'vitest';
import {
  designSystemForProfile,
  visualProfileForRenderer,
} from './app-profile';
import { resolveDesignSystem, utilitiesInTabRow } from './ui/design-system';

const preferences = {
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
};

describe('application visual profiles', () => {
  it.each(['pdfjs', 'pdfjs-workspace'])(
    'uses the Safari workspace contract for %s',
    renderer => {
      const profile = visualProfileForRenderer(renderer);
      const resolved = resolveDesignSystem(
        designSystemForProfile(profile),
        1200,
        preferences,
      );

      expect(profile).toBe('pdfjs-workspace');
      expect(resolved.chrome.row_order).toBe('controls_then_tabs');
      expect(resolved.chrome.tab_bar_placement).toBe('overlay');
      expect(resolved.chrome.show_single_tab).toBe(false);
      expect(resolved.chrome.show_new_tab_button).toBe(false);
      expect(resolved.chrome.tab_bar_tint_opacity).toBe(0.1);
      expect(resolved.chrome.active_tab_opacity).toBe(1);
      expect(resolved.chrome.tab_bar_outline_opacity).toBe(0);
      expect(resolved.chrome.active_tab_outline_opacity).toBe(0);
      expect(utilitiesInTabRow(resolved.chrome)).toBe(false);
      expect(resolved.chrome.tab_leading_inset).toBe(2);
      expect(resolved.chrome.tab_trailing_inset).toBe(2);
      expect(resolved.components.corners.tab.top_left.radius).toBe(
        resolved.components.corners.floating.top_left.radius,
      );
      expect(resolved.chrome.tab_bar_height - resolved.chrome.tab_height).toBe(4);
      expect(resolved.chrome.tab_min_title_characters).toBe(15);
    },
  );

  it('keeps benchmark-only PDF.js modes out of the workspace profile', () => {
    expect(visualProfileForRenderer('pdfjs-isolated-stress')).toBe('legacy-lab');
  });
});
