/** Dataset approval is enforced before figures enter previews, reports or AI facts. */
import { HttpError } from '../lib/http-error.js';

/** NULL keeps the previously published fields available until that version is reviewed. */
export function approvedDefinitions(definitions, approvedFields, { includeTown = false } = {}) {
  if (approvedFields == null) {
    return definitions;
  }

  const approvedKeys = new Set(approvedFields);
  const visibleFields = [];
  for (const field of definitions) {
    // The column that labels rows (a town or another identifier) is context, not a field.
    const isIncludedTown = includeTown && isRowIdentity(field);
    if (isIncludedTown || approvedKeys.has(field.key)) {
      visibleFields.push(field);
    }
  }
  return visibleFields;
}

export function datasetIndicators(definitions, storedIndicatorKeys) {
  const storedKeys = new Set(storedIndicatorKeys);
  const availableIndicators = [];

  for (const indicator of definitions) {
    let hasRequiredValues = storedKeys.has(indicator.key);
    if (indicator.derivation !== 'direct') {
      hasRequiredValues = storedKeys.has(indicator.numerator_key)
        && storedKeys.has(indicator.denominator_key);
    }
    if (hasRequiredValues) {
      availableIndicators.push(indicator);
    }
  }
  return availableIndicators;
}

export function isRowIdentity(field) {
  return field.role === 'town' || field.role === 'label';
}

export function validateApprovedFields(fields, approvedFields) {
  const availableKeys = new Set();
  for (const field of fields) {
    if (!isRowIdentity(field)) {
      availableKeys.add(field.key);
    }
  }

  if (new Set(approvedFields).size !== approvedFields.length) {
    throw new HttpError(400, 'Choose each approved field only once.');
  }
  for (const fieldKey of approvedFields) {
    if (!availableKeys.has(fieldKey)) {
      throw new HttpError(400, `Field "${fieldKey}" is not available in this dataset.`);
    }
  }
  return [...approvedFields];
}

export function requireApprovedSelection(selection, fields, approvedFields) {
  const approvedFieldsForDataset = approvedDefinitions(fields, approvedFields);
  const approvedKeys = new Set(approvedFieldsForDataset.map((field) => field.key));

  for (const fieldKey of selection.indicators) {
    if (!approvedKeys.has(fieldKey)) {
      throw new HttpError(400, `Field "${fieldKey}" is not approved for this dataset. Choose an available field.`);
    }
  }
  for (const fieldKey of Object.keys(selection.recordFilters ?? {})) {
    if (!approvedKeys.has(fieldKey)) {
      throw new HttpError(400, `Unknown category filter "${fieldKey}", or this field is not approved for the dataset.`);
    }
  }
}

export function requirePublishable(dataset) {
  if (!dataset.curation_reviewed_at || !dataset.approved_fields?.length) {
    throw new HttpError(400, 'Review this dataset and approve at least one field before publishing it.');
  }
}

/** Dataset metadata must not expose the names of unapproved source columns. */
export function visibleDatasetColumns(dataset) {
  const columns = dataset.column_definitions ?? [];
  if (dataset.data_format === 'records') {
    return approvedDefinitions(columns, dataset.approved_fields, { includeTown: true });
  }
  if (dataset.approved_fields == null) {
    return columns;
  }

  const approvedKeys = new Set(dataset.approved_fields);
  return columns.filter((column) => {
    return isRowIdentity(column) || approvedKeys.has(column.label.toLowerCase());
  });
}