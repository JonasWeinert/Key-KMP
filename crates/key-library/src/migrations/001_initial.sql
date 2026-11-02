BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS documents (
 hash TEXT PRIMARY KEY CHECK(length(hash)=64), title TEXT NOT NULL,
 page_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
 completed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at INTEGER NOT NULL, has_source INTEGER NOT NULL DEFAULT 0,
 keyword_ready INTEGER NOT NULL DEFAULT 0, year INTEGER, authors TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS documents_year ON documents(year);
CREATE TABLE IF NOT EXISTS artifacts (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 kind TEXT NOT NULL, version TEXT NOT NULL, key TEXT NOT NULL, payload BLOB NOT NULL,
 PRIMARY KEY(document_hash,kind,version,key)
);
CREATE TABLE IF NOT EXISTS annotations (
 id TEXT PRIMARY KEY, document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 payload TEXT NOT NULL, comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS annotations_document ON annotations(document_hash);
CREATE TABLE IF NOT EXISTS legacy_imports (receipt TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS text_blocks (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 block_key TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(document_hash,block_key)
);
CREATE TABLE IF NOT EXISTS chunks (
 id TEXT PRIMARY KEY, document_hash TEXT NOT NULL, block_key TEXT NOT NULL,
 page INTEGER NOT NULL, context_start INTEGER NOT NULL, context_end INTEGER NOT NULL,
 target_start INTEGER NOT NULL, target_end INTEGER NOT NULL, rects BLOB NOT NULL,
 FOREIGN KEY(document_hash,block_key) REFERENCES text_blocks(document_hash,block_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_hash);
CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(hash UNINDEXED,title,authors);
CREATE TRIGGER IF NOT EXISTS document_insert AFTER INSERT ON documents BEGIN
 INSERT INTO metadata_fts(hash,title,authors) VALUES(new.hash,new.title,new.authors);
END;
CREATE TRIGGER IF NOT EXISTS document_update AFTER UPDATE OF title,authors ON documents BEGIN
 DELETE FROM metadata_fts WHERE hash=old.hash;
 INSERT INTO metadata_fts(hash,title,authors) VALUES(new.hash,new.title,new.authors);
END;
CREATE TRIGGER IF NOT EXISTS document_delete AFTER DELETE ON documents BEGIN
 DELETE FROM metadata_fts WHERE hash=old.hash;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS comment_fts USING fts5(id UNINDEXED,document_hash UNINDEXED,comment);
CREATE TRIGGER IF NOT EXISTS annotation_insert AFTER INSERT ON annotations BEGIN
 INSERT INTO comment_fts(id,document_hash,comment) VALUES(new.id,new.document_hash,new.comment);
END;
CREATE TRIGGER IF NOT EXISTS annotation_delete AFTER DELETE ON annotations BEGIN
 DELETE FROM comment_fts WHERE id=old.id;
END;
PRAGMA user_version=1;
COMMIT;
