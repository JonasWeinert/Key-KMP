// The inspector: a panel at the window's right edge that follows whatever is selected
// (a library row, a canvas card, the focused note) and shows it in place — its preview,
// details, a source's notes and highlights, and what links to it — without opening it.
import { Fragment, useEffect, useState } from "react";
import { FilterLink, FilterLinks, showInLibrary, sourceFilter } from "./filter-links";
import { Icon } from "./icons";
import { copyCitation, copyItemLink, highlightPage, openItemAt, type Highlight } from "./item-actions";
import { itemLinks, setItemDrag, type Link } from "./item-links";
import { ItemBody, ItemHeader, itemAttrs, sendTo, useItemInfo } from "./item-ui";
import LinkedFrom from "./LinkedFrom";
import { bridge, creatorName, type Invoke, type Note } from "./library-api";
import { markdownToPlainText, type DraggedItem, type ItemLink } from "./note-editor";
import { currentTheme, highlightColor } from "./canvas/canvas-colors";
import "./inspector.css";

function SourceExtras({ invoke, workspaceId, sourceId, sourceTitle }: { invoke: Invoke; workspaceId: string; sourceId: string; sourceTitle: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  useEffect(() => {
    let current = true;
    const load = () => {
      void invoke<Note[]>("store_notes", { sourceId }, workspaceId).then((n) => current && setNotes(n)).catch(() => {});
      void invoke<Highlight[]>("library_annotations", { hash: sourceId }, workspaceId).then((h) => current && setHighlights(h)).catch(() => {});
    };
    load();
    const stop = bridge().on("annotations-changed", load);
    window.addEventListener("key:note-saved", load);
    return () => {
      current = false;
      stop();
      window.removeEventListener("key:note-saved", load);
    };
  }, [invoke, workspaceId, sourceId]);
  const theme = currentTheme();
  return (
    <>
      {notes.some((n) => n.body.trim()) && (
        <section className="kx-inspector-section">
          <h4>
            Notes <span className="kx-count">{notes.length}</span>
          </h4>
          {notes.map((note) => {
            const item: DraggedItem = { kind: "note", id: note.id, title: note.title || markdownToPlainText(note.body).split("\n").find(Boolean) || "Note" };
            return (
              <button key={note.id} className="kx-inspector-row" {...itemAttrs(item)} draggable onDragStart={(e) => setItemDrag(e.dataTransfer, [item])} onClick={(e) => openItemAt(item, e.altKey ? "split" : "tab", item.title)}>
                <Icon name="note" size={13} />
                <span>{markdownToPlainText(note.body).slice(0, 220) || "Empty note"}</span>
              </button>
            );
          })}
        </section>
      )}
      {highlights.length > 0 && (
        <section className="kx-inspector-section">
          <h4>
            Highlights <span className="kx-count">{highlights.length}</span>
          </h4>
          {highlights.map((h) => {
            const page = highlightPage(h);
            const item: DraggedItem = { kind: "source", id: sourceId, anchor: `highlight:${h.id}`, title: h.text || "Highlight", detail: sourceTitle, color: h.color };
            return (
              <button
                key={h.id}
                className="kx-inspector-row kx-inspector-highlight"
                style={{ borderLeftColor: highlightColor(h.color, theme) }}
                {...itemAttrs(item)}
                draggable
                onDragStart={(e) => setItemDrag(e.dataTransfer, [item])}
                onClick={() => openItemAt(item, "tab")}
                title="Open at this highlight · drag onto a canvas or into a note"
              >
                <span>{h.text || h.comment || "Highlight"}</span>
                {page !== undefined && <small>p. {page + 1}</small>}
              </button>
            );
          })}
        </section>
      )}
    </>
  );
}

function LinksTo({ invoke, workspaceId, item }: { invoke: Invoke; workspaceId: string; item: ItemLink }) {
  const [links, setLinks] = useState<Link[]>([]);
  useEffect(() => {
    let current = true;
    void itemLinks(invoke, workspaceId, { kind: item.kind, id: item.id })
      .then((found) => current && setLinks(found.outgoing))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [invoke, workspaceId, item.kind, item.id]);
  const unique = [...new Map(links.map((l) => [`${l.to.kind}:${l.to.id}:${l.to.anchor ?? ""}`, l])).values()];
  if (!unique.length) return null;
  return (
    <section className="kx-inspector-section">
      <h4>
        Links to <span className="kx-count">{unique.length}</span>
      </h4>
      {unique.map((link) => {
        const to: DraggedItem = { kind: link.to.kind, id: link.to.id, anchor: link.to.anchor, title: link.to.title };
        return (
          <button key={link.id} className="kx-inspector-row" data-broken={link.broken || undefined} {...itemAttrs(to)} draggable onDragStart={(e) => setItemDrag(e.dataTransfer, [to])} onClick={(e) => openItemAt(to, e.altKey ? "split" : "tab", to.title)}>
            <Icon name={link.to.kind === "note" ? "note" : link.to.kind === "canvas" ? "canvas" : link.to.anchor?.startsWith("highlight:") ? "quote" : "doc"} size={13} />
            <span>
              {link.to.title || "Untitled"}
              {link.to.anchorLabel && <small> · {link.to.anchorLabel}</small>}
            </span>
          </button>
        );
      })}
    </section>
  );
}

export default function Inspector({ invoke, workspaceId, items, onClose }: { invoke: Invoke; workspaceId?: string; items: DraggedItem[]; onClose: () => void }) {
  const item = items[0];
  const info = useItemInfo(invoke, workspaceId, item);
  return (
    <aside className="kx-inspector-panel key-ui-root" aria-label="Inspector" data-no-preview>
      <div className="kx-inspector-panel-bar">
        <span>{items.length > 1 ? `${items.length} selected` : "Inspector"}</span>
        <button className="kx-icon-button" aria-label="Close inspector" title="Close (⌘⇧I)" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      {!item || !workspaceId ? (
        <p className="kx-inspector-placeholder">Select a source, note, highlight or card to see it here.</p>
      ) : !info ? (
        <div className="kx-skeleton-line" />
      ) : (
        <div className="kx-inspector-panel-scroll">
          <div
            className="kx-inspector-card"
            draggable={info.exists}
            onDragStart={(e) => setItemDrag(e.dataTransfer, items)}
            title="Drag onto a canvas, into a note or onto a collection"
          >
            <ItemHeader info={info} />
            <div className="kx-inspector-actions">
              <button onClick={() => openItemAt(item, "tab", info.title)}>Open</button>
              <button onClick={() => openItemAt(item, "split", info.title)}>
                <Icon name="split" size={12} /> Beside
              </button>
              <button title="Copy link (⌘L)" aria-label="Copy link" onClick={() => void copyItemLink(items.map((i) => ({ item: i, title: i.title })))}>
                <Icon name="link" size={12} />
              </button>
              {info.source && (
                <button title="Copy citation (⌘⇧C)" aria-label="Copy citation" onClick={() => void copyCitation(invoke, workspaceId, items)}>
                  <Icon name="quote" size={12} />
                </button>
              )}
              <button title="Send to a canvas or note (⌘⇧S)" aria-label="Send to" onClick={() => sendTo(items)}>
                <Icon name="arrowRight" size={12} />
              </button>
            </div>
            <div className="kx-inspector-preview">
              <ItemBody info={info} invoke={invoke} workspaceId={workspaceId} />
            </div>
          </div>
          {info.source && !info.highlight && (
            <FilterLinks.Provider value={(filter) => showInLibrary(workspaceId, filter)}>
              <section className="kx-inspector-section kx-inspector-facts">
                {info.source.creators.length > 0 && (
                  <p>
                    <span>Authors</span>
                    {info.source.creators.map((c, i) => (
                      <Fragment key={i}>
                        {i > 0 && ", "}
                        <FilterLink filter={sourceFilter.creator(c)}>{creatorName(c)}</FilterLink>
                      </Fragment>
                    ))}
                  </p>
                )}
                {info.source.year && (
                  <p>
                    <span>Year</span>
                    <FilterLink filter={sourceFilter.year(info.source.year)}>{info.source.year}</FilterLink>
                  </p>
                )}
                {info.source.containerTitle && (
                  <p>
                    <span>In</span>
                    <FilterLink filter={sourceFilter.container(info.source.containerTitle)}>{info.source.containerTitle}</FilterLink>
                  </p>
                )}
                {info.source.doi && (
                  <p>
                    <span>DOI</span>
                    <a href={`https://doi.org/${info.source.doi}`} target="_blank" rel="noreferrer">
                      {info.source.doi}
                    </a>
                  </p>
                )}
                {info.source.tags.length > 0 && (
                  <p>
                    <span>Tags</span>
                    {info.source.tags.map((tag, i) => (
                      <Fragment key={tag}>
                        {i > 0 && ", "}
                        <FilterLink filter={sourceFilter.tag(tag)}>{tag}</FilterLink>
                      </Fragment>
                    ))}
                  </p>
                )}
              </section>
            </FilterLinks.Provider>
          )}
          {info.source && !item.anchor && <SourceExtras invoke={invoke} workspaceId={workspaceId} sourceId={info.source.id} sourceTitle={info.source.title || "Untitled"} />}
          <LinksTo invoke={invoke} workspaceId={workspaceId} item={item} />
          <LinkedFrom invoke={invoke} workspaceId={workspaceId} item={{ kind: item.kind, id: item.id }} />
        </div>
      )}
    </aside>
  );
}
