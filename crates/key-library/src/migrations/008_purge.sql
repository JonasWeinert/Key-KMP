BEGIN IMMEDIATE;
CREATE TABLE purge_tombstones(hash TEXT PRIMARY KEY CHECK(length(hash)=64),purged_at INTEGER NOT NULL);
CREATE TABLE purge_files(path TEXT PRIMARY KEY,document_hash TEXT NOT NULL,queued_at INTEGER NOT NULL);
CREATE TRIGGER reject_purged_document BEFORE INSERT ON documents
WHEN EXISTS(SELECT 1 FROM purge_tombstones WHERE hash=new.hash)
BEGIN SELECT RAISE(ABORT,'Document was permanently deleted'); END;
PRAGMA user_version=8;
COMMIT;
