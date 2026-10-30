import { describe, it, expect } from "vitest";
import { placeSearchResultTab } from "./search-preview-model";
import type { WorkspaceTabsState, WorkspaceTab } from "./tab-model";
const tab = (id: string, ...views: string[]): WorkspaceTab => ({
  id,
  viewIds: views as [string] | [string, string],
  activeViewId: views[0],
  splitRatio: 0.4,
});
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
