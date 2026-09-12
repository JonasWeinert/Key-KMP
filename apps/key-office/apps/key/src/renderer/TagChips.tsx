import { useState } from "react";
export default function TagChips({
  name,
  label,
  initial,
}: {
  name: string;
  label: string;
  initial: string[];
}) {
  const [values, setValues] = useState(initial),
    [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) setValues([...new Set([...values, ...parts])]);
    setDraft("");
  };
  return (
    <div className="key-tag-editor">
      <span>{label}</span>
      <input
        type="hidden"
        name={name}
        value={[
          ...values,
          ...draft
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean),
        ].join("; ")}
      />
      <div>
        {values.map((v) => (
          <button
            type="button"
            key={v}
            onClick={() => setValues(values.filter((x) => x !== v))}
            aria-label={`Remove ${label} ${v}`}
          >
            {v} ×
          </button>
        ))}
        <input
          aria-label={`Add ${label}`}
          placeholder={`Add ${label.toLowerCase()}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ";") {
              e.preventDefault();
              add();
            }
            if (e.key === "Backspace" && !draft) setValues(values.slice(0, -1));
          }}
        />
      </div>
    </div>
  );
}
