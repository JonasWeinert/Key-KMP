// Answers the Go menu's commands for the window: Open Quickly, Commands, Copy Link,
// Copy Citation, Send to… and the shortcut list. Commands act on what is selected
// (library rows, canvas cards) or else on the focused pane's item.
import { useEffect, useState } from "react";
import { GlobalDialog } from "./GlobalDrawer";
import { copyCitation, copyItemLink, describeCount, openItemAt, sendToCanvas, sendToNote, toast, type InsertMode } from "./item-actions";
import { onSendTo, quickLook, selectedItems, showInInspector } from "./item-ui";
import { bridge, type Invoke, type Note } from "./library-api";
import Palette, { type Command } from "./Palette";
import type { DraggedItem } from "./note-editor";
import { notesChanged } from "./NotePage";

type Open = { mode: "open" } | { mode: "commands" } | { mode: "send"; items: DraggedItem[] } | { mode: "shortcuts" };

export const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Find and open",
    [
      ["⌘P", "Open quickly: any note, source, highlight, canvas or page"],
      ["⌘K", "Commands for the selection"],
      ["Space", "Quick look at the hovered or selected item"],
      ["↩ / ⌥↩", "Open · open beside the current pane"],
      ["Click a link", "Follow it in the same pane (⌥ beside, ⌘ new tab)"],
      ["⌘[ ⌘]", "Back and forward in a pane"],
      ["⌘⇧T", "Reopen the last closed tab"],
      ["⌘1 … ⌘9", "Go to a tab"],
    ],
  ],
  [
    "Link and cite",
    [
      ["[[", "In a note: link to anything"],
      ["![[", "In a note: embed a note, highlight, source or canvas"],
      ["@", "In a note: cite a source, e.g. @smith p. 12"],
      ["⌘L", "Copy a link to the selection"],
      ["⌘⇧C", "Copy the citation"],
      ["⌘⇧S", "Send the selection to a canvas or note"],
    ],
  ],
  [
    "Drag and drop",
    [
      ["Drop", "Link (in a note) or card (on a canvas)"],
      ["⌥ Drop", "Embed the item in a note"],
      ["⌘ Drop", "Cite the item in a note"],
      ["Hover a tab", "Switches to it while dragging"],
    ],
  ],
  [
    "Panels",
    [
      ["⌘⇧I", "Show or hide the inspector"],
      ["⌘⇧H", "All highlights"],
      ["⌘\\", "Split right"],
      ["⌃⌥Space", "Quick capture from anywhere"],
    ],
  ],
];

function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <GlobalDialog label="Keyboard shortcuts" onClose={onClose}>
      <div className="kx-shortcuts">
        <h2>Keyboard shortcuts</h2>
        <div className="kx-shortcuts-grid">
          {SHORTCUTS.map(([group, rows]) => (
            <section key={group}>
              <h3>{group}</h3>
              <dl>
                {rows.map(([keys, what]) => (
                  <div key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </GlobalDialog>
  );
}

export default function CommandCenter({
  invoke,
  workspaceId,
  commands,
}: {
  invoke: Invoke;
  workspaceId?: string;
  /** The window's own commands (new note, toggle sidebar …). */
  commands: Command[];
}) {
  const [open, setOpen] = useState<Open>();
  const [mode, setMode] = useState<InsertMode>("link");
  const close = () => setOpen(undefined);
  const current = () => selectedItems();
  useEffect(() => onSendTo((items) => setOpen({ mode: "send", items })), []);
  // A highlight sent from a PDF reader.
  useEffect(() => bridge().on("send-items", (items) => setOpen({ mode: "send", items: items as DraggedItem[] })), []);
  useEffect(() => {
    const show = () => setTimeout(() => setOpen({ mode: "shortcuts" }));
    window.addEventListener("key:shortcuts", show);
    return () => window.removeEventListener("key:shortcuts", show);
  }, []);
  useEffect(
    () =>
      bridge().on("command", (name) => {
        const items = current();
        switch (name) {
          case "quick-open":
            return setOpen({ mode: "open" });
          case "palette":
            return setOpen({ mode: "commands" });
          case "shortcuts":
            return setOpen({ mode: "shortcuts" });
          case "highlights":
            return workspaceId && void bridge().tabAction("open-content", { section: "highlights", workspaceId });
          case "copy-link":
            // A text selection copies as usual; the shortcut is for items.
            if (document.getSelection()?.toString()) return;
            return items.length ? void copyItemLink(items.map((item) => ({ item, title: item.title }))) : toast("Select something to copy a link to");
          case "copy-citation":
            return items.length && workspaceId ? void copyCitation(invoke, workspaceId, items) : toast("Select a source or highlight to cite");
          case "send-to":
            return items.length ? setOpen({ mode: "send", items }) : toast("Select something to send");
        }
      }),
    [invoke, workspaceId],
  );
  if (!open || !workspaceId) return null;
  if (open.mode === "shortcuts") return <Shortcuts onClose={close} />;
  const selection = current();
  const forSelection: Command[] = selection.length
    ? [
        { id: "sel-open-beside", label: `Open “${selection[0].title}” beside`, icon: "split", shortcut: "⌥↩", run: () => openItemAt(selection[0], "split", selection[0].title) },
        { id: "sel-look", label: "Quick look", icon: "search", shortcut: "Space", run: () => quickLook(selection[0]) },
        { id: "sel-send", label: `Send ${describeCount(selection)} to…`, icon: "arrowRight", shortcut: "⌘⇧S", run: () => setTimeout(() => setOpen({ mode: "send", items: selection })) },
        { id: "sel-link", label: "Copy link", icon: "link", shortcut: "⌘L", run: () => void copyItemLink(selection.map((item) => ({ item, title: item.title }))) },
        { id: "sel-cite", label: "Copy citation", icon: "quote", shortcut: "⌘⇧C", run: () => void copyCitation(invoke, workspaceId, selection) },
        { id: "sel-inspect", label: "Show in inspector", icon: "panelRight", shortcut: "⌘⇧I", run: () => showInInspector(selection) },
      ]
    : [];
  if (open.mode === "send") {
    const items = open.items;
    const created = async (kind: "canvas" | "note") => {
      if (kind === "canvas") {
        const canvas = await invoke<{ id: string; title: string }>("store_canvas_save", { id: null, title: "", doc: { version: 1, nodes: [], edges: [] } }, workspaceId);
        window.dispatchEvent(new Event("key:canvases-changed"));
        await sendToCanvas(invoke, workspaceId, canvas.id, items);
        openItemAt({ kind: "canvas", id: canvas.id }, "split", "Untitled canvas");
      } else {
        const note = await invoke<Note>("store_note_save", { id: null, sourceId: null, title: "", body: "" }, workspaceId);
        notesChanged();
        await sendToNote(invoke, workspaceId, note.id, items, mode);
        openItemAt({ kind: "note", id: note.id }, "split", "Untitled note");
      }
    };
    return (
      <Palette
        invoke={invoke}
        workspaceId={workspaceId}
        label="Send to"
        placeholder={`Send ${describeCount(items)} to a canvas or note…`}
        options={{ kinds: ["canvas", "note"], titlesOnly: true, limit: 10 }}
        commands={[
          { id: "new-canvas", label: "New canvas with these", icon: "canvas", run: () => void created("canvas").catch((e) => toast(String(e))) },
          { id: "new-note", label: "New note with these", icon: "note", run: () => void created("note").catch((e) => toast(String(e))) },
        ]}
        onPick={(target) => {
          const send = target.kind === "canvas" ? sendToCanvas(invoke, workspaceId, target.id, items) : sendToNote(invoke, workspaceId, target.id, items, mode);
          void send
            .then((undo) => toast(`${target.kind === "canvas" ? "Added" : mode === "embed" ? "Embedded" : mode === "cite" ? "Cited" : "Linked"} ${describeCount(items)} ${target.kind === "canvas" ? "to" : "in"} ${target.title}`, undo))
            .catch((e) => toast(String(e)));
        }}
        onClose={close}
        footer={
          <>
            <span>In a note, as</span>
            <span className="kx-palette-modes" role="group" aria-label="Insert as">
              {(["link", "embed", "cite"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === "link" ? "Link" : m === "embed" ? "Embed" : "Citation"}
                </button>
              ))}
            </span>
          </>
        }
      />
    );
  }
  return (
    <Palette
      invoke={invoke}
      workspaceId={workspaceId}
      label={open.mode === "open" ? "Open quickly" : "Commands"}
      placeholder={open.mode === "open" ? "Open a note, source, highlight, canvas or page…" : "Type a command or search…"}
      commands={open.mode === "commands" ? [...forSelection, ...commands] : []}
      onPick={(found, how) => openItemAt(found, how.alt ? "split" : "tab", found.title)}
      onClose={close}
    />
  );
}
