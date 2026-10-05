/**
 * Dataset CSV validation (SRS US003). Pure: callers pass in the known towns and
 * indicators, which keeps this unit-testable without a database.
 */
import { parse } from 'csv-parse/sync';

const MAX_REPORTED_PROBLEMS = 200;
const NUMBER = /^-?\d+(\.\d+)?$/;
const MAX_ABS_VALUE = 1e14; // observations.value is NUMERIC(18,4)

/**
 * Validate an uploaded dataset. Every problem is collected so the uploader sees
 * them all at once; if there are any, no observations are returned and nothing
 * should be saved. Row numbers are spreadsheet rows (the header is row 1).
 *
 * Expected shape: a `town` column plus one column per direct indicator key
 * (case-insensitive). Blank cells mean "not available" and are skipped.
 *
 * @param {Buffer | string} input
 * @param {{ towns: {id: number, name: string}[], indicators: {id: number, key: string, derivation: string}[] }} known
 * @returns {{ problems: string[], problemCount: number, observations: {townId: number, indicatorId: number, value: number}[], rowCount: number }}
 */
export function validateDatasetCsv(input, { towns, indicators }) {
  let records;
  try {
    records = parse(input, { bom: true, info: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) {
    return result([`The file could not be read as CSV: ${err.message}`]);
  }
  return validateDatasetRecords(records, { towns, indicators });
}

/** Both file formats use the same validation, with original row numbers retained. */
export function validateDatasetRecords(records, { towns, indicators }) {
  if (records.length === 0) return result(['The file is empty']);

  const problems = [];
  const header = records[0].record;
  const keys = header.map((h) => h.toLowerCase());
  const townColumn = keys.indexOf('town');
  if (townColumn === -1) problems.push('Missing required column "town"');

  const indicatorByKey = new Map(indicators.map((i) => [i.key, i]));
  const columns = [];
  const seen = new Set();
  keys.forEach((key, index) => {
    if (index === townColumn) return;
    const name = header[index];
    if (key === '') return problems.push(`Column ${index + 1} has no name`);
    if (seen.has(key)) return problems.push(`Column "${name}" appears more than once`);
    seen.add(key);
    const indicator = indicatorByKey.get(key);
    if (!indicator) {
      problems.push(`Column "${name}" is not a defined indicator. Define it in the upload form before uploading.`);
    } else if (indicator.derivation !== 'direct') {
      problems.push(`Column "${name}" is computed by the system and must not be uploaded`);
    } else {
      columns.push({ index, name, indicator });
    }
  });

  const dataRows = records.slice(1);
  if (dataRows.length === 0) problems.push('The file has no data rows');
  if (columns.length === 0 && problems.length === 0) problems.push('The file has no indicator columns');
  if (townColumn === -1) return result(problems, dataRows.length);

  const townByName = new Map(towns.map((t) => [t.name.toLowerCase(), t]));
  const firstRowForTown = new Map();
  const observations = [];

  for (const { record: cells, info } of dataRows) {
    const row = info.lines;
    if (cells.length !== header.length) {
      problems.push(`Row ${row}: expected ${header.length} values but found ${cells.length}`);
      continue;
    }
    const townName = cells[townColumn];
    const town = townByName.get(townName.toLowerCase());
    if (!townName) {
      problems.push(`Row ${row}: town is blank`);
    } else if (!town) {
      problems.push(`Row ${row}: town "${townName}" does not match any Connecticut town`);
    } else if (firstRowForTown.has(town.id)) {
      problems.push(`Row ${row}: town "${townName}" already appears on row ${firstRowForTown.get(town.id)}`);
    } else {
      firstRowForTown.set(town.id, row);
    }

    for (const { index, name, indicator } of columns) {
      const raw = cells[index];
      if (raw === '') continue;
      const normalized = raw.replaceAll(',', '');
      const value = Number(normalized);
      if (!NUMBER.test(normalized) || Math.abs(value) >= MAX_ABS_VALUE) {
        problems.push(`Row ${row}: ${name} value "${raw}" is not a number`);
        continue;
      }
      if (town) observations.push({ townId: town.id, indicatorId: indicator.id, value });
    }
  }

  return result(problems, dataRows.length, observations);
}

function result(problems, rowCount = 0, observations = []) {
  const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
  if (problems.length > shown.length) shown.push(`…and ${problems.length - shown.length} more problems`);
  return {
    problems: shown,
    problemCount: problems.length,
    observations: problems.length > 0 ? [] : observations,
    rowCount,
  };
}
