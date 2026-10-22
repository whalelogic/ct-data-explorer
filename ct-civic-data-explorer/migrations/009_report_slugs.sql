-- Saved reports get a readable, unique address: /explore/<slug>.html.
-- Some development databases already have this column from an unreleased branch, so the
-- column and index are added only when missing. Existing reports get a slug made from
-- their title plus their ID, which is unique; the next save gives a cleaner one.
SET @add_report_slug = IF(
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'reports' AND column_name = 'slug'
  ),
  'SELECT 1',
  'ALTER TABLE reports ADD COLUMN slug VARCHAR(80) NULL'
);
PREPARE add_report_slug FROM @add_report_slug;
EXECUTE add_report_slug;
DEALLOCATE PREPARE add_report_slug;

SET @add_report_slug_key = IF(
  EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'reports' AND index_name = 'reports_slug_key'
  ),
  'SELECT 1',
  'CREATE UNIQUE INDEX reports_slug_key ON reports (slug)'
);
PREPARE add_report_slug_key FROM @add_report_slug_key;
EXECUTE add_report_slug_key;
DEALLOCATE PREPARE add_report_slug_key;

UPDATE reports
SET slug = CONCAT(
  COALESCE(NULLIF(TRIM(BOTH '-' FROM LEFT(LOWER(REGEXP_REPLACE(title, '[^A-Za-z0-9]+', '-')), 60)), ''), 'report'),
  '-',
  id
)
WHERE slug IS NULL;
