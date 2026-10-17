-- Finish moving datasets and saved reports off the town-only model (008 made it possible).
--
-- 1. Source-row datasets uploaded before 008 label their rows by their Town column only
--    implicitly (row_label_key is NULL). Record that column so every source-row dataset
--    names its label column the same way.
UPDATE datasets d
SET d.row_label_key = (
  SELECT jt.column_key
  FROM JSON_TABLE(
    d.column_definitions, '$[*]'
    COLUMNS (column_key VARCHAR(20) PATH '$.key', column_role VARCHAR(20) PATH '$.role')
  ) AS jt
  WHERE jt.column_role = 'town'
  LIMIT 1
)
WHERE d.data_format = 'records' AND d.row_label_key IS NULL;

-- 2. Only source-row datasets have a label column, and keys look like c0, c1, ...
--    Indicator datasets are always one row per town.
ALTER TABLE datasets
  ADD CONSTRAINT datasets_row_label_key_chk CHECK (
    row_label_key IS NULL
    OR (data_format = 'records' AND REGEXP_LIKE(row_label_key, '^c[0-9]{1,3}$', 'c'))
  );

-- 3. Saved reports stored their rows as `towns`. Store them as `rows`, the current shape.
--    The application still translates `towns` on read, so restored backups keep working.
UPDATE reports
SET selection = JSON_REMOVE(JSON_SET(selection, '$.rows', JSON_EXTRACT(selection, '$.towns')), '$.towns')
WHERE JSON_CONTAINS_PATH(selection, 'one', '$.towns')
  AND NOT JSON_CONTAINS_PATH(selection, 'one', '$.rows');
