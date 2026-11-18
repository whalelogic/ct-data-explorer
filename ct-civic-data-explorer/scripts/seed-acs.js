#!/usr/bin/env node
/**
 * Load the ACS sample or the full starter catalog as public datasets.
 * Usage: npm run seed [-- path/to/file.csv] or npm run seed:samples
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import * as users from '../src/repositories/users.js';
import {
  getDatasetCuration,
  listDatasets,
  setDatasetActive,
  updateDatasetCuration,
  uploadDataset,
} from '../src/services/datasets.service.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sampleDirectory = path.resolve(scriptDirectory, '../../sample-data');
const profilesDirectory = path.join(sampleDirectory, 'Housing and Town Profiles/Housing and Town Profiles/Town Profiles');
const acs = {
  file: path.join(sampleDirectory, 'acs2024_sample.csv'),
  name: 'ACS 5-Year Town Profile',
  source: 'U.S. Census Bureau, American Community Survey 5-Year Estimates',
  vintage: '2024',
};
const profiles = [
  { name: 'Industry Jobs', vintage: '2026', fields: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
  { name: 'Key Employers', vintage: '2026', fields: ['c0', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'] },
  { name: 'Population Within 45 Minutes', vintage: '2024 (2026 profiles)', fields: ['c1'] },
].map(({ name, vintage, fields }) => {
  const workbook = `FINAL Town Profiles 2026 - ${name}.xlsx`;
  return { name, vintage, fields, file: path.join(profilesDirectory, workbook), source: `Provided workbook: ${workbook}` };
});

async function publishSample(sample, admin) {
  const dataset = await uploadDataset({
    file: await fs.readFile(sample.file),
    filename: path.basename(sample.file),
    name: sample.name,
    source: sample.source,
    vintage: sample.vintage,
    activate: false,
  }, admin);

  const fields = sample.fields ?? (await getDatasetCuration(dataset.id, admin)).fields.map(({ key }) => key);
  await updateDatasetCuration(dataset.id, fields, admin);
  await setDatasetActive(dataset.id, true);
  console.log(`Loaded ${dataset.name} ${dataset.vintage} version ${dataset.version} (${dataset.row_count} rows).`);
}

try {
  const allUsers = await users.list();
  const admin = allUsers.find((user) => user.role === 'admin' && user.is_active);
  if (!admin) {
    throw new Error('Create an administrator with npm run create-admin before seeding sample data.');
  }

  const requested = process.argv[2];
  if (requested === '--samples') {
    const existing = await listDatasets({ activeOnly: false, scope: 'public' });
    for (const sample of [acs, ...profiles]) {
      const versions = existing.filter(({ name, vintage }) => name === sample.name && vintage === sample.vintage);
      if (versions.some(({ is_active }) => is_active)) {
        console.log(`Already published: ${sample.name} (${sample.vintage}).`);
      } else if (versions.length) {
        throw new Error(`An unpublished version of ${sample.name} (${sample.vintage}) exists. Review and publish it before rerunning the starter seed.`);
      } else {
        await publishSample(sample, admin);
      }
    }
  } else {
    await publishSample({ ...acs, file: requested ?? acs.file }, admin);
  }
} catch (error) {
  console.error(error.message);
  if (Array.isArray(error.details)) {
    console.error(error.details.join('\n'));
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
