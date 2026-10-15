/** Preserve the file's grain: each source row stays a separate record. */
import { NUMBER, validateDatasetRecords } from './csv-validation.js';

const numeric = (value) => NUMBER.test(value.replaceAll(',', '')) && Number.isFinite(Number(value.replaceAll(',', '')));

export function prepareTabularDataset(records, known) {
  const problems = [];
  const notes = [];
  const fail = () => ({ problems: problems.slice(0, 200), problemCount: problems.length, rows: [], observations: [] });
  if (records.length < 2) { problems.push('The file needs a header row and at least one data row.'); return fail(); }
  const header = records[0].record;
  const data = records.slice(1).filter((row) => row.record.some((cell) => cell !== ''));
  if (!data.length) { problems.push('The file has no data rows.'); return fail(); }
  const width = Math.max(header.length, ...data.map((row) => row.record.length));
  if (width > 100 || data.length > 10000) { problems.push('Use at most 100 columns and 10,000 data rows.'); return fail(); }
  const townIndexes = header.flatMap((label, i) => label.trim().toLowerCase() === 'town' ? [i] : []);
  if (townIndexes.length !== 1) { problems.push('Include exactly one column named Town.'); return fail(); }
  const townIndex = townIndexes[0];
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
    columns.push({ key: `c${i}`, index: i, label, type: isNumber ? 'number' : 'text',
      role: i === townIndex ? 'town' : isNumber ? 'measure' : 'dimension',
      unit: definition?.unit ?? (fraction ? 'percent' : 'number'),
      scale: fraction ? 100 : 1, decimals: definition?.decimals ?? (fraction ? 1 : 9) });
  }
  const towns = new Map(known.towns.map((town) => [town.name.toLowerCase(), town]));
  const counts = new Map();
  const matchedLabels = new Set();
  const rows = data.map(({ record, info }) => {
    const name = (record[townIndex] ?? '').trim();
    const baseName = name.replace(/\s+\([^)]*\)$/, '');
    const town = towns.get(name.toLowerCase()) ?? towns.get(baseName.toLowerCase());
    if (town && name.toLowerCase() !== town.name.toLowerCase() && !matchedLabels.has(name)) {
      matchedLabels.add(name);
      notes.push(`Town label "${name}" matched to ${town.name}; the original label is retained.`);
    }
    if (!town) problems.push(`Row ${info.lines}: "${name}" does not match a Connecticut town.`);
    if (town) counts.set(town.id, (counts.get(town.id) ?? 0) + 1);
    const cells = {};
    for (const column of columns) {
      const value = (record[column.index] ?? '').trim();
      if (value.length > 4000) problems.push(`Row ${info.lines}: ${column.label} exceeds 4,000 characters.`);
      if (column.type === 'number' && value !== '' && !numeric(value)) problems.push(`Row ${info.lines}: ${column.label} value "${value}" is not a number.`);
      cells[column.key] = value === '' ? null : column.type === 'number' && numeric(value) ? Number(value.replaceAll(',', '')) : value;
    }
    return { townId: town?.id, sourceRow: info.lines, cells };
  });
  if (problems.length) return fail();
  const repeated = [...counts.values()].filter((count) => count > 1).length;
  if (repeated) notes.push(`${repeated} towns have multiple rows. Every source row is retained; repeated values are not automatically summed.`);
  if (columns.some((column) => column.scale === 100)) notes.push('Decimal-format percentages are stored unchanged and displayed as percentages.');
  // Existing single-row indicator datasets retain their current calculations and saved reports.
  const legacy = validateDatasetRecords(records, known);
  return { problems: [], problemCount: 0, rows, columns, notes, rowCount: rows.length,
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
