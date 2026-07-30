import { describe, expect, it, vi } from 'vitest';
import {
  activateWorkspaceTab,
  closeWorkspaceView,
  separateWorkspaceTab,
  singleWorkspaceTab,
  splitWithTab,
  type WorkspaceTabsState,
} from './workspace-tabs';

vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `tab-${Math.random()}`) });

function state(): WorkspaceTabsState {
  const first = singleWorkspaceTab('paper-a');
  const second = singleWorkspaceTab('paper-b');
  const third = singleWorkspaceTab('paper-c');
  return { tabs: [first, second, third], activeTabId: first.id };
}

describe('workspace split tab ownership', () => {
  it('keeps a split group intact while another top-level tab is active', () => {
    let workspace = state();
    const [first, second, third] = workspace.tabs;
    workspace = splitWithTab(workspace, first.id, second.id);
    const split = workspace.tabs.find(tab => tab.id === first.id)!;
    expect(split.viewIds).toEqual(['paper-a', 'paper-b']);

    workspace = activateWorkspaceTab(workspace, third.id);
    expect(workspace.activeTabId).toBe(third.id);
    expect(workspace.tabs.find(tab => tab.id === first.id)?.viewIds).toEqual([
      'paper-a',
      'paper-b',
    ]);

    workspace = activateWorkspaceTab(workspace, first.id, 'paper-b');
    expect(workspace.tabs.find(tab => tab.id === first.id)?.activeViewId).toBe('paper-b');
    expect(workspace.tabs.find(tab => tab.id === first.id)?.viewIds).toEqual([
      'paper-a',
      'paper-b',
    ]);
  });

  it('separates only through an explicit split action', () => {
    let workspace = state();
    const [first, second] = workspace.tabs;
    workspace = splitWithTab(workspace, first.id, second.id);
    workspace = separateWorkspaceTab(workspace, first.id);
    expect(workspace.tabs.map(tab => tab.viewIds)).toEqual([
      ['paper-a'],
      ['paper-b'],
      ['paper-c'],
    ]);
  });

  it('closing one split child preserves the other as the same workspace tab', () => {
    let workspace = state();
    const [first, second] = workspace.tabs;
    workspace = splitWithTab(workspace, first.id, second.id);
    workspace = closeWorkspaceView(workspace, 'paper-a');
    expect(workspace.tabs.find(tab => tab.id === first.id)).toMatchObject({
      viewIds: ['paper-b'],
      activeViewId: 'paper-b',
    });
  });
});
