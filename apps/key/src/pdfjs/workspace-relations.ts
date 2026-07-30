export type WorkspacePane = 'primary' | 'secondary';
export type WorkspaceTier = 'full' | 'parsed' | 'preview';
export type WorkspacePlacement =
  | 'primary'
  | 'secondary'
  | 'standby'
  | 'parsed'
  | 'preview';

export interface WorkspaceRelations {
  primaryId: string | null;
  secondaryId: string | null;
  warmSecondaryId: string | null;
  parsedWarmId: string | null;
  splitEnabled: boolean;
  focusedPane: WorkspacePane;
}

export interface DocumentRelation {
  tier: WorkspaceTier;
  placement: WorkspacePlacement;
  visible: boolean;
  keyboardActive: boolean;
  evictionProtected: boolean;
}

/**
 * Single source of truth for tab → view → scheduler relationships.
 *
 * A tab owns document state. A view is only a placement of that tab. Split
 * placements are both visible and eviction-protected; focus changes keyboard
 * routing only. Warm tiers never imply focus or visibility.
 */
export function resolveDocumentRelation(
  documentId: string,
  workspace: WorkspaceRelations,
): DocumentRelation {
  const isPrimary = documentId === workspace.primaryId;
  const isSecondary =
    workspace.splitEnabled && documentId === workspace.secondaryId && !isPrimary;
  const isStandby =
    !workspace.splitEnabled &&
    documentId === workspace.warmSecondaryId &&
    !isPrimary;
  const isParsed =
    documentId === workspace.parsedWarmId &&
    !isPrimary &&
    !isSecondary &&
    !isStandby;

  const placement: WorkspacePlacement = isPrimary
    ? 'primary'
    : isSecondary
      ? 'secondary'
      : isStandby
        ? 'standby'
        : isParsed
          ? 'parsed'
          : 'preview';
  const visible = placement === 'primary' || placement === 'secondary';
  const keyboardActive =
    (placement === 'primary' && workspace.focusedPane === 'primary') ||
    (placement === 'secondary' && workspace.focusedPane === 'secondary');
  return {
    tier:
      placement === 'primary' ||
      placement === 'secondary' ||
      placement === 'standby'
        ? 'full'
        : placement === 'parsed'
          ? 'parsed'
          : 'preview',
    placement,
    visible,
    keyboardActive,
    evictionProtected: visible,
  };
}
