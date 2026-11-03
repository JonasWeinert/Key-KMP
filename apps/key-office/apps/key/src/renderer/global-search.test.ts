import { describe, expect, it } from "vitest";
import { EMPTY_FIND, itemFilter, narrow, sidebarFilter, type FindState } from "./global-search";
import type { Found } from "./unified-search";

const tag = { field: "tag", op: "is" as const, value: "covid", label: "covid" };

describe("sidebar clicks in a search tab", () => {
  it("narrow to a collection, then to the library's sources", () => {
    const inCollection = sidebarFilter({ ...EMPTY_FIND, filters: [tag] }, { kind: "sources", collectionId: "c1", title: "Reading" })!;
    expect(inCollection.kinds).toEqual(["source"]);
    expect(inCollection.filters.map((f) => [f.field, f.value])).toEqual([
      ["tag", "covid"],
      ["collection", "c1"],
    ]);
    const library = sidebarFilter(inCollection, { kind: "sources" })!;
    expect(library.kinds).toEqual(["source"]);
    expect(library.filters).toEqual([tag]);
  });

  it("leave the search alone when the click changes nothing, so it opens instead", () => {
    const state: FindState = { text: "x", kinds: ["source"], filters: [] };
    expect(sidebarFilter(state, { kind: "sources" })).toBeUndefined();
    const note = sidebarFilter(state, { kind: "note", id: "n1", title: "Alpha" })!;
    expect(note.filters).toEqual([itemFilter("note", "n1", "Alpha")]);
    expect(note.kinds).toEqual([]);
    expect(note.text).toBe("x");
    expect(sidebarFilter(note, { kind: "note", id: "n1", title: "Alpha" })).toBeUndefined();
  });

  it("show highlights or pages only", () => {
    expect(sidebarFilter(EMPTY_FIND, { kind: "highlights" })!.kinds).toEqual(["highlight"]);
    expect(sidebarFilter({ ...EMPTY_FIND, filters: [tag] }, { kind: "records" })).toEqual({ ...EMPTY_FIND, kinds: ["record"], filters: [] });
  });
});

describe("narrowing results", () => {
  const found = (kind: Found["kind"], id: string, group: Found["group"], anchor?: string): Found => ({ kind, id, title: id, group, anchor });
  const all = {
    titles: [found("source", "s1", "titles"), found("note", "n1", "titles"), found("source", "s1", "titles", "highlight:h1")],
    text: [found("note", "n1", "text"), found("canvas", "c1", "text")],
    meaning: [found("record", "r1", "meaning")],
    semantic: true,
  };

  it("counts every kind and keeps only the chosen ones", () => {
    const result = narrow(all, { ...EMPTY_FIND, kinds: ["note"] }, false);
    expect(result.counts).toEqual({ source: 1, note: 2, record: 1, canvas: 1, highlight: 1 });
    expect(result.all).toBe(6);
    expect(result.found.titles.map((f) => f.id)).toEqual(["n1"]);
    expect(result.found.text.map((f) => f.id)).toEqual(["n1"]);
    expect(result.found.meaning).toEqual([]);
  });

  it("keeps one sidebar item, and lists it even when only its text matched", () => {
    const result = narrow({ ...all, titles: [] }, { ...EMPTY_FIND, filters: [itemFilter("note", "n1", "Alpha")] }, false);
    expect(result.found.titles.map((f) => [f.kind, f.id])).toEqual([["note", "n1"]]);
    expect(result.found.text.map((f) => f.id)).toEqual(["n1"]);
    expect(result.counts.note).toBe(2);
    expect(result.counts.canvas).toBe(0);
  });
});
