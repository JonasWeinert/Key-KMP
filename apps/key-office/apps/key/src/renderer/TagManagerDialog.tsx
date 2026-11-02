import { GlobalDialog } from "./GlobalDrawer";
import { Button, Input, Textarea } from "@key/design-system";
import { useEffect, useState } from "react";
interface Props {
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    workspaceId?: string,
  ) => Promise<T>;
  workspaceId?: string;
  onClose: () => void;
  onSaved: () => void;
}
export default function TagManagerDialog({
  invoke,
  workspaceId,
  onClose,
  onSaved,
}: Props) {
  const [rows, setRows] = useState<{ name: string; count: number }[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState(""),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [aiGroups, setAiGroups] = useState<
      { from: string[]; to: string; reason: string }[]
    >([]),
    [instruction, setInstruction] = useState(
      "Merge synonyms and spelling variants without losing meaningful distinctions.",
    );
  const suggestAi = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{
        groups: typeof aiGroups;
        provider: string;
        model: string;
      }>(
        "agent_tag_suggestions",
        { tags: rows.map((r) => r.name), instruction },
        workspaceId,
      );
      setAiGroups(result.groups);
      setMessage(
        `${result.groups.length} suggestions from ${result.provider} · ${result.model}. Choose a suggestion, review its tags, then merge.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const data = await invoke<{ tags: typeof rows; total: number }>(
      "library_tags",
      { offset, limit: 200 },
      workspaceId,
    );
    setRows(data.tags);
    setTotal(data.total);
  };
  useEffect(() => {
    if (workspaceId) void refresh().catch((e) => setError(String(e)));
  }, [workspaceId, offset]);
  const apply = async (to: string | null) => {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ affected: number }>(
        "library_retag",
        { from: selected, to },
        workspaceId,
      );
      setMessage(`Updated ${result.affected} PDFs`);
      setSelected([]);
      setTarget("");
      await refresh();
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const suggestions = () => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.name.toLocaleLowerCase().replace(/[\s_-]+/g, "");
      groups.set(key, [...(groups.get(key) || []), row.name]);
    }
    const group = [...groups.values()].find((g) => g.length > 1);
    if (group) {
      setSelected(group);
      setTarget(group[0]);
      setMessage(
        "Suggested spacing/case variants. Review the selection before merging.",
      );
    } else
      setMessage(
        "No simple case/spacing variants on this page. Semantic tag suggestions require an AI provider.",
      );
  };
  return (
    <GlobalDialog label="Manage PDF tags" onClose={onClose} busy={busy}>
      <section
        className="key-shell-dialog"
        style={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2>Manage PDF tags</h2>
        <p>
          Rename, merge or remove tags across this workspace’s PDFs, including
          removed sources. Collections and files are preserved.
        </p>
        {!workspaceId ? (
          <p>Choose one workspace to manage tags.</p>
        ) : (
          <>
            <div style={{ overflow: "auto", maxHeight: 320 }}>
              {rows.map((row) => (
                <label
                  key={row.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: 6,
                  }}
                >
                  <Input
                    type="checkbox"
                    checked={selected.includes(row.name)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, row.name]
                          : s.filter((v) => v !== row.name),
                      )
                    }
                  />
                  <span style={{ flex: 1 }}>{row.name}</span>
                  <small>{row.count} PDFs</small>
                </label>
              ))}
            </div>
            <div>
              <Button
                disabled={!offset}
                onClick={() => {
                  setSelected([]);
                  setOffset((v) => Math.max(0, v - 200));
                }}
              >
                Previous
              </Button>
              <span>
                {" "}
                {total ? offset + 1 : 0}–{Math.min(offset + 200, total)} of{" "}
                {total}{" "}
              </span>
              <Button
                disabled={offset + 200 >= total}
                onClick={() => {
                  setSelected([]);
                  setOffset((v) => v + 200);
                }}
              >
                Next
              </Button>
            </div>
            <label>
              Canonical tag name
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Rename or merge selected tags into…"
              />
            </label>
            <div>
              <Button
                disabled={busy || !selected.length || !target.trim()}
                onClick={() => void apply(target.trim())}
              >
                {selected.length > 1 ? "Merge selected" : "Rename"}
              </Button>
              <Button
                disabled={busy || !selected.length}
                onClick={() => {
                  if (
                    confirm(
                      `Remove ${selected.length} tags from all PDFs in this workspace?`,
                    )
                  )
                    void apply(null);
                }}
              >
                Remove tags
              </Button>
              <Button onClick={suggestions}>Suggest simple merges</Button>
            </div>
            <details>
              <summary>Agentic tag consolidation</summary>
              <p>
                Sends the tag names on this page to the provider configured in
                Fill a property. No documents are sent. Review each suggestion
                before merging.
              </p>
              <label>
                Instructions
                <Textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <Button
                disabled={busy || rows.length < 2}
                onClick={() => void suggestAi()}
              >
                {busy ? "Working…" : "Suggest with AI"}
              </Button>
              {aiGroups.map((group, i) => (
                <div key={i}>
                  <strong>
                    {group.from.join(", ")} → {group.to}
                  </strong>
                  <p>{group.reason}</p>
                  <Button
                    onClick={() => {
                      setSelected(group.from);
                      setTarget(group.to);
                      setAiGroups((old) =>
                        old.filter((_, index) => index !== i),
                      );
                      setMessage(
                        "Review the selected tags, then click Merge selected.",
                      );
                    }}
                  >
                    Review this merge
                  </Button>
                </div>
              ))}
            </details>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        <Button onClick={onClose}>Close</Button>
      </section>
    </GlobalDialog>
  );
}
