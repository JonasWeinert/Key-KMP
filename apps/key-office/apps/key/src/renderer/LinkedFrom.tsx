// "Linked from": the notes and canvases that point at an item, one row per linking item
// with the sentence it was mentioned in. Reloads whenever a save rewrites links.
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "./icons";
import { itemLinks, openItem, type ItemLink, type Link } from "./item-links";
import { bridge as libraryBridge, type Invoke } from "./library-api";
import "./linked-from.css";

const KIND_ICON: Record<string, IconName> = { note: "note", canvas: "canvas", source: "doc", record: "doc", file: "doc" };

interface Group {
  key: string;
  from: Link["from"];
  via?: Link["via"];
  links: Link[];
}

/** Several mentions in one note make one row. */
export function groupBacklinks(links: Link[]): Group[] {
  const groups = new Map<string, Group>();
  for (const link of links) {
    const key = `${link.from.kind}:${link.from.id}:${link.via?.id ?? ""}`;
    const group = groups.get(key) ?? { key, from: link.from, via: link.via, links: [] };
    group.links.push(link);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export default function LinkedFrom({ invoke, workspaceId, item }: { invoke: Invoke; workspaceId: string; item: ItemLink }) {
  const [links, setLinks] = useState<Link[]>();
  const load = useCallback(
    () =>
      itemLinks(invoke, workspaceId, item)
        .then((found) => setLinks(found.backlinks))
        .catch(() => setLinks([])),
    [invoke, workspaceId, item.kind, item.id],
  );
  useEffect(() => {
    void load();
    return libraryBridge().on("links-changed", (p) => (p as { workspaceId?: string })?.workspaceId === workspaceId && void load());
  }, [load, workspaceId]);

  if (!links?.length) return null;
  const groups = groupBacklinks(links);
  return (
    <section className="kx-page-section kx-linked-from" aria-label="Linked from">
      <h3>
        Linked from <span className="kx-count">{groups.length}</span>
      </h3>
      <ul>
        {groups.map(({ key, from, via, links }) => {
          const first = links.find((l) => l.context) ?? links[0];
          const places = [...new Set(links.map((l) => l.to.anchorLabel).filter(Boolean))];
          return (
            <li key={key}>
              <button className="kx-linked-from-row" data-kind={from.kind} onClick={() => openItem(invoke, workspaceId, { kind: from.kind, id: from.id }, from.title)}>
                <Icon name={KIND_ICON[from.kind] ?? "doc"} size={13} />
                <span className="kx-linked-from-text">
                  <span className="kx-linked-from-title">
                    {from.title}
                    {via && <span className="kx-linked-from-via"> · on {via.title}</span>}
                    {links.length > 1 && <span className="kx-linked-from-via"> · {links.length} mentions</span>}
                  </span>
                  {first.context && <span className="kx-linked-from-context">{first.context}</span>}
                  {places.length > 0 && <span className="kx-linked-from-place">{places.join(" · ")}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
