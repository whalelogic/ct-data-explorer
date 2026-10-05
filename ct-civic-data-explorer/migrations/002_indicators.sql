-- Indicator definitions for the ACS 2024 sample extract columns, plus the derived
-- poverty rate. Keys are the lowercased CSV column names. Poverty rate is computed
-- from its components at read time and is never uploaded or stored.
INSERT INTO indicators (`key`, label, unit, decimals, derivation, numerator_key, denominator_key) VALUES
  ('pop',                'Population',                                        'count',    0, 'direct', NULL, NULL),
  ('households',         'Households',                                        'count',    0, 'direct', NULL, NULL),
  ('medhouseholdincome', 'Median Household Income',                           'currency', 0, 'direct', NULL, NULL),
  ('povnumerator',       'Population Below Poverty Level',                    'count',    0, 'direct', NULL, NULL),
  ('povdenominator',     'Population for Whom Poverty Status Is Determined',  'count',    0, 'direct', NULL, NULL),
  ('poverty_rate',       'Poverty Rate',                                      'percent',  1, 'ratio',  'povnumerator', 'povdenominator'),
  ('squaremiles',        'Land Area',                                         'area',     2, 'direct', NULL, NULL),
  ('poppersqmi',         'Population Density',                                'density',  1, 'direct', NULL, NULL);
