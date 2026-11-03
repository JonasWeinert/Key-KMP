// The quick capture window (⌃⌥Space from anywhere): type a thought or paste a link.
// ⌘↩ saves — a link joins the library's Inbox, anything else becomes a note — and Esc closes.
import { useState } from "react";
import { Icon } from "./icons";
import "./quick-capture.css";

const bridge = () => (window as unknown as { key: { captureSave(text: string): Promise<void> } }).key;

export default function QuickCapture() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const link = /^https?:\/\/\S+$/i.test(text.trim());
  const save = () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    void bridge()
      .captureSave(text)
      .catch(() => setSaving(false));
  };
  return (
    <main className="kx-capture">
      <header>
        <Icon name={link ? "globe" : "note"} size={14} />
        <span>{link ? "Add this link to the Inbox" : "New note"}</span>
      </header>
      <textarea
        autoFocus
        value={text}
        placeholder="Capture a thought, or paste a link…"
        aria-label="Capture"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") window.close();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <footer>
        <span>The first line is the note's title</span>
        <button disabled={!text.trim() || saving} onClick={save}>
          Save <kbd>⌘↩</kbd>
        </button>
      </footer>
    </main>
  );
}
