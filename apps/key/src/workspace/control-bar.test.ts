import { describe, expect, it } from 'vitest';
import {
  controlBarCardRange,
  controlBarItem,
  solveControlBarLayout,
  type ControlBarItem,
} from './control-bar';

// Mirrors the cases in crates/key-ui-gpui/src/control_bar_layout.rs so the two
// hosts collapse chrome identically.
function button(id: string, priority: number): ControlBarItem {
  return controlBarItem(id, 'trailing', 'button', {
    label: id,
    widths: [100, 64, 32],
    priority,
  });
}

describe('solveControlBarLayout', () => {
  it('collapses lower-priority items first', () => {
    const layout = solveControlBarLayout([button('low', 10), button('high', 90)], 168, 4);
    expect(layout[0].mode).toBe('compact');
    expect(layout[1].mode).toBe('full');
  });

  it('keeps an expanded input at its requested width', () => {
    const input = controlBarItem(
      'search',
      'trailing',
      'textInput',
      { label: 'Search', widths: [280, 180, 32], priority: 1 },
      { expanded: true },
    );
    const layout = solveControlBarLayout(
      [input, button('comments', 80), button('title', 2)],
      360,
      4,
    );
    expect(layout[0].mode).toBe('full');
    expect(layout[0].width).toBe(280);
    expect(layout[1].mode).toBe('icon');
  });

  it('compacts an expanded input only after every other control', () => {
    const input = controlBarItem(
      'search',
      'trailing',
      'textInput',
      { label: 'Search', widths: [280, 180, 96], priority: 1 },
      { expanded: true },
    );
    const layout = solveControlBarLayout([input, button('comments', 80)], 220, 4);
    expect(layout[0].mode).toBe('compact');
    expect(layout[1].mode).toBe('icon');
  });

  it('gives hidden items no width', () => {
    const hidden = controlBarItem(
      'hidden',
      'trailing',
      'button',
      { label: 'hidden', widths: [100, 64, 32], priority: 1 },
      { visible: false },
    );
    expect(solveControlBarLayout([hidden], 0, 4)[0].width).toBe(0);
  });

  it('hands a max-width item the space intrinsic controls leave behind', () => {
    const location = controlBarItem('location', 'leading', 'display', {
      label: 'location',
      widths: [100, 64, 32],
      priority: 1,
      width: 'max',
    });
    const layout = solveControlBarLayout(
      [button('split', 90), location, button('search', 90)],
      300,
      4,
    );
    // 300 - 2 gaps (8) = 292 budget; two intrinsic buttons at full = 200.
    expect(layout[1].width).toBeCloseTo(92, 5);
    expect(layout[0].mode).toBe('full');
    expect(layout[2].mode).toBe('full');
  });

  it('never returns a negative budget when the window is narrower than the gaps', () => {
    const layout = solveControlBarLayout([button('a', 1), button('b', 2)], 2, 40);
    expect(layout.every(item => item.width >= 0)).toBe(true);
    expect(layout.every(item => item.mode === 'icon')).toBe(true);
  });
});

describe('controlBarCardRange', () => {
  it('returns every card when the total is within the cap', () => {
    expect(controlBarCardRange(5, null, 256)).toEqual([0, 5]);
  });

  it('keeps the active card inside a bounded window', () => {
    const [start, end] = controlBarCardRange(20_000, 10_000, 256);
    expect(end - start).toBe(256);
    expect(start <= 10_000 && 10_000 < end).toBe(true);
  });

  it('clamps the window to the end of the list', () => {
    const [start, end] = controlBarCardRange(20_000, 19_999, 256);
    expect(end).toBe(20_000);
    expect(start <= 19_999 && 19_999 < end).toBe(true);
  });
});
