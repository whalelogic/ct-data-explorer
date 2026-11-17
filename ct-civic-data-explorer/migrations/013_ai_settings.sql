CREATE TABLE IF NOT EXISTS ai_settings (
  id       TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  provider VARCHAR(16)      NOT NULL,
  model    VARCHAR(200)     NULL,
  CONSTRAINT ai_settings_singleton CHECK (id = 1)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;
