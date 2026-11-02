-- Whether a chunk has its vector, so the indexer finds the ones still missing with an
-- index lookup instead of probing the vector table row by row (seconds on large libraries).
ALTER TABLE chunks ADD COLUMN embedded INTEGER NOT NULL DEFAULT 0;
UPDATE chunks SET embedded = 1 WHERE id IN (SELECT rowid FROM chunk_vectors_rowids);
CREATE INDEX chunks_unembedded ON chunks(id) WHERE embedded = 0;
