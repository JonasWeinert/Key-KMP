-- Cross-references between any two items. A link points from one item to another by kind
-- and id (note | source | canvas | record), each with an optional anchor inside it
-- (page:3, highlight:<id>, heading:<slug>, node:<id>). Titles are never stored: they are
-- read from the item at query time, so a rename shows everywhere at once. `owner` is the
-- note or canvas whose save wrote the row; each save replaces all rows it owns.
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_anchor TEXT,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_anchor TEXT,
  label TEXT,                               -- the link's own text, shown when the target is gone
  context TEXT,                             -- the sentence around it, for backlinks
  seq INTEGER NOT NULL DEFAULT 0,
  broken_at INTEGER,                        -- set when the target was deleted
  created_at INTEGER NOT NULL
);
CREATE INDEX links_owner ON links(owner_kind, owner_id);
CREATE INDEX links_from ON links(from_kind, from_id);
CREATE INDEX links_to ON links(to_kind, to_id);

-- Infinite canvases: the scene is a JSON document (cards, shapes, ink, connectors).
CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Notes written before links existed are read again, so their links are found.
UPDATE notes SET indexed_at = NULL;
