#!/usr/bin/env node
/**
 * Load the ACS 2024 sample extract as an active dataset version, uploaded by the
 * first active admin. Each run creates a new version (uploads never overwrite).
 * Usage: npm run seed [-- path/to/file.csv]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import * as users from '../src/repositories/users.js';
import { uploadDataset } from '../src/services/datasets.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.resolve(here, '../../sample-data/acs2024_sample.csv');

try {
  const admin = (await users.list()).find((u) => u.role === 'admin' && u.is_active);
  if (!admin) throw new Error('No admin exists yet. Run: npm run create-admin -- --email ... --first ... --last ...');

  const dataset = await uploadDataset(
    {
      file: await fs.readFile(file),
      name: 'ACS 5-Year Town Profile',
      source: 'U.S. Census Bureau, American Community Survey 5-Year Estimates',
      vintage: '2024',
      activate: true,
    },
    admin,
  );
  console.log(`Loaded ${dataset.name} ${dataset.vintage} version ${dataset.version} (${dataset.row_count} rows) and activated it.`);
} catch (err) {
  console.error(err.message);
  if (Array.isArray(err.details)) console.error(err.details.join('\n'));
  process.exitCode = 1;
} finally {
  await pool.end();
}
