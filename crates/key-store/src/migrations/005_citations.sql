-- In-text citations of a source, found with its references: where each is printed and
-- which reference entries it names. `citations_version` is the analyser that found them,
-- so sources analysed before (or by an older analyser) get theirs found again.
ALTER TABLE source_analysis ADD COLUMN citations_version INTEGER;
ALTER TABLE source_analysis ADD COLUMN scientific INTEGER;
ALTER TABLE source_analysis ADD COLUMN signals TEXT;

CREATE TABLE source_citations (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  page INTEGER NOT NULL,
  start INTEGER NOT NULL,                   -- character range on the page, in PDF text order
  end INTEGER NOT NULL,
  rect TEXT NOT NULL,                       -- [x,y,w,h] on 0..65535 page scale
  text TEXT NOT NULL,                       -- as printed: "[4-6]", "Smith et al., 2020"
  numbers TEXT NOT NULL,                    -- JSON array of the reference numbers it names
  PRIMARY KEY (source_id, seq)
);
