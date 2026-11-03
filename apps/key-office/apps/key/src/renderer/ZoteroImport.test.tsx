// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ZoteroImport } from "./ZoteroImport";
import type { ZoteroPreview } from "./library-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The design system is compiled with the classic JSX runtime under vitest.
(globalThis as { React?: typeof React }).React = React;

const PREVIEW: ZoteroPreview = {
  dataDir: "/Users/someone/Zotero",
  collections: [
    { key: "THESIS", name: "Thesis", parentKey: null, items: 2, total: 5 },
    { key: "CHAPTER", name: "Chapter 2", parentKey: "THESIS", items: 3, total: 3 },
    { key: "OTHER", name: "Other", parentKey: null, items: 4, total: 4 },
  ],
  library: { items: 1200, files: 300, notes: 80, annotations: 12 },
  selected: { items: 1200, files: 300, notes: 80, annotations: 12 },
  unfiled: 7,
};

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

async function render(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ZoteroImport invoke={invoke as never} workspaceId="w1" onClose={() => {}} onDone={() => {}} />);
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return host;
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(() => new Promise((r) => setTimeout(r, 200)));
};

describe("Zotero import dialogue", () => {
  it("previews the whole library, then counts the chosen collections and options", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command !== "store_zotero_preview") throw Error(command);
      const keys = args?.collectionKeys as string[] | undefined;
      return keys ? { ...PREVIEW, selected: { items: keys.length * 2, files: args?.attachments ? 1 : 0, notes: 0, annotations: 0 } } : PREVIEW;
    });
    const view = await render(invoke);
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("1,200 items · 300 files · 80 notes · 12 annotations");
    expect(view.textContent).toContain("~/Zotero");

    await click([...view.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.includes("Chosen collections")));
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("Choose at least one collection");
    expect((view.querySelector(".key-property-primary") as HTMLButtonElement).disabled).toBe(true);
    // Collapsed: only the top-level collections, with their totals.
    const rows = () => [...view.querySelectorAll('[role="treeitem"]')].map((r) => r.textContent);
    expect(rows()).toEqual(["Other4", "Thesis5"]);

    // Choosing a collection chooses the one inside it.
    await click(view.querySelector('input[aria-label="Thesis"]'));
    expect(invoke).toHaveBeenLastCalledWith(
      "store_zotero_preview",
      expect.objectContaining({ collectionKeys: ["THESIS", "CHAPTER"], attachments: true, mirrorCollections: true }),
      "w1",
    );
    expect(view.querySelector(".kx-zotero-count")?.textContent).toBe("4 items · 1 file");
    await click(view.querySelector('[aria-label="Expand Thesis"]'));
    expect(rows()).toEqual(["Other4", "Thesis5", "Chapter 23"]);
    await click(view.querySelector('input[aria-label="Chapter 2"]'));
    const thesis = view.querySelector('input[aria-label="Thesis"]') as HTMLInputElement;
    expect([thesis.checked, thesis.indeterminate]).toEqual([true, false]);

    await click(view.querySelector('input[aria-label="PDFs and other files"]'));
    expect(invoke).toHaveBeenLastCalledWith("store_zotero_preview", expect.objectContaining({ collectionKeys: ["THESIS"], attachments: false }), "w1");
    expect((view.querySelector(".key-property-primary") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows why the library cannot be read", async () => {
    const view = await render(async () => {
      throw Error("No Zotero library found. Choose its data folder (it contains zotero.sqlite).");
    });
    expect(view.querySelector(".kx-inline-error")?.textContent).toContain("No Zotero library found");
  });
});
