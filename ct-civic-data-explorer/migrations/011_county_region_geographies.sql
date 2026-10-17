-- Town-keyed files often include county or planning-region summary rows beside their
-- towns (e.g. "Fairfield County"). Those names rejected the whole upload because only the
-- 169 towns and the statewide row were known. Record Connecticut's 8 counties and its
-- 9 planning regions (the county-equivalents the Census Bureau has used since 2022) so
-- such rows are matched and kept as their own rows. They are never summed with towns.
-- Land area is left NULL rather than estimated.
ALTER TABLE towns DROP CHECK towns_geo_type_check;
ALTER TABLE towns
  ADD CONSTRAINT towns_geo_type_check CHECK (geo_type IN ('town', 'county', 'region', 'state'));

INSERT INTO towns (name, geo_type, square_miles) VALUES
  ('Fairfield County', 'county', NULL),
  ('Hartford County', 'county', NULL),
  ('Litchfield County', 'county', NULL),
  ('Middlesex County', 'county', NULL),
  ('New Haven County', 'county', NULL),
  ('New London County', 'county', NULL),
  ('Tolland County', 'county', NULL),
  ('Windham County', 'county', NULL),
  ('Capitol Planning Region', 'region', NULL),
  ('Greater Bridgeport Planning Region', 'region', NULL),
  ('Lower Connecticut River Valley Planning Region', 'region', NULL),
  ('Naugatuck Valley Planning Region', 'region', NULL),
  ('Northeastern Connecticut Planning Region', 'region', NULL),
  ('Northwest Hills Planning Region', 'region', NULL),
  ('South Central Connecticut Planning Region', 'region', NULL),
  ('Southeastern Connecticut Planning Region', 'region', NULL),
  ('Western Connecticut Planning Region', 'region', NULL)
AS incoming
ON DUPLICATE KEY UPDATE name = incoming.name;
