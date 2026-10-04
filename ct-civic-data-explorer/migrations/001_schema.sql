-- Core schema (SRS §5.3) for MySQL 8.4. Values are stored in long format (observations),
-- so a new dataset or indicator is an insert, never a schema change.
--
-- Every table uses utf8mb4_0900_as_cs: comparisons and unique keys are case- and
-- accent-sensitive (as on PostgreSQL), and sorting is linguistic. Code that needs
-- case-insensitive matching says so explicitly (LOWER(), or a _ci collation in LIKE).
-- All DATETIME values are UTC; the app sets time_zone = '+00:00' on every connection.

CREATE TABLE users (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  email                 VARCHAR(254) NOT NULL,
  password_hash         VARCHAR(255) NULL,          -- NULL until the invite is accepted
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  role                  VARCHAR(10)  NOT NULL,
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  failed_login_count    INT          NOT NULL DEFAULT 0,
  first_failed_login_at DATETIME(3)  NULL,
  locked_until          DATETIME(3)  NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY users_email_key (email),
  CONSTRAINT users_email_lowercase CHECK (email = LOWER(email)),
  CONSTRAINT users_role_check CHECK (role IN ('admin', 'staff'))
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

-- Single-use invite and password-reset tokens. Only a SHA-256 hash is stored.
CREATE TABLE user_tokens (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT         NOT NULL,
  purpose    VARCHAR(10) NOT NULL,
  token_hash CHAR(64)    NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY user_tokens_token_hash_key (token_hash),
  CONSTRAINT user_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_tokens_purpose_check CHECK (purpose IN ('invite', 'reset'))
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

-- Server-side sessions, read and written by src/db/session-store.js.
CREATE TABLE session (
  sid    VARCHAR(255) NOT NULL PRIMARY KEY,
  sess   JSON         NOT NULL,
  expire DATETIME(3)  NOT NULL,
  KEY session_expire_idx (expire)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

-- The agency or survey a dataset comes from. Names are unique ignoring case, so
-- 'U.S. Census Bureau' and 'u.s. census bureau' are one source.
CREATE TABLE sources (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(300) NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY sources_name_lower_idx ((LOWER(name))),
  CONSTRAINT sources_name_trimmed CHECK (name = TRIM(name) AND name <> '')
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

CREATE TABLE datasets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,             -- 'ACS 5-Year Town Profile'
  source_id   INT          NOT NULL,
  vintage     VARCHAR(50)  NOT NULL,             -- '2024'
  version     INT          NOT NULL,
  row_count   INT          NOT NULL,
  uploaded_by INT          NOT NULL,
  uploaded_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_active   BOOLEAN      NOT NULL DEFAULT FALSE,
  UNIQUE KEY datasets_name_vintage_version_key (name, vintage, version),
  -- At most one active version per dataset name and vintage. MySQL has no partial
  -- indexes, so the third key part is 1 for the active row and NULL otherwise;
  -- NULLs never collide in a unique index.
  UNIQUE KEY datasets_one_active_idx (name, vintage, (IF(is_active, 1, NULL))),
  KEY datasets_source_id_idx (source_id),
  CONSTRAINT datasets_source_fk FOREIGN KEY (source_id) REFERENCES sources (id),
  CONSTRAINT datasets_uploaded_by_fk FOREIGN KEY (uploaded_by) REFERENCES users (id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

-- 169 towns plus one ('Connecticut', 'state') row, so the benchmark is never mistaken for a town.
CREATE TABLE towns (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(100)  NOT NULL,
  geo_type     VARCHAR(10)   NOT NULL,
  square_miles DECIMAL(10,2) NULL,
  UNIQUE KEY towns_name_geo_type_key (name, geo_type),
  CONSTRAINT towns_geo_type_check CHECK (geo_type IN ('town', 'state'))
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

CREATE TABLE indicators (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  `key`           VARCHAR(60)  NOT NULL,         -- matches the CSV column, lowercased
  label           VARCHAR(120) NOT NULL,
  unit            VARCHAR(10)  NOT NULL,
  decimals        SMALLINT     NOT NULL DEFAULT 0,
  derivation      VARCHAR(10)  NOT NULL DEFAULT 'direct',
  numerator_key   VARCHAR(60)  NULL,             -- ratio indicators only, e.g. poverty rate
  denominator_key VARCHAR(60)  NULL,
  UNIQUE KEY indicators_key_key (`key`),
  CONSTRAINT indicators_key_format CHECK (REGEXP_LIKE(`key`, '^[a-z0-9_]+$', 'c')),
  CONSTRAINT indicators_unit_check CHECK (unit IN ('count', 'currency', 'percent', 'density', 'area')),
  CONSTRAINT indicators_decimals_check CHECK (decimals BETWEEN 0 AND 4),
  CONSTRAINT indicators_derivation_check CHECK (derivation IN ('direct', 'ratio')),
  CONSTRAINT indicators_ratio_parts CHECK (derivation = 'direct' OR (numerator_key IS NOT NULL AND denominator_key IS NOT NULL))
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

CREATE TABLE observations (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  dataset_id   INT           NOT NULL,
  indicator_id INT           NOT NULL,
  town_id      INT           NOT NULL,
  value        DECIMAL(18,4) NOT NULL,
  UNIQUE KEY observations_dataset_indicator_town_key (dataset_id, indicator_id, town_id),
  KEY observations_dataset_town_idx (dataset_id, town_id),
  CONSTRAINT observations_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets (id),
  CONSTRAINT observations_indicator_fk FOREIGN KEY (indicator_id) REFERENCES indicators (id),
  CONSTRAINT observations_town_fk FOREIGN KEY (town_id) REFERENCES towns (id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;

CREATE TABLE reports (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(200) NOT NULL,
  selection  JSON         NOT NULL,              -- towns, benchmark, indicators, title, layout (SRS §5.4)
  created_by INT          NOT NULL,
  dataset_id INT          NOT NULL,              -- the version active when last saved
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY reports_updated_at_idx (updated_at DESC),
  CONSTRAINT reports_created_by_fk FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT reports_dataset_fk FOREIGN KEY (dataset_id) REFERENCES datasets (id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_cs;
