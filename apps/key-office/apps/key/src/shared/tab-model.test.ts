import { describe, expect, it } from "vitest";
import {
  reorderWorkspaceTab,
  applyWorkspaceViewDrop,
  activateWorkspaceTab,
  closeWorkspaceView,
  separateWorkspaceTab,
  setWorkspaceSplitRatio,
  singleWorkspaceTab,
  splitWithTab,
  swapWorkspaceSplit,
  layoutViews,
  layoutPanes,
  neighbourPane,
  resetWorkspaceSplits,
  replaceWorkspaceView,
  MAX_PANES,
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
    expect(tab.viewIds.length).toBeLessThanOrEqual(MAX_PANES);
    expect(layoutViews(tab.layout)).toEqual(tab.viewIds);
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
  it("merges a split target's whole arrangement beside the focused pane", () => {
    let state = initial();
    const [a, b, c] = state.tabs;
    state = splitWithTab(state, b.id, c.id);
    state = splitWithTab(state, a.id, b.id, "bottom");
    invariant(state, ["a", "b", "c", "d"]);
    expect(state.tabs[0].layout).toEqual({
      split: "column",
      ratio: 0.5,
      a: { view: "a" },
      b: { split: "row", ratio: 0.5, a: { view: "b" }, b: { view: "c" } },
    });
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
    expect(state.tabs[0].splitRatio).toBe(0.9);
    state = setWorkspaceSplitRatio(state, id, -1);
    expect(state.tabs[0].splitRatio).toBe(0.1);
    expect(setWorkspaceSplitRatio(state, id, 0.5, "../x")).toBe(state);
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

it("moves complete split groups without changing ownership, focus or ratios", () => {
  let state = initial();
  state = splitWithTab(state, state.tabs[0].id, state.tabs[1].id);
  const group = state.tabs[0];
  const moved = reorderWorkspaceTab(state, group.id, 2);
  expect(moved.tabs[2]).toBe(group);
  expect(moved.activeTabId).toBe(state.activeTabId);
  invariant(moved, ["a", "b", "c", "d"]);
  expect(reorderWorkspaceTab(moved, "missing", 0)).toBe(moved);
  expect(reorderWorkspaceTab(moved, group.id, NaN)).toBe(moved);
  expect(reorderWorkspaceTab(moved, group.id, -1).tabs[0]).toBe(group);
});

describe("spatial tab drops", () => {
  it("moves a singleton into the target preserving the target identity", () => {
    const before=initial(),target=before.tabs[1];
    const next=applyWorkspaceViewDrop(before,{kind:"split",viewId:"a",targetTabId:target.id});
    invariant(next,["a","b","c","d"]);
    expect(next.tabs.find(t=>t.id===target.id)?.viewIds).toEqual(["b","a"]);
    expect(next.activeTabId).toBe(target.id);
    expect(before.tabs).toHaveLength(4);
  });
  it("detaches either pane at an insertion position without closing its sibling", () => {
    const before=initial();const split=splitWithTab(before,before.tabs[0].id,before.tabs[1].id);
    for(const viewId of ["a","b"]) {
      const next=applyWorkspaceViewDrop(split,{kind:"detach",viewId,index:0});
      invariant(next,["a","b","c","d"]);
      expect(next.tabs[0].viewIds).toEqual([viewId]);
      expect(next.activeTabId).toBe(next.tabs[0].id);
      expect(next.tabs.find(t=>t.id===split.tabs[0].id)?.viewIds).toEqual([viewId==="a"?"b":"a"]);
    }
  });
  it("swaps a singleton with exactly the chosen split half", () => {
    const before=initial();const split=splitWithTab(before,before.tabs[1].id,before.tabs[2].id);
    const next=applyWorkspaceViewDrop(split,{kind:"swap",viewId:"a",targetViewId:"c"});
    invariant(next,["a","b","c","d"]);
    expect(next.tabs[0].viewIds).toEqual(["c"]);
    expect(next.tabs[1].viewIds).toEqual(["b","a"]);
    expect(next.tabs[1].activeViewId).toBe("a");
  });
  it("moves between groups and exchanges halves inside one group", () => {
    let state=initial();state=splitWithTab(state,state.tabs[0].id,state.tabs[1].id);
    state=applyWorkspaceViewDrop(state,{kind:"split",viewId:"b",targetTabId:state.tabs[1].id});
    invariant(state,["a","b","c","d"]);
    const swapped=applyWorkspaceViewDrop(state,{kind:"swap",viewId:"c",targetViewId:"b"});
    invariant(swapped,["a","b","c","d"]);
    expect(swapped.tabs.find(t=>t.viewIds.includes("b"))?.viewIds).toEqual(["b","c"]);
  });
  it("exchanges panes between two split groups while retaining their geometry", () => {
    const before=initial();
    let state=splitWithTab(before,before.tabs[0].id,before.tabs[1].id);
    state=splitWithTab(state,before.tabs[2].id,before.tabs[3].id);
    state=setWorkspaceSplitRatio(state,before.tabs[0].id,.3);
    state=setWorkspaceSplitRatio(state,before.tabs[2].id,.7);
    const next=applyWorkspaceViewDrop(state,{kind:"swap",viewId:"b",targetViewId:"c"});
    invariant(next,["a","b","c","d"]);
    expect(next.tabs[0].viewIds).toEqual(["a","c"]);
    expect(next.tabs[1].viewIds).toEqual(["b","d"]);
    expect(next.tabs.map(t=>t.splitRatio)).toEqual([.3,.7]);
  });
  it("ignores stale targets and invalid detach requests", () => {
    const state=initial();
    expect(applyWorkspaceViewDrop(state,{kind:"split",viewId:"a",targetTabId:"missing"})).toBe(state);
    expect(applyWorkspaceViewDrop(state,{kind:"swap",viewId:"a",targetViewId:"b"})).toBe(state);
    expect(applyWorkspaceViewDrop(state,{kind:"detach",viewId:"a",index:NaN})).toBe(state);
  });
});

describe("nested pane layouts", () => {
  function three(): WorkspaceTabsState {
    // a | (b over c)
    let state = initial();
    state = applyWorkspaceViewDrop(state, { kind: "split", viewId: "b", targetTabId: state.tabs[0].id, edge: "right" });
    state = applyWorkspaceViewDrop(state, { kind: "split", viewId: "c", targetTabId: state.tabs[0].id, targetViewId: "b", edge: "bottom" });
    return state;
  }
  it("splits any pane on any edge and keeps reading order", () => {
    const state = three();
    invariant(state, ["a", "b", "c", "d"]);
    expect(state.tabs[0].viewIds).toEqual(["a", "b", "c"]);
    expect(state.tabs[0].activeViewId).toBe("c");
    const left = applyWorkspaceViewDrop(state, { kind: "split", viewId: "d", targetTabId: state.tabs[0].id, targetViewId: "c", edge: "left" });
    expect(left.tabs[0].viewIds).toEqual(["a", "b", "d", "c"]);
    invariant(left, ["a", "b", "c", "d"]);
  });
  it("lays out nested panes edge to edge with dividers between them", () => {
    const { panes, dividers } = layoutPanes(three().tabs[0].layout, { x: 240, y: 40, width: 1200, height: 900 });
    const byId = Object.fromEntries(panes.map((p) => [p.viewId, p]));
    expect(byId.a).toEqual({ viewId: "a", x: 240, y: 40, width: 597, height: 900 });
    expect(byId.b).toEqual({ viewId: "b", x: 843, y: 40, width: 597, height: 447 });
    expect(byId.c).toEqual({ viewId: "c", x: 843, y: 493, width: 597, height: 447 });
    expect(dividers.map((d) => [d.path, d.split, d.x, d.y, d.width, d.height])).toEqual([
      ["", "row", 837, 40, 6, 900],
      ["b", "column", 843, 487, 597, 6],
    ]);
  });
  it("resizes, swaps and resets the split holding the focused pane", () => {
    let state = three();
    const id = state.tabs[0].id;
    state = setWorkspaceSplitRatio(state, id, 0.3, "b");
    expect(state.tabs[0].splitRatio).toBe(0.5);
    expect((state.tabs[0].layout as any).b.ratio).toBe(0.3);
    state = swapWorkspaceSplit(state, id);
    expect(state.tabs[0].viewIds).toEqual(["a", "c", "b"]);
    state = resetWorkspaceSplits(state, id);
    expect((state.tabs[0].layout as any).b.ratio).toBe(0.5);
  });
  it("finds neighbours by position", () => {
    const layout = three().tabs[0].layout;
    expect(neighbourPane(layout, "a", "right")).toBe("b");
    expect(neighbourPane(layout, "b", "bottom")).toBe("c");
    expect(neighbourPane(layout, "c", "left")).toBe("a");
    expect(neighbourPane(layout, "a", "left")).toBeUndefined();
  });
  it("closes a nested pane, focusing what took its place", () => {
    let state = three();
    state = closeWorkspaceView(state, "c");
    expect(state.tabs[0].viewIds).toEqual(["a", "b"]);
    expect(state.tabs[0].activeViewId).toBe("b");
    invariant(state, ["a", "b", "d"]);
  });
  it("moves a pane within its own tab, and separates every pane", () => {
    let state = three();
    state = applyWorkspaceViewDrop(state, { kind: "split", viewId: "a", targetTabId: state.tabs[0].id, targetViewId: "c", edge: "right" });
    expect(state.tabs[0].viewIds).toEqual(["b", "c", "a"]);
    invariant(state, ["a", "b", "c", "d"]);
    state = separateWorkspaceTab(state, state.tabs[0].id);
    expect(state.tabs.map((t) => t.viewIds)).toEqual([["b"], ["c"], ["a"], ["d"]]);
  });
  it("replaces a launcher pane in place and caps panes per tab", () => {
    let state = replaceWorkspaceView(three(), "b", "x");
    expect(state.tabs[0].viewIds).toEqual(["a", "x", "c"]);
    expect(state.tabs[0].activeViewId).toBe("x");
    let many: WorkspaceTabsState = { tabs: [singleWorkspaceTab("v0")], activeTabId: null };
    for (let i = 1; i < MAX_PANES + 3; i++) {
      many = { ...many, tabs: [...many.tabs, singleWorkspaceTab(`v${i}`)] };
      many = applyWorkspaceViewDrop(many, { kind: "split", viewId: `v${i}`, targetTabId: many.tabs[0].id });
    }
    expect(many.tabs[0].viewIds.length).toBe(MAX_PANES);
  });
});
