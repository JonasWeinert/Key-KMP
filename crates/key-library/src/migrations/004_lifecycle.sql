BEGIN IMMEDIATE;
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
CREATE INDEX documents_live ON documents(deleted_at,updated_at);
CREATE TABLE maintenance_events (
 id INTEGER PRIMARY KEY, document_hash TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
PRAGMA user_version=4;
COMMIT;
