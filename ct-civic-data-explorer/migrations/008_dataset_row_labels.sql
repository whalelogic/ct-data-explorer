-- Datasets may be keyed by any column (an industry, a program, a record ID), not only
-- by Connecticut towns. Rows of such datasets have no town, and the dataset records which
-- column labels its rows. NULL keeps the existing behavior: the Town column labels rows.
ALTER TABLE dataset_records MODIFY town_id INT NULL;
ALTER TABLE datasets ADD COLUMN row_label_key VARCHAR(20) NULL;
