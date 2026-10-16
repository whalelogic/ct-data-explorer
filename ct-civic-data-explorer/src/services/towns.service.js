/** Town browsing (SRS US004): every indicator held for a town, with the statewide comparison. */
import { HttpError } from '../lib/http-error.js';
import { formatValue } from '../shared/format.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as towns from '../repositories/towns.js';
import { computeValue } from './compute.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';
import { applyFieldPresentation } from './presentation.js';
import { approvedDefinitions, datasetIndicators } from './field-curation.js';

export function listTowns() {
  return towns.list();
}

export async function getTownProfile(townId) {
  const town = await towns.findById(townId);
  if (!town) {
    throw new HttpError(404, 'Town not found');
  }

  const [state, activeDatasets, allIndicators] = await Promise.all([
    towns.findState(),
    datasets.list({ activeOnly: true }),
    indicators.list(),
  ]);
  const compareToState = state && state.id !== town.id;
  const comparisonState = compareToState ? state : null;
  const sectionPromises = [];
  for (const dataset of activeDatasets) {
    if (dataset.data_format !== 'records') {
      sectionPromises.push(buildDatasetSection(dataset, allIndicators, town, comparisonState));
    }
  }
  const sections = await Promise.all(sectionPromises);

  return {
    town: presentPlace(town),
    state: compareToState ? presentPlace(state) : null,
    datasets: sections.filter((section) => section.indicators.length > 0),
  };
}

async function buildDatasetSection(dataset, allIndicators, town, comparisonState) {
  const placeIds = comparisonState ? [town.id, comparisonState.id] : [town.id];
  const [valuesByPlace, indicatorKeys] = await Promise.all([
    observations.valuesByTown(dataset.id, placeIds),
    observations.indicatorKeys(dataset.id),
  ]);
  const availableIndicators = datasetIndicators(allIndicators, indicatorKeys);
  const approvedIndicators = applyFieldPresentation(approvedDefinitions(availableIndicators, dataset.approved_fields), dataset.presentation);
  const rows = [];

  for (const indicator of approvedIndicators) {
    const townValue = computeValue(indicator, valuesByPlace.get(town.id));
    let stateValue = null;
    let stateCell = null;
    if (comparisonState) {
      stateValue = computeValue(indicator, valuesByPlace.get(comparisonState.id));
      stateCell = { value: stateValue, display: formatValue(stateValue, indicator) };
    }
    if (townValue == null && stateValue == null) {
      continue;
    }
    rows.push({
      ...presentIndicator(indicator),
      town: { value: townValue, display: formatValue(townValue, indicator) },
      state: stateCell,
    });
  }

  return { dataset: presentDataset(dataset), indicators: rows };
}
