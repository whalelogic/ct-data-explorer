/** Read Excel cells as values, then apply the same town/indicator checks as CSV. */
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { readSheet, SheetNotFoundError } from 'read-excel-file/node';
import { HttpError } from '../lib/http-error.js';
import { validateDatasetCsv, validateDatasetRecords } from './csv-validation.js';

export async function validateDatasetFile(file, { filename = 'dataset.csv', worksheet }, known) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.csv') return validateDatasetCsv(file, known);
  const records = await readDatasetRecords(file, { filename, worksheet });
  return validateDatasetRecords(records, known);
}

export async function readDatasetRecords(file, { filename = 'dataset.csv', worksheet } = {}) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.csv') {
    try {
      return parse(file, { bom: true, info: true, skip_empty_lines: true, trim: true, relax_column_count: true });
    } catch {
      throw new HttpError(422, 'This file could not be read as CSV. Check the delimiters and quoted values.');
    }
  }
  if (extension !== '.xlsx') throw new HttpError(415, 'Choose a CSV or Excel (.xlsx) file.');

  let rows;
  try {
    rows = await readSheet(file, worksheet || 1);
  } catch (err) {
    if (err instanceof SheetNotFoundError) throw new HttpError(422, `Worksheet "${worksheet}" was not found. Check its name or leave it blank to use the first sheet.`);
    throw new HttpError(422, 'This Excel file could not be read. Upload a valid, unencrypted .xlsx workbook.');
  }
  if (rows.length > 10000 || rows.some((row) => row.length > 100)) {
    throw new HttpError(422, 'Use an Excel worksheet with at most 10,000 rows and 100 columns.');
  }
  const records = rows.map((row, index) => ({
    record: Array.from(row, (value) => value == null ? '' : value instanceof Date ? value.toISOString() : String(value).trim()),
    info: { lines: index + 1 },
  })).filter((row) => row.record.some((cell) => cell !== ''));
  return records;
}
