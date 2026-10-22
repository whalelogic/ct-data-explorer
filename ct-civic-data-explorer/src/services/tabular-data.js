/**
 * Preserve the file's grain: each source row stays a separate record.
 *
 * One column labels the rows. When that column holds Connecticut towns, each row is
 * matched to its town (unmatched names reject the upload, as before). Otherwise the
 * column's values are the row labels, for data organized by industry, program or record.
 */
import { NUMBER, validateDatasetRecords } from './csv-validation.js';

const numeric = (value) => NUMBER.test(value.replaceAll(',', '')) && Number.isFinite(Number(value.replaceAll(',', '')));
/** Share of a column's values that must name a town before it is suggested as a town column. */
const TOWN_MATCH_SHARE = 0.8;
/** Rows shown on the upload page while choosing what each row describes. */
const PREVIEW_ROW_COUNT = 5;

function townLookup(towns) {
  const byName = new Map(towns.map((town) => [town.name.toLowerCase(), town]));
  return (name) => {
    const trimmed = (name ?? '').trim();
    const baseName = trimmed.replace(/\s+\([^)]*\)$/, '');
    return byName.get(trimmed.toLowerCase()) ?? byName.get(baseName.toLowerCase()) ?? null;
  };
}

/**
 * Describe each column of an uploaded file so staff can choose the row label column.
 * Nothing is saved.
 */
export function inspectTabularColumns(records, known) {
  if (records.length < 2) {
    return { columns: [], suggested: null, rowCount: 0, problems: ['The file needs a header row and at least one data row.'] };
  }
  const header = records[0].record;
  const data = records.slice(1).filter((row) => row.record.some((cell) => cell !== ''));
  const findTown = townLookup(known.towns);
  const columns = [];
  for (const [index, rawLabel] of header.entries()) {
    const label = (rawLabel ?? '').trim();
    const values = data.map((row) => (row.record[index] ?? '').trim()).filter((value) => value !== '');
    if (!label && values.length === 0) {
      continue;
    }
    const townMatches = values.filter((value) => findTown(value)).length;
    const distinctCount = new Set(values).size;
    columns.push({
      index,
      label: label || `Unnamed column ${index + 1}`,
      isNumeric: values.length > 0 && values.every(numeric),
      townShare: values.length ? townMatches / values.length : 0,
      distinctCount,
      blankCount: data.length - values.length,
      samples: [...new Set(values)].slice(0, 4),
    });
  }

  // Prefer a column named Town, then the column that best matches towns, then the first text column.
  const named = columns.find((column) => column.label.toLowerCase() === 'town');
  const bestTownMatch = [...columns].sort((first, second) => second.townShare - first.townShare)[0];
  let suggested;
  if (named) {
    suggested = { label: named.label, isTown: named.townShare >= TOWN_MATCH_SHARE || named.townShare === 0 };
  } else if (bestTownMatch && bestTownMatch.townShare >= TOWN_MATCH_SHARE) {
    suggested = { label: bestTownMatch.label, isTown: true };
  } else {
    const firstText = columns.find((column) => !column.isNumeric);
    suggested = firstText ? { label: firstText.label, isTown: false } : null;
  }
  // A few rows, cell by cell in file order, so staff can see what a row is before choosing.
  const previewRows = data.slice(0, PREVIEW_ROW_COUNT).map((row) => columns.map((column) => (row.record[column.index] ?? '').trim()));
  return { columns, suggested, rowCount: data.length, previewRows, problems: [] };
}

/**
 * @param {{ record: string[], info: { lines: number } }[]} records parsed file rows, header first
 * @param {{ towns: object[], indicators: object[] }} known
 * @param {{ labelColumn?: string, labelIsTown?: boolean }} [options] labelColumn is a header;
 *   without it a single "Town" column is used, as in earlier versions
 */
export function prepareTabularDataset(records, known, { labelColumn, labelIsTown } = {}) {
  const problems = [];
  const notes = [];
  const fail = () => ({ problems: problems.slice(0, 200), problemCount: problems.length, rows: [], observations: [] });
  if (records.length < 2) { problems.push('The file needs a header row and at least one data row.'); return fail(); }
  const header = records[0].record;
  const data = records.slice(1).filter((row) => row.record.some((cell) => cell !== ''));
  if (!data.length) { problems.push('The file has no data rows.'); return fail(); }
  const width = Math.max(header.length, ...data.map((row) => row.record.length));
  if (width > 100 || data.length > 10000) { problems.push('Use at most 100 columns and 10,000 data rows.'); return fail(); }

  let labelIndex;
  let townKeyed;
  if (labelColumn) {
    const wanted = labelColumn.trim().toLowerCase();
    const matches = header.flatMap((label, i) => {
      const heading = (label ?? '').trim().toLowerCase() || `unnamed column ${i + 1}`;
      return heading === wanted ? [i] : [];
    });
    if (matches.length !== 1) {
      problems.push(`Choose a row label column that appears exactly once in the file; "${labelColumn}" was not found.`);
      return fail();
    }
    labelIndex = matches[0];
    townKeyed = labelIsTown ?? true;
  } else {
    const townIndexes = header.flatMap((label, i) => label.trim().toLowerCase() === 'town' ? [i] : []);
    if (townIndexes.length !== 1) {
      problems.push('Choose the column that identifies each row (for example Town, Industry or Program).');
      return fail();
    }
    labelIndex = townIndexes[0];
    townKeyed = labelIsTown ?? true;
  }
  const townIndex = labelIndex;
  const knownColumns = new Map(known.indicators.map((indicator) => [indicator.key, indicator]));
  const columns = [];
  const labels = new Set();
  for (let i = 0; i < width; i++) {
    const populated = data.map((row) => row.record[i] ?? '').filter((cell) => cell !== '');
    let label = (header[i] ?? '').trim();
    if (!label && !populated.length) continue; // Ignore entirely empty spreadsheet padding.
    if (!label) {
      label = `Unnamed column ${i + 1}`;
      notes.push(`${label} had values but no heading; its contents have been retained.`);
    }
    if (label.length > 200) problems.push(`Column ${i + 1}: the heading must be at most 200 characters.`);
    if (labels.has(label.toLowerCase())) problems.push(`Column heading "${label}" appears more than once.`);
    labels.add(label.toLowerCase());
    const definition = knownColumns.get(label.toLowerCase());
    const isNumber = i !== townIndex && (definition || (populated.length > 0 && populated.every(numeric)));
    const fraction = /(?:percentage|percent).*decimal/i.test(label);
    let role = isNumber ? 'measure' : 'dimension';
    if (i === townIndex) {
      role = townKeyed ? 'town' : 'label';
    }
    columns.push({ key: `c${i}`, index: i, label, type: isNumber ? 'number' : 'text', role,
      unit: definition?.unit ?? (fraction ? 'percent' : 'number'),
      scale: fraction ? 100 : 1, decimals: definition?.decimals ?? (fraction ? 1 : 9) });
  }
  const findTown = townLookup(known.towns);
  const counts = new Map();
  const matchedLabels = new Set();
  let blankLabels = 0;
  const summaryRows = new Set();
  const rows = data.map(({ record, info }) => {
    const name = (record[townIndex] ?? '').trim();
    let town = null;
    if (townKeyed) {
      town = findTown(name);
      if (town && name.toLowerCase() !== town.name.toLowerCase() && !matchedLabels.has(name)) {
        matchedLabels.add(name);
        notes.push(`Town label "${name}" matched to ${town.name}; the original label is retained.`);
      }
      if (!town) problems.push(`Row ${info.lines}: "${name}" does not match a Connecticut town, county or planning region.`);
      if (town) counts.set(town.id, (counts.get(town.id) ?? 0) + 1);
      if (town?.geo_type === 'county' || town?.geo_type === 'region') summaryRows.add(town.name);
    } else if (name === '') {
      blankLabels += 1;
    } else {
      counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
    }
    const cells = {};
    for (const column of columns) {
      const value = (record[column.index] ?? '').trim();
      if (value.length > 4000) problems.push(`Row ${info.lines}: ${column.label} exceeds 4,000 characters.`);
      if (column.type === 'number' && value !== '' && !numeric(value)) problems.push(`Row ${info.lines}: ${column.label} value "${value}" is not a number.`);
      cells[column.key] = value === '' ? null : column.type === 'number' && numeric(value) ? Number(value.replaceAll(',', '')) : value;
    }
    return { townId: town?.id ?? null, sourceRow: info.lines, cells };
  });
  if (problems.length) return fail();
  const labelColumnDefinition = columns.find((column) => column.index === townIndex);
  const repeated = [...counts.values()].filter((count) => count > 1).length;
  const rowNoun = townKeyed ? 'towns' : `${labelColumnDefinition.label} values`;
  if (repeated) notes.push(`${repeated} ${rowNoun} have multiple rows. Every source row is retained; repeated values are not automatically summed.`);
  if (summaryRows.size) {
    notes.push(`${summaryRows.size} county or planning region ${summaryRows.size === 1 ? 'label was' : 'labels were'} kept as ${summaryRows.size === 1 ? 'its own row' : 'their own rows'}; they are not added to or ranked against towns.`);
  }
  if (blankLabels) notes.push(`${blankLabels} rows have no ${labelColumnDefinition.label}; they are labeled by their spreadsheet row number.`);
  if (columns.some((column) => column.scale === 100)) notes.push('Decimal-format percentages are stored unchanged and displayed as percentages.');
  // Existing single-row town indicator datasets retain their current calculations and saved reports.
  const legacy = townKeyed ? validateDatasetRecords(records, known) : { problemCount: 1, observations: [] };
  return { problems: [], problemCount: 0, rows, columns, notes, rowCount: rows.length,
    rowLabelKey: labelColumnDefinition.key,
    dataFormat: legacy.problemCount ? 'records' : 'indicators',
    observations: legacy.problemCount ? [] : legacy.observations };
}

export function formatDatasetCell(value, column) {
  if (value == null) return 'N/A';
  if (column.type !== 'number') return String(value);
  const scaled = value * (column.scale ?? 1);
  const formatted = scaled.toLocaleString('en-US', {
    minimumFractionDigits: column.unit === 'percent' ? column.decimals ?? 1 : 0,
    maximumFractionDigits: column.decimals ?? 9,
  });
  return column.unit === 'percent' ? `${formatted}%` : column.unit === 'currency' ? `$${formatted}` : formatted;
}
