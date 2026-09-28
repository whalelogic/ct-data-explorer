-- Core schema (SRS §5.3). Values are stored in long format (observations), so a
-- new dataset or indicator is an insert, never a schema change.

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash         TEXT,                -- NULL until the invite is accepted
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  first_failed_login_at TIMESTAMPTZ,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-use invite and password-reset tokens. Only a SHA-256 hash is stored.
CREATE TABLE user_tokens (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side sessions (the table shape connect-pg-simple expects).
CREATE TABLE session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

CREATE TABLE datasets (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,                 -- 'ACS 5-Year Town Profile'
  source      TEXT NOT NULL,                 -- 'U.S. Census Bureau, ACS'
  vintage     TEXT NOT NULL,                 -- '2024'
  version     INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (name, vintage, version)
);
-- At most one active version per dataset name and vintage.
CREATE UNIQUE INDEX datasets_one_active_idx ON datasets (name, vintage) WHERE is_active;

-- 169 towns plus one ('Connecticut', 'state') row, so the benchmark is never mistaken for a town.
CREATE TABLE towns (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  geo_type     TEXT NOT NULL CHECK (geo_type IN ('town', 'state')),
  square_miles NUMERIC(10,2),
  UNIQUE (name, geo_type)
);

CREATE TABLE indicators (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9_]+$'),  -- matches the CSV column, lowercased
  label           TEXT NOT NULL,
  unit            TEXT NOT NULL CHECK (unit IN ('count', 'currency', 'percent', 'density', 'area')),
  decimals        SMALLINT NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 4),
  derivation      TEXT NOT NULL DEFAULT 'direct' CHECK (derivation IN ('direct', 'ratio')),
  numerator_key   TEXT,                      -- ratio indicators only, e.g. poverty rate
  denominator_key TEXT,
  CHECK (derivation = 'direct' OR (numerator_key IS NOT NULL AND denominator_key IS NOT NULL))
);

CREATE TABLE observations (
  id           SERIAL PRIMARY KEY,
  dataset_id   INTEGER NOT NULL REFERENCES datasets(id),
  indicator_id INTEGER NOT NULL REFERENCES indicators(id),
  town_id      INTEGER NOT NULL REFERENCES towns(id),
  value        NUMERIC(18,4) NOT NULL,
  UNIQUE (dataset_id, indicator_id, town_id)
);
CREATE INDEX observations_dataset_town_idx ON observations (dataset_id, town_id);

CREATE TABLE cards (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  selection  JSONB NOT NULL,                 -- towns, indicators, blocks, chart type (SRS §5.4)
  created_by INTEGER NOT NULL REFERENCES users(id),
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),  -- the version active when last saved
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cards_updated_at_idx ON cards (updated_at DESC);
