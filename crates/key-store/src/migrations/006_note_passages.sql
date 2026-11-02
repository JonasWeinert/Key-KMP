-- Notes are cut into passages like documents, so their text is searchable by words and
-- meaning. A passage belongs to a source or to a note, never both; the table is rebuilt
-- because SQLite cannot drop NOT NULL. Row ids are kept, so the keyword index and the
-- vectors stay attached.
CREATE TABLE chunks_new (
  id INTEGER PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page INTEGER,
  start_seconds REAL,
  text TEXT NOT NULL,
  rects TEXT,                               -- [[x,y,w,h], ...] on 0..65535 page scale
  embedded INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  section TEXT,
  CHECK ((source_id IS NULL) <> (note_id IS NULL))
);
INSERT INTO chunks_new(id, source_id, seq, page, start_seconds, text, rects, embedded, kind, section)
  SELECT id, source_id, seq, page, start_seconds, text, rects, embedded, kind, section FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;
CREATE INDEX chunks_source ON chunks(source_id, seq);
CREATE INDEX chunks_note ON chunks(note_id, seq) WHERE note_id IS NOT NULL;
CREATE INDEX chunks_unembedded ON chunks(id) WHERE embedded = 0;
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM chunk_vectors WHERE rowid = old.id;
END;

-- When a note's passages were last cut; older than updated_at means they are due.
ALTER TABLE notes ADD COLUMN indexed_at INTEGER;
