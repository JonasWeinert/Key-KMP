import { describe, expect, it } from 'vitest';
import { resolveDocumentRelation, type WorkspaceRelations } from './workspace-relations';

const base: WorkspaceRelations = {
  primaryId: 'left',
  secondaryId: 'right',
  warmSecondaryId: 'right',
  parsedWarmId: 'parsed',
  splitEnabled: true,
  focusedPane: 'primary',
};

describe('workspace ownership relations', () => {
  it('protects both split views while routing input only to the focused pane', () => {
    expect(resolveDocumentRelation('left', base)).toMatchObject({
      placement: 'primary',
      visible: true,
      keyboardActive: true,
      evictionProtected: true,
    });
    expect(resolveDocumentRelation('right', base)).toMatchObject({
      placement: 'secondary',
      visible: true,
      keyboardActive: false,
      evictionProtected: true,
    });
    expect(
      resolveDocumentRelation('right', { ...base, focusedPane: 'secondary' }),
    ).toMatchObject({
      placement: 'secondary',
      keyboardActive: true,
      evictionProtected: true,
    });
  });

  it('turns the second full reader into a hidden standby outside split', () => {
    expect(
      resolveDocumentRelation('right', { ...base, splitEnabled: false }),
    ).toEqual({
      tier: 'full',
      placement: 'standby',
      visible: false,
      keyboardActive: false,
      evictionProtected: false,
    });
  });

  it('keeps parsed and preview tabs out of live view ownership', () => {
    expect(resolveDocumentRelation('parsed', base)).toMatchObject({
      tier: 'parsed',
      placement: 'parsed',
      visible: false,
      keyboardActive: false,
    });
    expect(resolveDocumentRelation('old', base)).toMatchObject({
      tier: 'preview',
      placement: 'preview',
      visible: false,
      keyboardActive: false,
    });
  });
});
