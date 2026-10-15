/** Map database rows to the camelCase shapes the API returns. Never exposes hashes or lockout state. */
import { indicatorLabel } from '../shared/format.js';
import { selectionSchema, upgradeLegacySelection } from './selection.js';
import { visibleDatasetColumns } from './field-curation.js';

export function presentUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    role: user.role,
    isActive: user.is_active,
    hasPassword: Boolean(user.password_hash),
    createdAt: user.created_at,
  };
}

export function presentPlace(place) {
  return {
    id: place.id,
    name: place.name,
    geoType: place.geo_type,
    label: place.geo_type === 'state' ? `${place.name} (statewide)` : place.name,
    squareMiles: place.square_miles,
  };
}

export function presentDataset(dataset) {
  return {
    id: dataset.id,
    name: dataset.name,
    sourceId: dataset.source_id,
    source: dataset.source,
    vintage: dataset.vintage,
    version: dataset.version,
    rowCount: dataset.row_count,
    isActive: dataset.is_active,
    uploadedAt: dataset.uploaded_at,
    uploadedBy: dataset.uploaded_by_name,
    dataFormat: dataset.data_format ?? 'indicators',
    columns: visibleDatasetColumns(dataset),
    importNotes: dataset.import_notes ?? [],
    approvedFields: dataset.approved_fields ?? null,
    curationReviewed: Boolean(dataset.curation_reviewed_at),
    curationReviewedAt: dataset.curation_reviewed_at ?? null,
  };
}

export function presentIndicator(indicator) {
  return {
    key: indicator.key,
    label: indicator.label,
    displayLabel: indicatorLabel(indicator),
    unit: indicator.unit,
    decimals: indicator.decimals,
    derivation: indicator.derivation,
    numeratorKey: indicator.numerator_key,
    denominatorKey: indicator.denominator_key,
  };
}

export function presentCard(card) {
  return {
    id: card.id,
    title: card.title,
    selection: currentSelection(card.selection),
    towns: card.selection?.towns ?? [],
    createdBy: { id: card.created_by, name: card.creator_name },
    dataset: {
      name: card.dataset_name,
      vintage: card.dataset_vintage,
      version: card.dataset_version,
    },
    createdAt: card.created_at,
    updatedAt: card.updated_at,
  };
}

/** Saved cards may predate the layout; the builder always receives the current shape. */
function currentSelection(storedSelection) {
  const parsedSelection = selectionSchema.safeParse(storedSelection);
  if (parsedSelection.success) {
    return parsedSelection.data;
  }
  return upgradeLegacySelection(storedSelection);
}
