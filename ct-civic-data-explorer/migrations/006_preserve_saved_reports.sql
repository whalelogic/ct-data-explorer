-- Upgrade installations created before the cards-to-reports rename on main.
-- Fresh databases already have reports from 001_schema.sql and need no change.
-- RENAME preserves rows, IDs, indexes and foreign keys. If both tables exist,
-- MySQL refuses the rename rather than overwriting either table.
SET @report_table_upgrade = IF(
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = 'cards'
  ),
  'RENAME TABLE cards TO reports',
  'SELECT 1'
);
PREPARE report_table_upgrade FROM @report_table_upgrade;
EXECUTE report_table_upgrade;
DEALLOCATE PREPARE report_table_upgrade;
