import { describe, it, expect } from "vitest";
import { placeSearchResultBeside, placeSearchResultTab } from "./search-preview-model";
import { singleWorkspaceTab, tabWithLayout, type WorkspaceTabsState, type WorkspaceTab } from "./tab-model";
const tab = (id: string, ...views: string[]): WorkspaceTab =>
  tabWithLayout(
    { id },
    views.length === 1
      ? { view: views[0] }
      : { split: "row", ratio: 0.4, a: { view: views[0] }, b: { view: views[1] } },
  );
const state = (...tabs: WorkspaceTab[]): WorkspaceTabsState => ({
  tabs,
  activeTabId: tabs[0].id,
});
describe("search results open in tabs", () => {
  it("opens a result in a new tab right after its results", () => {
    const s = placeSearchResultTab(
      state(tab("list", "library"), tab("other", "note")),
      "library",
      "pdf",
    );
    expect(s.tabs.map((t) => t.viewIds)).toEqual([["library"], ["pdf"], ["note"]]);
    expect(s.activeTabId).toBe(s.tabs[1].id);
  });
  it("reuses the result tab when stepping to another document", () => {
    const s = placeSearchResultTab(
      state(tab("list", "library"), tab("result", "pdf-a")),
      "library",
      "pdf-b",
      "pdf-a",
    );
    expect(s.tabs.map((t) => t.viewIds)).toEqual([["library"], ["pdf-b"]]);
    expect(s.activeTabId).toBe("result");
  });
  it("never reuses a tab the user split with something else", () => {
    const s = placeSearchResultTab(
      state(tab("list", "library"), tab("work", "pdf-a", "note")),
      "library",
      "pdf-b",
      "pdf-a",
    );
    expect(s.tabs.map((t) => t.viewIds)).toEqual([["library"], ["pdf-b"], ["pdf-a", "note"]]);
  });
  it("brings an already open document forward instead of duplicating it", () => {
    const s = placeSearchResultTab(
      state(tab("list", "library"), tab("work", "note", "pdf")),
      "library",
      "pdf",
    );
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe("work");
    expect(s.tabs[1].activeViewId).toBe("pdf");
  });
});

describe("placeSearchResultBeside", () => {
  const search = { tabs: [singleWorkspaceTab("search")], activeTabId: "" } as WorkspaceTabsState;
  search.activeTabId = search.tabs[0].id;
  it("opens a result beside the search in its tab, and reuses that pane for the next one", () => {
    const first = placeSearchResultBeside(search, "search", "pdf:a");
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0].viewIds).toEqual(["search", "pdf:a"]);
    expect(first.tabs[0].activeViewId).toBe("pdf:a");
    const second = placeSearchResultBeside(first, "search", "pdf:b", "pdf:a");
    expect(second.tabs[0].viewIds).toEqual(["search", "pdf:b"]);
    expect(placeSearchResultBeside(second, "search", "pdf:b", "pdf:b").tabs[0].viewIds).toEqual(["search", "pdf:b"]);
  });
});
