-- Keep source rows intact when a town has categories, employers or other repeated records.
ALTER TABLE datasets
  ADD COLUMN data_format VARCHAR(20) NOT NULL DEFAULT 'indicators',
  ADD COLUMN column_definitions JSON NULL,
  ADD COLUMN import_notes JSON NULL;

CREATE TABLE dataset_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  dataset_id INT NOT NULL,
  town_id INT NOT NULL,
  source_row INT NOT NULL,
  cell_values JSON NOT NULL,
  UNIQUE KEY dataset_records_source_row (dataset_id, source_row),
  KEY dataset_records_town (dataset_id, town_id),
  CONSTRAINT dataset_records_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets(id),
  CONSTRAINT dataset_records_town_fk FOREIGN KEY (town_id) REFERENCES towns(id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;
