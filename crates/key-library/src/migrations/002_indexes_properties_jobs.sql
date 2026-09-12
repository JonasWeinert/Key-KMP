BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS index_generations (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 kind TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, published_at INTEGER NOT NULL,
 PRIMARY KEY(document_hash,kind)
);
CREATE TABLE IF NOT EXISTS document_properties (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 name TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
 PRIMARY KEY(document_hash,name)
);
CREATE INDEX IF NOT EXISTS properties_filter ON document_properties(name,value,document_hash);
CREATE TABLE IF NOT EXISTS jobs (
 document_hash TEXT PRIMARY KEY REFERENCES documents(hash) ON DELETE CASCADE,
 paused INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
PRAGMA user_version=2;
COMMIT;
