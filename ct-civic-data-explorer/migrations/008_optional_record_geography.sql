-- Categories and other source records do not need a Connecticut town.
ALTER TABLE dataset_records MODIFY COLUMN town_id INT NULL;
