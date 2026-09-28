/** Dataset upload and versioning (SRS US003). */
import { withTransaction } from '../db/pool.js';
import { HttpError } from '../lib/http-error.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as sources from '../repositories/sources.js';
import * as towns from '../repositories/towns.js';
import { validateDatasetCsv } from './csv-validation.js';

export function listDatasets({ activeOnly }) {
  return datasets.list({ activeOnly });
}

/**
 * Validate and store a CSV as a new version of name + vintage. A file with any
 * problem is rejected whole; nothing is written.
 */
export async function uploadDataset({ file, name, source, vintage, activate }, user) {
  const [allTowns, allIndicators] = await Promise.all([towns.list(), indicators.list()]);
  const checked = validateDatasetCsv(file, { towns: allTowns, indicators: allIndicators });
  if (checked.problemCount > 0) {
    const noun = checked.problemCount === 1 ? 'problem' : 'problems';
    throw new HttpError(422, `Upload rejected: ${checked.problemCount} ${noun} found. Nothing was saved.`, checked.problems);
  }

  return withTransaction(async (client) => {
    await datasets.lockNameVintage(name, vintage, client);
    const version = await datasets.nextVersion(name, vintage, client);
    const sourceId = await sources.findOrCreate(source, client);
    const { id } = await datasets.insert(
      { name, sourceId, vintage, version, rowCount: checked.rowCount, uploadedBy: user.id },
      client,
    );
    await observations.insertMany(id, checked.observations, client);
    if (activate) await datasets.setActive(id, true, client);
    return datasets.findById(id, client);
  });
}

/** Versions are deactivated rather than deleted, so saved cards keep working. */
export async function setDatasetActive(id, isActive) {
  return withTransaction(async (client) => {
    if (!(await datasets.setActive(id, isActive, client))) throw new HttpError(404, 'Dataset not found');
    return datasets.findById(id, client);
  });
}
