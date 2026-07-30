import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOVER_CARD_EXIT_DELAY_MS,
  HoverCardBridge,
  anchoredFloatingCardPosition,
} from './floating-card';

describe('anchored floating cards', () => {
  afterEach(() => vi.useRealTimers());

  it('places a card below the text anchor when space is available', () => {
    expect(
      anchoredFloatingCardPosition(
        { left: 240, right: 320, top: 100, bottom: 120 },
        { width: 1000, height: 800 },
        { width: 450, height: 460 },
      ),
    ).toEqual({ left: 222, top: 130 });
  });

  it('moves above the anchor and clamps to viewport edges', () => {
    expect(
      anchoredFloatingCardPosition(
        { left: 980, right: 1000, top: 700, bottom: 720 },
        { width: 1000, height: 800 },
        { width: 450, height: 460 },
      ),
    ).toEqual({ left: 538, top: 230 });
  });

  it('provides enough bridge time to move from text into the card', () => {
    expect(HOVER_CARD_EXIT_DELAY_MS).toBeGreaterThanOrEqual(150);
  });

  it('does not dismiss while the pointer crosses into the card', () => {
    vi.useFakeTimers();
    const bridge = new HoverCardBridge();
    const onExit = vi.fn();
    bridge.schedule(onExit);
    vi.advanceTimersByTime(HOVER_CARD_EXIT_DELAY_MS - 20);
    bridge.cancel();
    vi.advanceTimersByTime(30);
    expect(onExit).not.toHaveBeenCalled();

    bridge.schedule(onExit);
    vi.advanceTimersByTime(HOVER_CARD_EXIT_DELAY_MS);
    expect(onExit).toHaveBeenCalledOnce();
  });
});
