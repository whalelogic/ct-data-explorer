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
import { getDatasetCuration, setDatasetActive, updateDatasetCuration, uploadDataset } from '../src/services/datasets.service.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const inputFilePath = process.argv[2] ?? path.resolve(scriptDirectory, '../../sample-data/acs2024_sample.csv');

try {
  const allUsers = await users.list();
  const admin = allUsers.find((user) => user.role === 'admin' && user.is_active);
  if (!admin) {
    throw new Error('No admin exists yet. Run: npm run create-admin -- --email ... --first ... --last ...');
  }

  const fileContents = await fs.readFile(inputFilePath);
  const dataset = await uploadDataset(
    {
      file: fileContents,
      name: 'ACS 5-Year Town Profile',
      source: 'U.S. Census Bureau, American Community Survey 5-Year Estimates',
      vintage: '2024',
      activate: false,
    },
    admin,
  );
  // Running the sample seed explicitly approves its fields as the selected local admin.
  const curation = await getDatasetCuration(dataset.id, admin);
  const fieldKeys = curation.fields.map((field) => field.key);
  await updateDatasetCuration(dataset.id, fieldKeys, admin);
  await setDatasetActive(dataset.id, true);
  console.log(`Loaded ${dataset.name} ${dataset.vintage} version ${dataset.version} (${dataset.row_count} rows), approved its fields and activated it.`);
} catch (error) {
  console.error(error.message);
  if (Array.isArray(error.details)) {
    console.error(error.details.join('\n'));
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
