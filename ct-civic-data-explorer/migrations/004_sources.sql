-- Data sources become their own table (SRS §5.3), so each dataset references its
-- source by foreign key instead of repeating the name as free text. Names are unique
-- ignoring case, so 'U.S. Census Bureau' and 'u.s. census bureau' are one source.

CREATE TABLE sources (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL CHECK (name = btrim(name) AND name <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sources_name_lower_idx ON sources (lower(name));

-- Move existing free-text sources into the table, keeping the earliest spelling.
INSERT INTO sources (name)
SELECT DISTINCT ON (lower(btrim(source))) btrim(source)
FROM datasets
ORDER BY lower(btrim(source)), id;

ALTER TABLE datasets ADD COLUMN source_id INTEGER REFERENCES sources(id);
UPDATE datasets d SET source_id = s.id FROM sources s WHERE lower(s.name) = lower(btrim(d.source));
ALTER TABLE datasets ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE datasets DROP COLUMN source;
CREATE INDEX datasets_source_id_idx ON datasets (source_id);
