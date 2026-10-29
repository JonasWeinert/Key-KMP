-- One file per workspace. Bibliographic fields are fixed columns; anything a user
-- invents lives in `properties` (JSON). Extracted text is chunked for FTS5 and vectors.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- pdf | web | video | audio | image | file | reference
  item_type TEXT NOT NULL DEFAULT 'document',
  title TEXT NOT NULL DEFAULT '',
  short_title TEXT,
  creators TEXT NOT NULL DEFAULT '[]',      -- [{"family","given","literal","role"}]
  year INTEGER,
  date TEXT,
  container_title TEXT,                     -- journal, book, website, conference
  container_short TEXT,
  volume TEXT,
  issue TEXT,
  pages TEXT,
  edition TEXT,
  series TEXT,
  publisher TEXT,
  place TEXT,
  institution TEXT,
  genre TEXT,
  doi TEXT,
  isbn TEXT,
  issn TEXT,
  pmid TEXT,
  pmcid TEXT,
  arxiv_id TEXT,
  url TEXT,
  accessed TEXT,
  abstract TEXT,
  language TEXT,
  rights TEXT,
  citation_key TEXT,
  extra TEXT,
  duration_seconds REAL,
  file_path TEXT,
  file_hash TEXT,
  file_size INTEGER,
  mime TEXT,
  page_count INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  properties TEXT NOT NULL DEFAULT '{}',
  starred INTEGER NOT NULL DEFAULT 0,
  read_state TEXT,
  index_status TEXT NOT NULL DEFAULT 'pending', -- pending | indexing | ready | no_text | missing | failed | skipped
  index_error TEXT,
  indexed_chunks INTEGER NOT NULL DEFAULT 0,
  index_total INTEGER NOT NULL DEFAULT 0,
  origin TEXT,
  origin_key TEXT,
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  trashed_at INTEGER
);
CREATE INDEX sources_file_hash ON sources(file_hash);
CREATE INDEX sources_doi ON sources(doi);
CREATE UNIQUE INDEX sources_origin ON sources(origin, origin_key) WHERE origin_key IS NOT NULL;
CREATE INDEX sources_added ON sources(added_at);
CREATE INDEX sources_title ON sources(title COLLATE NOCASE);
CREATE INDEX sources_year ON sources(year);
CREATE INDEX sources_status ON sources(index_status);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  origin_key TEXT
);
CREATE TABLE source_collections (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, collection_id)
);
CREATE INDEX source_collections_collection ON source_collections(collection_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  origin_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notes_source ON notes(source_id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX annotations_source ON annotations(source_id);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page INTEGER,
  start_seconds REAL,
  text TEXT NOT NULL,
  rects TEXT                                -- [[x,y,w,h], ...] on 0..65535 page scale
);
CREATE INDEX chunks_source ON chunks(source_id, seq);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM chunk_vectors WHERE rowid = old.id;
END;

-- Metadata search; rows are keyed by sources.rowid and rewritten on every source change.
CREATE VIRTUAL TABLE sources_fts USING fts5(
  title, creators, container, abstract, tags, notes, identifiers,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[768] distance_metric=cosine);
