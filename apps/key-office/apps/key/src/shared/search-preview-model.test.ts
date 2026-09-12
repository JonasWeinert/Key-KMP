import { describe, it, expect } from "vitest";
import { placeSearchPreview } from "./search-preview-model";
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
describe("search preview ownership", () => {
  it("pairs the list with a fresh preview", () => {
    const s = placeSearchPreview(
      state(tab("list", "library")),
      "library",
      "pdf",
    );
    expect(s.tabs[0].viewIds).toEqual(["library", "pdf"]);
  });
  it("replaces a transient preview without accumulating tabs", () => {
    const s = placeSearchPreview(
      state(tab("list", "library", "pdf-a")),
      "library",
      "pdf-b",
      "pdf-a",
    );
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].viewIds).toEqual(["library", "pdf-b"]);
  });
  it("preserves an ordinary displaced editor", () => {
    const s = placeSearchPreview(
      state(tab("list", "note", "library")),
      "library",
      "pdf",
    );
    expect(s.tabs[0].viewIds).toEqual(["pdf", "library"]);
    expect(s.tabs[1].viewIds).toEqual(["note"]);
    expect(s.tabs[0].splitRatio).toBe(0.4);
  });
  it("moves an existing owned PDF and preserves its former peer", () => {
    const s = placeSearchPreview(
      state(tab("list", "library", "a"), tab("other", "b", "note")),
      "library",
      "b",
      "a",
    );
    expect(s.tabs.map((t) => t.viewIds)).toEqual([["library", "b"], ["note"]]);
    expect(new Set(s.tabs.flatMap((t) => t.viewIds)).size).toBe(3);
  });
  it("keeps placement and current focus for another passage in the same PDF", () => {
    const before = state(tab("list", "pdf", "library"));
    expect(placeSearchPreview(before, "library", "pdf").tabs).toBe(before.tabs);
  });
});
