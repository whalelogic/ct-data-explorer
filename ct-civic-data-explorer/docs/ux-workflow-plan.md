# UX workflow plan

Restructures the interface around two journeys. It implements the October capstone meeting
notes (`docs/Capstone_Meeting_Notes_2.pdf`) and fixes the ordering problems listed below.

- **Staff:** upload → review fields → customize → publish → maintain.
- **Users:** find data → look at it → build a report → save → export.

## 1. What is wrong today

The app has every capability it needs. The problem is that they aren't arranged in the order
people actually work.

| Problem | Where | Effect |
| --- | --- | --- |
| **Two pages build the same thing.** Explore and the report builder both ask for dataset → towns → statewide → fields → row filters, with separate code (`explore.js` 737 lines, `builder.js` 910 lines). | `/explore`, `/builder` | Users don't know which page to start on. A selection made in Explore reaches the builder only through `sessionStorage`. The two pages drift apart. |
| **The builder is one long form.** Nine stacked fieldsets: places, fields, label overrides, row filters, title, appearance, content blocks, AI draft, save/export. | `builder.html` | Nothing shows what is required and what is optional. Title and appearance come before the content they describe. |
| **The dataset page puts admin work first and the data last.** Order: Overview → Customize names → Approve fields → Indicators → Data preview. | `dataset.html` | Regular users scroll past staff tools to see the data. Staff find **Publish** in the Overview, above the approval step it depends on. |
| **The admin page leads with the upload form.** The dataset table sits under it with no search, sort or filter. | `admin.html` | The common task (find and manage an existing dataset) is the hardest one. |
| **Navigation names don't match their destinations.** "Reports" opens a blank builder, not the saved reports (those are on the Dashboard). "People", "Manage users" and "Users" all mean one page. | `layout.js`, `users.html` | People hunt for things. |
| **Action names vary.** "Open report builder", "New report", "Create a report", "Make report for this town"; "Generate PDF" and "Download PDF"; "indicators", "fields" and "columns"; "vintage", "year or period" and "reporting period". | across pages | Each page feels like a different product. |
| **There is an orphaned page.** `town.html` has no links pointing to it. | `town.html`, `town.js` | Dead code to maintain. |
| **Everything assumes towns.** Uploads must have exactly one `Town` column. The selection schema stores `towns` and `benchmark`. | `tabular-data.js:17`, `csv-validation.js:42`, `selection.js` | Datasets organized by category or record can't be loaded or reported on (meeting notes: report builder, item 1). |

## 2. Target structure

### Navigation

```
All users:  Dashboard · Datasets · Reports
Admins:     + Admin ▸ Data management · Manage users
```

- **Datasets** lists published datasets. Each one opens its dataset page.
- **Reports** is the saved-report library (moved out of the Dashboard). It has a **New report** button.
- **Dashboard** keeps search, recent datasets and "my recent reports". It stops being the only place to find reports.
- The **Admin** area has its own sub-navigation (meeting notes: admin, item 4). `/users` moves under it as **Manage users**.

### User journey

```
Dashboard / Datasets
   └─ Dataset page  [Data preview] [Fields]
         └─ "Create a report with this data"
               └─ Report builder (dataset already chosen)
                     1 Rows  →  2 Fields  →  3 Content  →  4 Finish
                                                     └─ Save · Export PDF
```

### Staff journey

```
Data management (search · sort · filter)
   ├─ [Add dataset] → Upload form → Dataset page › Settings tab
   └─ dataset row  →  Dataset page › Settings tab
         Review checklist:  ✓ Uploaded  →  Approve fields  →  Customize display (optional)  →  Publish
```

The checklist makes the required order obvious. **Publish** stays disabled until fields are
approved (the server already enforces this), and the checklist explains why.

### Vocabulary

Use these words in UI text, docs and the SRS:

| Use | Instead of |
| --- | --- |
| dataset | data source, card |
| field | indicator, column (keep "indicator definition" only for the advanced ratio editor) |
| row | town (when counting rows) |
| reporting period | vintage, year |
| report | card, selection |
| Create a report with this data | Open report builder, Make report for this town |
| Export PDF | Generate PDF, Download PDF |
| Published / Draft | Active / Inactive |
| Fields approved / Review needed | (current mixed labels) |

## 3. Decisions

> **Decided (Oct 15, 2026).** `/explore` is now the saved-report gallery and `/explore/<slug>.html` the interactive viewer; ad-hoc exploration moved into the builder. Datasets can be keyed by any column chosen at upload, and staff can change it later. Custom ratio indicators and per-field chart colors are part of the report model.

1. **Keep or retire `/explore`?** *Recommendation: retire it as a separate page.* The dataset
   page's **Data preview** covers "look at the data". The builder's first two steps show a live
   chart, so they cover "try a chart". `/explore?dataset=X` would redirect to
   `/builder?dataset=X`. Shared view links would become saved draft reports. **Cost:** the README
   documents `/explore?embed=1` for same-origin embedding, so embed mode has to move to a
   read-only report view (`/reports/:id?embed=1`). If quick exploration without saving matters
   to CTData, keep Explore instead, but have it share the builder's step components so the logic
   exists once.
2. **What is the row label for datasets without towns?** *Recommendation:* at upload, the admin
   picks the column that identifies each row. It defaults to `Town` when present. Town-specific
   features (town picker, statewide benchmark, geographic comparison) appear only when that
   column matches Connecticut towns.
3. **What happens to `town.html`?** *Recommendation:* delete it. Nothing links to it.

## 4. Phases

Each phase can ship on its own and leaves the app working. Phases 1 and 2 are UI-only.
Phase 4 is the only one that changes the data model.

### Phase 1: Navigation, vocabulary, admin area (small)

- Change the navigation in `layout.js` as described in §2. Add an admin sub-nav component used
  by `/admin` and `/users`.
- Add `/reports` (saved-report library). Reuse the dashboard's report grid and
  `report-library.js`.
- Rework `/admin` around the dataset table:
  - Search box (name, source).
  - Sortable columns (dataset, reporting period, version, rows, uploaded).
  - Filters for reporting period, publication status and field-review status (meeting notes:
    admin, item 3).
  - A prominent **Add dataset** button that opens `/admin/datasets/new`, a dedicated upload page
    (meeting notes: admin, item 2). The current form moves there unchanged.
- Rename `users.html` to "Manage users" and place it under the admin area.
- Apply the vocabulary table to all page copy.
- Delete `town.html` and `town.js` (if decision 3 is accepted).

**Done when** an admin can reach a dataset from `/admin` in at most two interactions using
search or filters, and every page uses the vocabulary table.

### Phase 2: Dataset page tabs (medium)

- **Compact header:** dataset name (e.g. *ACS 5-Year Town Profile*), then one summary line:
  `Source · Reporting period · 170 rows · 24 fields · Published`. Row and field counts come from
  the API, not from assumptions (meeting notes: dataset page, items 1, 3, 4).
- **Tabs** (meeting notes: dataset page, item 2). Each tab has a URL hash (`#preview`, `#fields`,
  `#settings`) so links and the Back button work. Use the ARIA tabs pattern with arrow-key
  support.
  - **Data preview** (default): short description, then the paginated table. Copy is neutral
    about what a row is ("170 rows", never "170 towns").
  - **Fields:** the approved fields with display name, type, unit and explanation. This is what
    a report can use. Admins also see unapproved fields, dimmed.
  - **Settings** (admins only), in workflow order:
    1. Review checklist with **Publish / Unpublish**.
    2. Approve fields (moved from the current curation panel).
    3. Customize names and display.
    4. Shared report appearance.
    5. Indicator definitions (advanced, collapsed).
- **Primary action:** **Create a report with this data** opens `/builder?dataset=<id>`
  (meeting notes: dataset page, item 5). It appears only when the dataset is published and has
  approved fields. Otherwise admins see "Finish review in Settings".
- After an upload, open `#settings` so staff land on the next step.

**Done when** a regular user's first screen on a dataset shows its data. Staff can complete
approve → publish without scrolling past unrelated panels. Tab state survives a reload.

### Phase 3: Report builder as steps (large)

Replace the single form with four steps. The live preview stays visible on the right.

| Step | Contains | Required |
| --- | --- | --- |
| **1 Rows** | Which rows to include: the town picker and statewide option for location datasets (row-label picker after Phase 4), plus category filters. | yes |
| **2 Fields** | Approved fields grouped by unit, with display names and units (meeting notes: report builder, item 2), report order, and per-report label overrides (collapsed). | yes |
| **3 Content** | Charts, tables and text blocks. Each chart has a title field with a default (see below). The AI draft summary goes here, next to the text blocks it creates. | one block |
| **4 Finish** | Report title and subtitle with defaults, report appearance overrides, report name, **Save**, **Export PDF**. | name |

- The dataset is chosen before the builder opens and shows as a header chip: "ACS 5-Year Town
  Profile · 2024 · Change". Changing it warns that field choices will reset.
- The stepper shows each step's completion state. Steps can be revisited in any order once
  filled in, and **Next** is just a shortcut.
- **Default titles** (meeting notes: report builder, item 6):
  - Report title: `<dataset display name>: <rows summary>` (e.g. "ACS 5-Year Town Profile:
    Hartford, New Haven, +3").
  - Chart title: `<field display names> by <row label>` (e.g. "Median household income by
    town").
  - Titles stay editable inline in the preview, and a cleared title returns to its default.
- Saving keeps the URL as `/builder?report=<id>`. Unsaved-changes guard on navigation.
- **Explore retirement** (if decision 1 is accepted): redirect `/explore`, migrate embed mode,
  delete `explore.js`/`explore.html` and the `sessionStorage` hand-off.

**Done when** a first-time user can go from a dataset page to an exported PDF without
instructions, the builder has one code path for choosing rows and fields, and existing saved
reports open unchanged.

### Phase 4: Datasets beyond towns (large, backend)

Implements meeting notes report-builder items 1, 3, 4 and 5.

- **Upload:** replace "exactly one `Town` column" with a **row label column** chosen at upload
  (pre-selected when a `Town` header exists). `tabular-data.js` gives that column
  `role: 'label'`, plus `geo: 'town'` when its values match towns. A migration backfills
  existing datasets as `label` + `geo: 'town'`.
- **Selection schema:** generalize `towns` to `rows: { labels: [...] }`, keep `benchmark` only
  when `geo` is set, and translate legacy `towns` when a report is read (the same approach
  `selection.js` already uses for pre-layout reports).
- **Chart model:** each chart block declares:
  - `category`: the axis or category field, defaulting to the row label.
  - `measures`: numeric fields.
  - `series`: an optional dimension field.
  - `chartType`: only the types compatible with those choices are offered (e.g. line needs an
    ordered category, grouped bar needs at least two measures sharing a unit).
- **Aggregation is opt-in:** `aggregate: none | sum | average | count`, defaulting to `none`.
  Rows are never combined unless the user picks this (meeting notes: report builder, item 5;
  this matches the current "never implicitly summed" rule).
- **Units:** measures with different units go on separate axes or charts. This extends the
  current group-by-unit logic to user-built charts.
- Show town-only controls (statewide benchmark, geographic comparison) only for `geo: 'town'`
  datasets.

**Done when** a dataset with no town column (e.g. industry categories) can be uploaded,
approved, published, reported on and exported. Every existing report renders exactly as before
(regression test against saved selections).

### Phase 5: SRS and docs (small, can run in parallel)

- Rewrite the SRS use cases around the two journeys in §2 (meeting notes: SRS, item 1).
- Replace "card" with "report" across the SRS use cases and acceptance criteria (meeting notes:
  SRS, item 2).
- Update `README.md`, `docs/architecture.md` and `docs/api-routes.md` for new routes
  (`/reports`, `/admin/datasets/new`, tab hashes) and the vocabulary.

## 5. Meeting-notes traceability

| Meeting note | Phase |
| --- | --- |
| SRS: revise use cases | 5 |
| SRS: cards → reports | 5 |
| Dataset: compact summary under title | 2 |
| Dataset: tabs (preview, fields, admin settings) | 2 |
| Dataset: preview default, dynamic counts | 2 |
| Dataset: neutral "170 rows" wording | 1 (copy), 2 |
| Dataset: "Create a report with this data", carries dataset | 2, 3 |
| Admin: simplify around existing datasets | 1 |
| Admin: Add dataset → dedicated upload form | 1 |
| Admin: search, sort, period/publication/review filters | 1 |
| Admin: nav for Data management and Manage users | 1 |
| Builder: not town-bound | 4 (UI in 3) |
| Builder: fields from approved fields with names, types, units | 3 |
| Builder: controls adapt; geography only when applicable | 4 |
| Builder: category/measure/series/chart-type choices | 4 |
| Builder: no implicit aggregation; separate units | 4 |
| Builder: editable titles with sensible defaults | 3 |

## 6. Suggested order

Phases 1 → 2 → 3 → 4, with 5 alongside. Phase 1 and 2 changes are visible to CTData quickly and
carry little risk. Phase 3 depends on decision 1. Phase 4 depends on decision 2 and should start
with its migration and selection-schema translation, tested against copies of real saved
reports.
