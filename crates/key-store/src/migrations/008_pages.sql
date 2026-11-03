-- Every item is a page: notes carry standard fields (the same camelCase keys as a source:
-- creators, year, url ...) and the user's own properties, and notes and sources carry a
-- page appearance (icon, cover image, colour or gradient). All three are JSON objects.
ALTER TABLE notes ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN properties TEXT NOT NULL DEFAULT '{}';
ALTER TABLE notes ADD COLUMN appearance TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN appearance TEXT NOT NULL DEFAULT '{}';
