ALTER TABLE datasets
  ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN private_source VARCHAR(300) NULL,
  DROP INDEX datasets_name_vintage_version_key,
  DROP INDEX datasets_one_active_idx,
  ADD UNIQUE KEY datasets_scoped_version (name, vintage, (IF(is_private, uploaded_by, 0)), version),
  ADD UNIQUE KEY datasets_one_active_public (name, vintage, (IF(is_active AND NOT is_private, 1, NULL))),
  ADD KEY datasets_private_owner (is_private, uploaded_by);
