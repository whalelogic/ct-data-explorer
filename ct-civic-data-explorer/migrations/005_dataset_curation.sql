-- Existing published datasets retain their available fields until reviewed (NULL).
-- Application inserts explicitly use [] so new uploads cannot expose unreviewed fields.
ALTER TABLE datasets
  ADD COLUMN approved_fields JSON NULL,
  ADD COLUMN curation_reviewed_at DATETIME(3) NULL,
  ADD COLUMN curation_reviewed_by INT NULL,
  ADD CONSTRAINT datasets_curation_reviewer_fk FOREIGN KEY (curation_reviewed_by) REFERENCES users(id);
