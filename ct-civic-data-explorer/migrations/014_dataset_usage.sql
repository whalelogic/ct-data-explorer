CREATE TABLE usage_activity_daily (
  activity_date DATE         NOT NULL,
  event_type    VARCHAR(24)  NOT NULL,
  hits          BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (activity_date, event_type)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

CREATE TABLE dataset_usage_daily (
  activity_date DATE         NOT NULL,
  event_type    VARCHAR(24)  NOT NULL,
  dataset_id    INT          NOT NULL,
  indicator_key VARCHAR(100) NOT NULL DEFAULT '',
  hits          BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (activity_date, event_type, dataset_id, indicator_key),
  KEY dataset_usage_dataset_idx (dataset_id),
  CONSTRAINT dataset_usage_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets (id) ON DELETE CASCADE
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;
