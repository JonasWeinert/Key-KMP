BEGIN IMMEDIATE;
CREATE TABLE index_publications (
 path TEXT PRIMARY KEY,
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('lexical','vector')),
 version TEXT NOT NULL,
 expected_path TEXT,
 digest TEXT NOT NULL,
 queued_at INTEGER NOT NULL
);
PRAGMA user_version=9;
COMMIT;
