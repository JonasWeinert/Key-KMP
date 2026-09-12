import { describe, expect, it } from "vitest";
import {
  activateWorkspaceTab,
  closeWorkspaceView,
  separateWorkspaceTab,
  setWorkspaceSplitRatio,
  singleWorkspaceTab,
  splitWithTab,
  swapWorkspaceSplit,
  type WorkspaceTabsState,
} from "./tab-model";
function initial(): WorkspaceTabsState {
  const tabs = ["a", "b", "c", "d"].map(singleWorkspaceTab);
  return { tabs, activeTabId: tabs[0].id };
}
function invariant(state: WorkspaceTabsState, expected: string[]) {
  const owned = state.tabs.flatMap((t) => t.viewIds);
  expect(owned.sort()).toEqual([...expected].sort());
  expect(new Set(owned).size).toBe(owned.length);
  for (const tab of state.tabs) {
    expect(tab.viewIds).toContain(tab.activeViewId);
    expect(tab.viewIds.length).toBeGreaterThanOrEqual(1);
    expect(tab.viewIds.length).toBeLessThanOrEqual(2);
    expect(Number.isFinite(tab.splitRatio)).toBe(true);
  }
  if (state.tabs.length)
    expect(state.tabs.some((t) => t.id === state.activeTabId)).toBe(true);
  else expect(state.activeTabId).toBeNull();
}
describe("Electron global view ownership", () => {
  it("preserves every view through split, focus, swap, separate and close", () => {
    let state = initial();
    const [a, b, c] = state.tabs;
    state = splitWithTab(state, a.id, b.id);
    invariant(state, ["a", "b", "c", "d"]);
    state = activateWorkspaceTab(state, c.id);
    state = activateWorkspaceTab(state, a.id, "b");
    expect(state.tabs.find((t) => t.id === a.id)?.activeViewId).toBe("b");
    state = swapWorkspaceSplit(state, a.id);
    invariant(state, ["a", "b", "c", "d"]);
    state = separateWorkspaceTab(state, a.id);
    invariant(state, ["a", "b", "c", "d"]);
    state = closeWorkspaceView(state, "b");
    invariant(state, ["a", "c", "d"]);
    for (const id of ["a", "c", "d"]) state = closeWorkspaceView(state, id);
    invariant(state, []);
  });
  it("rejects merging with a split target instead of dropping its other view", () => {
    let state = initial();
    const [a, b, c] = state.tabs;
    state = splitWithTab(state, b.id, c.id);
    const before = state;
    state = splitWithTab(state, a.id, b.id);
    expect(state).toBe(before);
    invariant(state, ["a", "b", "c", "d"]);
  });
  it("closing one split view retains the other owner and resets geometry", () => {
    let state = initial();
    const [a, b] = state.tabs;
    state = splitWithTab(state, a.id, b.id);
    state = setWorkspaceSplitRatio(state, a.id, 0.7);
    state = closeWorkspaceView(state, "a");
    expect(state.tabs.find((t) => t.id === a.id)).toMatchObject({
      viewIds: ["b"],
      activeViewId: "b",
      splitRatio: 0.5,
    });
    invariant(state, ["b", "c", "d"]);
  });
  it("clamps finite ratios and ignores invalid IPC geometry", () => {
    let state = initial();
    const id = state.tabs[0].id;
    state = setWorkspaceSplitRatio(state, id, 2);
    expect(state.tabs[0].splitRatio).toBe(0.8);
    state = setWorkspaceSplitRatio(state, id, -1);
    expect(state.tabs[0].splitRatio).toBe(0.2);
    for (const value of [NaN, Infinity, -Infinity])
      expect(setWorkspaceSplitRatio(state, id, value)).toBe(state);
  });
  it("retains ownership across repeated regrouping", () => {
    let state = initial();
    for (let i = 0; i < 100; i++) {
      const singles = state.tabs.filter((t) => t.viewIds.length === 1);
      if (singles.length >= 2)
        state = splitWithTab(state, singles[0].id, singles[1].id);
      const split = state.tabs.find((t) => t.viewIds.length === 2);
      if (split) {
        state = swapWorkspaceSplit(state, split.id);
        state = separateWorkspaceTab(state, split.id);
      }
      invariant(state, ["a", "b", "c", "d"]);
    }
  });
});
