import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  Button,
  Input,
  Textarea,
  Select,
  Surface,
  Badge,
  Field,
  Checkbox,
  Disclosure,
  Progress,
  EmptyState,
} from "@key/design-system";
import "@key/design-system/styles.css";
function Specimen() {
  const [dark, setDark] = useState(false),
    [check, setCheck] = useState(false);
  return (
    <main
      className="key-ui-root"
      data-theme={dark ? "dark" : "light"}
      style={{ minHeight: "100vh", padding: 32, boxSizing: "border-box" }}
    >
      <div style={{ maxWidth: 1040, margin: "auto", display: "grid", gap: 24 }}>
        <header>
          <h1 style={{ fontSize: 24, margin: 0 }}>Key components</h1>
          <p>Shared beUI foundation · content interfaces</p>
          <Button onClick={() => setDark((v) => !v)}>
            {dark ? "Light" : "Dark"} theme
          </Button>
        </header>
        <section style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button variant="primary">Add sources</Button>
          <Button>Save changes</Button>
          <Button variant="ghost">Cancel</Button>
          <Button loading>Saving</Button>
          <Button disabled>Unavailable</Button>
          <Button variant="danger">Remove</Button>
        </section>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
            gap: 24,
          }}
        >
          <Surface>
            <h2 style={{ fontSize: 16 }}>Property settings</h2>
            <div style={{ display: "grid", gap: 16 }}>
              <Field label="Property name">
                <Input density="default" defaultValue="Research topic" />
              </Field>
              <Field label="Value type">
                <Select density="default">
                  <option>Text</option>
                  <option>Number</option>
                  <option>Select</option>
                </Select>
              </Field>
              <Field label="Formula" error="Choose an existing property">
                <Input aria-invalid defaultValue="[Unknown] * 2" />
              </Field>
              <Checkbox
                label="Enable agent fill"
                checked={check}
                onChange={setCheck}
              />
              <Textarea
                aria-label="Agent instructions"
                placeholder="Describe what to extract…"
              />
            </div>
          </Surface>
          <Surface>
            <h2 style={{ fontSize: 16 }}>Research source</h2>
            <Badge tone="success">Search ready</Badge>
            <h3>Attention and working memory</h3>
            <p style={{ color: "var(--key-ui-muted)" }}>
              A source card with stable metadata and relevant passage context.
            </p>
            <Disclosure title="Source metadata">
              <p>Author · Year · Tags · Properties</p>
            </Disclosure>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="primary">Open source</Button>
              <Button>Details</Button>
            </div>
          </Surface>
          <Surface>
            <h2 style={{ fontSize: 16 }}>Activity and review</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <Badge>Queued</Badge>
              <Badge tone="warning">Needs review</Badge>
              <Badge tone="danger">Failed</Badge>
            </div>
            <Progress label="Indexing · 42 of 100 pages" value={42} />
            <Field label="Comment">
              <Textarea placeholder="Write a comment…" />
            </Field>
            <Button variant="primary">Save comment</Button>
          </Surface>
          <EmptyState
            title="No matching sources"
            action={<Button>Clear filters</Button>}
          >
            Try a different query or adjust your filters.
          </EmptyState>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Specimen />);
