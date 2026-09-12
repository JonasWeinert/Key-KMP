BEGIN IMMEDIATE;
CREATE TABLE processing_leases (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 stage TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(document_hash,stage)
);
PRAGMA user_version=5;
COMMIT;
