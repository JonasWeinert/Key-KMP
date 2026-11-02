-- Where each passage sits in the document: the layout block it came from and the
-- section heading above it.
ALTER TABLE chunks ADD COLUMN kind TEXT;
ALTER TABLE chunks ADD COLUMN section TEXT;

-- How a source's text was extracted (layout analysis with or without the model, or plain
-- PDF text), its Markdown, and how far reference detection and lookup have got.
CREATE TABLE source_analysis (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,                     -- layout-onnx | layout | pdfium | text
  markdown TEXT,
  analyzed_at INTEGER NOT NULL,
  references_status TEXT NOT NULL DEFAULT 'pending',  -- pending | detecting | resolving | done | none | failed
  references_error TEXT,
  references_total INTEGER NOT NULL DEFAULT 0,
  references_done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX source_analysis_references ON source_analysis(references_status);

-- The bibliography of a source: each entry, where it is printed, and what it resolved to.
CREATE TABLE source_references (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  number INTEGER,
  page INTEGER,
  rects TEXT,                               -- [[x,y,w,h], ...] on 0..65535 page scale
  text TEXT NOT NULL,
  metadata TEXT,                            -- resolved title, authors, year, DOI … as JSON
  error TEXT,
  matched_source_id TEXT,                   -- the cited work, when it is in this library
  PRIMARY KEY (source_id, seq)
);
CREATE INDEX source_references_matched ON source_references(matched_source_id) WHERE matched_source_id IS NOT NULL;
