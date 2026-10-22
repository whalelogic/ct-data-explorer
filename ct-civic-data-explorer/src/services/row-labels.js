/**
 * Which column names a dataset's rows. Town-keyed datasets label rows with the matched
 * Connecticut town (and may offer a statewide figure); every other dataset labels rows with
 * the value of a chosen column, such as an industry, program or record ID.
 *
 * Indicator-format datasets (the `observations` table) are always town-keyed.
 *
 * A report may compare rows by a different column than the dataset's default (for
 * example Sector instead of Town); see `reportRowLabel`.
 */
import { HttpError } from '../lib/http-error.js';

/** Place types a town column can hold, as people say them. The statewide row is a benchmark. */
export const PLACE_GROUPS = Object.freeze({
  town: { label: 'Towns', noun: 'town' },
  county: { label: 'Counties', noun: 'county' },
  region: { label: 'Planning regions', noun: 'planning region' },
});

/** @returns {{ key: string, label: string, role: string } | null} */
export function rowLabelColumn(dataset) {
  const columns = dataset.column_definitions ?? dataset.columns ?? [];
  const chosenKey = dataset.row_label_key ?? dataset.rowLabelKey;
  return columns.find((column) => column.key === chosenKey)
    ?? columns.find((column) => column.role === 'town')
    ?? columns.find((column) => column.role === 'label')
    ?? null;
}

export function isTownKeyed(dataset) {
  const format = dataset.data_format ?? dataset.dataFormat;
  if (format !== 'records') {
    return true;
  }
  return rowLabelColumn(dataset)?.role === 'town';
}

/** What a row is called in the interface, e.g. "Town" or "Industry". */
export function rowNoun(dataset) {
  if (isTownKeyed(dataset)) {
    return 'Town';
  }
  return rowLabelColumn(dataset)?.label ?? 'Row';
}

/**
 * The display name of one stored source row. Rows with a blank label keep their
 * spreadsheet row number, so they stay distinguishable.
 */
export function recordRowName(record, labelColumn, townKeyed) {
  if (townKeyed && record.town_name) {
    return record.town_name;
  }
  const value = labelColumn ? record.cell_values?.[labelColumn.key] : null;
  if (value == null || String(value).trim() === '') {
    return `Row ${record.source_row}`;
  }
  return String(value).trim();
}

/** Columns that may label rows: the town column, the upload's label column, or an approved text field. */
export function rowLabelCandidates(dataset) {
  const columns = dataset.column_definitions ?? dataset.columns ?? [];
  const approvedKeys = dataset.approved_fields !== undefined ? dataset.approved_fields : dataset.approvedFields;
  const approved = approvedKeys == null ? null : new Set(approvedKeys);
  return columns.filter((column) => {
    if (column.role === 'town' || column.role === 'label') {
      return true;
    }
    return column.type === 'text' && (approved === null || approved.has(column.key));
  });
}

/** Plural nouns for places that share one geography type. */
const PLACE_NOUNS = { town: 'towns', county: 'counties', region: 'planning regions' };

/**
 * A default report title for town-keyed places, e.g. "Hartford and New Haven" or
 * "12 Connecticut towns". The statewide row is a benchmark and is not named. Mixed
 * geographies (towns with counties) are counted as "places".
 * @param {{ name: string, geoType: string }[]} places
 */
export function describePlaces(places, allRows = false) {
  const local = places.filter((place) => place.geoType !== 'state');
  const names = [...new Set(local.map((place) => place.name))];
  const types = new Set(local.map((place) => place.geoType));
  const noun = types.size === 1 ? PLACE_NOUNS[[...types][0]] ?? 'places' : 'places';
  if (allRows) {
    return `All Connecticut ${local.length ? noun : 'towns'}`;
  }
  if (names.length <= 1) {
    return names[0] ?? 'Connecticut';
  }
  if (names.length > 3) {
    return `${names.length} Connecticut ${noun}`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** County and planning-region rows summarize towns, so they are shown beside towns, never ranked with them. */
export function isSummaryGeography(geoType) {
  return geoType === 'county' || geoType === 'region';
}

/**
 * The column one report compares rows by. `compareBy` is a column key chosen in the report
 * builder; place groups (town, county, region) and an empty value use the dataset default.
 * Only identifier columns and approved text fields qualify, so a report can never reveal
 * an unapproved column through its row names.
 * @returns {{ labelColumn: object | null, townKeyed: boolean }}
 */
export function reportRowLabel(dataset, compareBy) {
  if (!/^c\d+$/.test(compareBy ?? '')) {
    return { labelColumn: rowLabelColumn(dataset), townKeyed: dataset.townKeyed ?? isTownKeyed(dataset) };
  }
  const column = rowLabelCandidates(dataset).find((candidate) => candidate.key === compareBy);
  if (!column) {
    throw new HttpError(400, 'This report compares by a column the dataset no longer offers. Choose what to compare again.');
  }
  return { labelColumn: column, townKeyed: column.role === 'town' };
}

/**
 * How a summary benchmark is labelled: "Connecticut, all 169 towns" for places, or
 * "Whole dataset, all 12 rows" for anything else.
 */
export function benchmarkWording(count, noun, isPlace) {
  const plural = count === 1 ? noun : (/[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`);
  const label = isPlace ? `Connecticut, all ${count.toLocaleString('en-US')} ${plural}` : `Whole dataset, all ${count.toLocaleString('en-US')} ${plural}`;
  return { label, rowNoun: noun, isPlace };
}
