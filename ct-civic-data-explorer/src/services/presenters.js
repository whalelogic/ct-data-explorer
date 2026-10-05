/** Map database rows to the camelCase shapes the API returns. Never exposes hashes or lockout state. */
import { indicatorLabel } from '../shared/format.js';
import { selectionSchema, upgradeLegacySelection } from './selection.js';

export function presentUser(u) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.first_name,
    lastName: u.last_name,
    role: u.role,
    isActive: u.is_active,
    hasPassword: Boolean(u.password_hash),
    createdAt: u.created_at,
  };
}

export function presentPlace(t) {
  return {
    id: t.id,
    name: t.name,
    geoType: t.geo_type,
    label: t.geo_type === 'state' ? `${t.name} (statewide)` : t.name,
    squareMiles: t.square_miles,
  };
}

export function presentDataset(d) {
  return {
    id: d.id,
    name: d.name,
    sourceId: d.source_id,
    source: d.source,
    vintage: d.vintage,
    version: d.version,
    rowCount: d.row_count,
    isActive: d.is_active,
    uploadedAt: d.uploaded_at,
    uploadedBy: d.uploaded_by_name,
    dataFormat: d.data_format ?? 'indicators',
    columns: d.column_definitions ?? [],
    importNotes: d.import_notes ?? [],
  };
}

export function presentIndicator(i) {
  return {
    key: i.key,
    label: i.label,
    displayLabel: indicatorLabel(i),
    unit: i.unit,
    decimals: i.decimals,
    derivation: i.derivation,
    numeratorKey: i.numerator_key,
    denominatorKey: i.denominator_key,
  };
}

export function presentReport(c) {
  return {
    id: c.id,
    title: c.title,
    selection: currentSelection(c.selection),
    towns: c.selection?.towns ?? [],
    createdBy: { id: c.created_by, name: c.creator_name },
    dataset: { name: c.dataset_name, vintage: c.dataset_vintage, version: c.dataset_version },
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** Saved reports may predate the layout; the builder always receives the current shape. */
function currentSelection(stored) {
  const parsed = selectionSchema.safeParse(stored);
  return parsed.success ? parsed.data : upgradeLegacySelection(stored);
}
