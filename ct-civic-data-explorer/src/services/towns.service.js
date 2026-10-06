/** Town browsing (SRS US004): every indicator held for a town, with the statewide comparison. */
import { HttpError } from '../lib/http-error.js';
import { formatValue } from '../shared/format.js';
import * as datasets from '../repositories/datasets.js';
import * as indicators from '../repositories/indicators.js';
import * as observations from '../repositories/observations.js';
import * as towns from '../repositories/towns.js';
import { computeValue } from './compute.js';
import { presentDataset, presentIndicator, presentPlace } from './presenters.js';

export function listTowns() {
  return towns.list();
}

export async function getTownProfile(townId) {
  const town = await towns.findById(townId);
  if (!town) throw new HttpError(404, 'Town not found');

  const [state, activeDatasets, allIndicators] = await Promise.all([
    towns.findState(),
    datasets.list({ activeOnly: true }),
    indicators.list(),
  ]);
  const compareToState = state && state.id !== town.id;
  const placeIds = compareToState ? [town.id, state.id] : [town.id];

  const sections = await Promise.all(
    activeDatasets.map(async (dataset) => {
      const raw = await observations.valuesByTown(dataset.id, placeIds);
      const rows = allIndicators
        .map((indicator) => {
          const townValue = computeValue(indicator, raw.get(town.id));
          const stateValue = compareToState ? computeValue(indicator, raw.get(state.id)) : null;
          return {
            ...presentIndicator(indicator),
            town: { value: townValue, display: formatValue(townValue, indicator) },
            state: compareToState ? { value: stateValue, display: formatValue(stateValue, indicator) } : null,
          };
        })
        .filter((row) => row.town.value != null || row.state?.value != null);
      return { dataset: presentDataset(dataset), indicators: rows };
    }),
  );

  return {
    town: presentPlace(town),
    state: compareToState ? presentPlace(state) : null,
    datasets: sections.filter((s) => s.indicators.length > 0),
  };
}
