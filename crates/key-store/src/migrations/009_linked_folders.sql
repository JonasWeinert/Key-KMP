-- Folders elsewhere on the computer, linked into the workspace without copying. Each is
-- tracked (its files listed in a manifest and watched) and optionally indexed (its text
-- cut into passages for keyword and meaning search). See linked.rs.
CREATE TABLE linked_folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,                -- absolute, canonical
  name TEXT NOT NULL,
  tracked INTEGER NOT NULL DEFAULT 1,
  indexed INTEGER NOT NULL DEFAULT 0,
  missing_at INTEGER,                       -- the folder could not be read (unmounted drive)
  scanned_at INTEGER,
  created_at INTEGER NOT NULL
);

-- The manifest. A file keeps its id across renames and moves inside its folder (matched by
-- inode, then by content hash), so links to it survive. A file that disappears is kept with
-- `missing_at` set until it comes back or the folder is unlinked.
CREATE TABLE linked_files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES linked_folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                       -- relative to the folder, '/'-separated
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,                   -- ms
  inode INTEGER,
  hash TEXT,                                -- sha256 of the bytes, computed lazily
  missing_at INTEGER,
  indexed_mtime INTEGER,                    -- mtime of the version whose passages are stored
  index_error TEXT,
  source_id TEXT,                           -- set once a PDF was opened in the reader
  UNIQUE(folder_id, path)
);
CREATE INDEX linked_files_inode ON linked_files(folder_id, inode);
CREATE INDEX linked_files_name ON linked_files(name COLLATE NOCASE);

-- Passages now belong to a source, a note or a linked file. Rebuilt as in 006, keeping row
-- ids so the keyword index and vectors stay attached.
CREATE TABLE chunks_new (
  id INTEGER PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES linked_files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page INTEGER,
  start_seconds REAL,
  text TEXT NOT NULL,
  rects TEXT,
  embedded INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  section TEXT,
  CHECK ((source_id IS NOT NULL) + (note_id IS NOT NULL) + (file_id IS NOT NULL) = 1)
);
INSERT INTO chunks_new(id, source_id, note_id, seq, page, start_seconds, text, rects, embedded, kind, section)
  SELECT id, source_id, note_id, seq, page, start_seconds, text, rects, embedded, kind, section FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX chunks_source ON chunks(source_id, seq);
CREATE INDEX chunks_note ON chunks(note_id, seq) WHERE note_id IS NOT NULL;
CREATE INDEX chunks_file ON chunks(file_id, seq) WHERE file_id IS NOT NULL;
CREATE INDEX chunks_unembedded ON chunks(id) WHERE embedded = 0;
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM chunk_vectors WHERE rowid = old.id;
END;
