-- Typed property definitions, saved agent-fill recipes and the provenance of
-- AI-filled values. Values themselves live in sources.properties.
CREATE TABLE property_definitions (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,          -- {"type","options","formula",...}
  updated_at INTEGER NOT NULL
);
CREATE TABLE agent_recipes (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,          -- {"prompt","inputs",...}
  updated_at INTEGER NOT NULL
);
CREATE TABLE property_provenance (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (source_id, name)
);
