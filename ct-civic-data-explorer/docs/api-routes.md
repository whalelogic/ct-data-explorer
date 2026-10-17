# CT Civic Data Explorer: HTTP routes

**Access:** Public = no sign-in needed · Signed in = any staff or admin account · Admin = admin accounts only

**CSRF:** every `/api` request that changes data (POST, PUT, PATCH, DELETE) must send the `X-CSRF-Token` header, except `login`, `token` and `set-password`, which run before anyone is signed in.

## Pages and static files

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| GET | `/` (`index.html`) | Public file | Dashboard page (its API calls require sign-in) |
| GET | `/login` | Public | Sign-in page |
| GET | `/set-password` | Public | Set a password from an invite or reset link |
| GET | `/explore` | Public file | Saved report gallery (data requires sign-in); old `?dataset=` links redirect to the builder |
| GET | `/explore/:slug.html` | Public file | Interactive report viewer (data requires sign-in); `?embed=1` hides site chrome for same-origin embedding |
| GET | `/builder` | Public file | Report builder page |
| GET | `/dataset` | Public file | Dataset detail page |
| GET | `/town` | Public file | Town profile page |
| GET | `/admin` | Public file | Admin dataset list: search, sort and filter |
| GET | `/admin/datasets/new` | Public file | Add a dataset (upload page) |
| GET | `/users` | Public file | People: invite and manage users (admins) |
| GET | `/js/*`, `/css/*` | Public | Front-end scripts and styles |
| GET | `/shared/*` | Public | Code shared by server and browser (formatting, theme) |
| GET | `/vendor/chart.js/*` | Public | Chart.js library |
| GET | `/healthz` | Public | Health check: `200 {"status":"ok"}`, or `503` if the database is down |

## Auth: `/api/auth`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | Public (rate-limited) | Sign in with email and password |
| POST | `/api/auth/logout` | Signed in | Sign out and end the session |
| GET | `/api/auth/me` | Signed in | Current user, CSRF token and enabled features |
| POST | `/api/auth/token` | Public (rate-limited) | Check an invite or reset link token |
| POST | `/api/auth/set-password` | Public (rate-limited) | Set a password using a link token |

## Towns: `/api/towns`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| GET | `/api/towns` | Signed in | List towns |
| GET | `/api/towns/:id` | Signed in | One town's profile |

## Indicators: `/api/indicators`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| GET | `/api/indicators` | Admin | List indicators |
| POST | `/api/indicators` | Admin | Create an indicator |

## Datasets: `/api/datasets`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| GET | `/api/datasets` | Signed in | List datasets (staff see active ones only) |
| GET | `/api/datasets/:id` | Signed in | Dataset overview with paged rows (`?offset=&limit=`, limit max 100) |
| GET | `/api/datasets/:id/report-options` | Signed in | Rows (towns or row labels), `rowKind`, `rowNoun`, approved fields and filters available for reports |
| GET | `/api/datasets/:id/row-label` | Signed in | Which column labels rows, and the columns that may (staff: published datasets) |
| PUT | `/api/datasets/:id/row-label` | Signed in | Choose the row label column (`{"rowLabelKey": "c3"}`): the town column, the upload's label column or an approved text field |
| GET | `/api/datasets/:id/presentation` | Signed in | Shared display settings, revision and editable fields; staff see approved fields of published datasets |
| PUT | `/api/datasets/:id/presentation` | Signed in | Save display settings and optional style with the current revision; stale revisions return 409; approval and source data stay unchanged |
| GET | `/api/datasets/:id/curation` | Admin | Available fields and approval/review status |
| PUT | `/api/datasets/:id/curation` | Admin | Save approvedFields; empty approval unpublishes the dataset |
| POST | `/api/datasets/inspect` | Admin | Read an uploaded file's columns and suggest the row label column; nothing is saved |
| POST | `/api/datasets` | Admin | Upload a CSV or .xlsx file (multipart, 10 MB max). `labelColumn` names the column that identifies rows and `labelIsTown` says whether it holds Connecticut towns; without them a single `Town` column is required |
| PATCH | `/api/datasets/:id` | Admin | Turn a dataset on or off (`{"isActive": true}`) |

## Reports: `/api/reports`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| POST | `/api/reports/preview` | Signed in | Build an unsaved report for preview |
| POST | `/api/reports/pdf` | Signed in | Download an unsaved report as PDF |
| POST | `/api/reports/summary` | Signed in | AI-drafted summary (if AI is configured; not for record-based datasets) |
| GET | `/api/reports` | Signed in | List saved reports (`?q=` to search) |
| POST | `/api/reports` | Signed in | Save a new report |
| GET | `/api/reports/:id` | Signed in | Get a saved report (includes `slug` and `viewUrl`) |
| GET | `/api/reports/by-slug/:slug` | Signed in | A saved report and its current figures, for the viewer |
| PUT | `/api/reports/:id` | Signed in (owner only) | Update a saved report |
| POST | `/api/reports/:id/duplicate` | Signed in | Copy a report (the copy belongs to you) |
| DELETE | `/api/reports/:id` | Signed in (owner only) | Delete a report (`204`) |
| GET | `/api/reports/:id/pdf` | Signed in | Download a saved report as PDF, rebuilt from current data |

## Users: `/api/users`

| Method | Path | Access | What it does |
| --- | --- | --- | --- |
| GET | `/api/users` | Admin | List users |
| POST | `/api/users` | Admin | Invite a user (returns a set-password link) |
| PATCH | `/api/users/:id` | Admin | Change a user's details, role or active status |
| POST | `/api/users/:id/password-link` | Admin | Issue a new set-password link |

## Fallbacks

| Method | Path | Result |
| --- | --- | --- |
| Any | Any other `/api/...` path | `404` JSON error (`401` first if not signed in) |
| Any | Any other non-API path | Express's default `404` page |
