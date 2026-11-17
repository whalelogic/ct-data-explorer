/** Guest reports belong to this browser. Each report has its own storage entry. */
const STORAGE_PREFIX = 'ctde-guest-report:';

export function listGuestReports(query) {
  const search = query.toLowerCase();
  const reports = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(STORAGE_PREFIX)) continue;
    const report = readGuestReport(key.slice(STORAGE_PREFIX.length));
    if (report && [report.title, report.dataset.name, report.dataset.displayName].some(
      (text) => text?.toLowerCase().includes(search),
    )) {
      reports.push(report);
    }
  }
  return reports;
}

export function getGuestReport(id) {
  const report = readGuestReport(id);
  if (!report) throw new Error('This report could not be found in this browser. Open a saved report from Explore.');
  return report;
}

function readGuestReport(id) {
  const stored = localStorage.getItem(STORAGE_PREFIX + id);
  if (!stored) return null;
  try {
    const report = JSON.parse(stored);
    return report?.id === id && report.dataset && report.selection ? report : null;
  } catch {
    return null;
  }
}

export function saveGuestReport({ title, selection, dataset }, id = null) {
  if (title.length > 200) throw new Error('Use a report name with 200 characters or fewer.');
  if (id) getGuestReport(id);
  const report = {
    id: id ?? crypto.randomUUID(),
    title,
    selection,
    dataset: { name: dataset.name, displayName: dataset.displayName, vintage: dataset.vintage },
    rows: selection.rows,
    allRows: selection.allRows,
    isLocal: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(STORAGE_PREFIX + report.id, JSON.stringify(report));
  } catch {
    throw new Error('This browser could not save the report. Check its storage settings, or export a PDF to keep a copy.');
  }
  return report;
}

export function removeGuestReport(id) {
  localStorage.removeItem(STORAGE_PREFIX + id);
}
