-- Presentation metadata is separate from immutable source data and field approvals.
ALTER TABLE datasets
  ADD COLUMN presentation JSON NULL,
  ADD COLUMN presentation_revision INT NOT NULL DEFAULT 0;
