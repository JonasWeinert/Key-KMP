export interface FloatingCardAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FloatingCardPosition {
  left: number;
  top: number;
}

export const HOVER_CARD_EXIT_DELAY_MS = 180;

export class HoverCardBridge {
  private exitTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  cancel() {
    if (this.exitTimer === null) return;
    globalThis.clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  schedule(onExit: () => void) {
    this.cancel();
    this.exitTimer = globalThis.setTimeout(() => {
      this.exitTimer = null;
      onExit();
    }, HOVER_CARD_EXIT_DELAY_MS);
  }

  dispose() {
    this.cancel();
  }
}

export function anchoredFloatingCardPosition(
  anchor: FloatingCardAnchor,
  viewport: { width: number; height: number },
  card: { width: number; height: number },
  gap = 10,
  margin = 12,
): FloatingCardPosition {
  const maximumLeft = Math.max(margin, viewport.width - card.width - margin);
  const left = Math.min(maximumLeft, Math.max(margin, anchor.left - 18));
  const below = anchor.bottom + gap;
  const above = anchor.top - card.height - gap;
  const maximumTop = Math.max(margin, viewport.height - card.height - margin);
  const top =
    below + card.height <= viewport.height - margin
      ? below
      : Math.min(maximumTop, Math.max(margin, above));
  return { left, top };
}
