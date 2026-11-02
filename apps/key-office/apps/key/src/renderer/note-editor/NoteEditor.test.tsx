// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import NoteEditor from "./index";
import type { NoteEditorProps, SourceRef } from "./index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCES: SourceRef[] = [{ id: "abc123", title: "Health versus income amid COVID-19", detail: "Palma et al. 2022" }];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});

function props(overrides: Partial<NoteEditorProps> = {}): NoteEditorProps {
  return {
    value: "",
    onChange: () => {},
    searchSources: async (q) => SOURCES.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())),
    resolveSource: async (id) => SOURCES.find((s) => s.id === id),
    onOpenSource: () => {},
    ...overrides,
  };
}

async function mount(p: NoteEditorProps) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<NoteEditor {...p} />));
  const dom = host.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  expect(dom).not.toBeNull();
  return { dom: dom!, editor: dom!.editor! };
}

describe("NoteEditor", () => {
  it("renders custom blocks through their node views", async () => {
    const md = [
      '```callout tone="tip"',
      "Remember",
      "```",
      "",
      '```source id="abc123"',
      "Palma et al. 2022 — Health versus income amid COVID-19",
      "```",
      "",
      '```quote source="abc123" page="4"',
      "Quoted text",
      "```",
      "",
      "See [Palma 2022](key://source/abc123).",
    ].join("\n");
    const { dom } = await mount(props({ value: md }));
    await act(async () => {});
    expect(dom.querySelector(".ne-callout.ne-tone-tip")).not.toBeNull();
    expect(dom.querySelector(".ne-source-card-title")?.textContent).toBe("Health versus income amid COVID-19");
    expect(dom.querySelector(".ne-squote-link")?.textContent).toContain("p. 5");
    expect(dom.querySelector('a[href="key://source/abc123"]')).not.toBeNull();
  });

  it("emits debounced markdown, and not when the value is replaced from outside", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const p = props({ value: "# Note A", onChange });
    const { editor } = await mount(p);

    await act(async () => {
      root!.render(<NoteEditor {...p} value={"# Note B"} />);
    });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getText().trim()).toBe("Note B");

    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.firstChild!.nodeSize - 1, " edited");
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(450));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe("# Note B edited");
  });

  it("does not emit just because the loaded markdown is not canonical", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { dom } = await mount(props({ value: "|a|b|\n|-|-|\n|1|2|\n\n- [ ] x\n", onChange }));
    await act(async () => {
      dom.dispatchEvent(new FocusEvent("focus"));
      dom.dispatchEvent(new FocusEvent("blur"));
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("flushes pending edits on unmount", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { editor } = await mount(props({ value: "Hello", onChange }));
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.firstChild!.nodeSize - 1, " world");
    });
    await act(async () => root!.unmount());
    root = null;
    expect(onChange).toHaveBeenCalledWith("Hello world");
  });

  it("opens the source when a mention chip is clicked", async () => {
    const onOpenSource = vi.fn();
    const { dom } = await mount(props({ value: "See [Palma 2022](key://source/abc123).", onOpenSource }));
    const chip = dom.querySelector('a[href="key://source/abc123"]') as HTMLElement;
    await act(async () => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenSource).toHaveBeenCalledWith("abc123", undefined);
  });
});
