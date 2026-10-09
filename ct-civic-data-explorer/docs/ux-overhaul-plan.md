# UX Overhaul Plan: Public Reports, Staff Workflow, and Brand Conformance

Status: **Draft for review** · Author: Keith Thomson · Date: 2026-10-09

## 1. Goals

1. **Public users** can browse published reports as cards on a public
   dashboard and open any of them as a polished, interactive web page (no
   sign-in, no builder). Published reports are the **only** public content.
   Town profiles and dataset tables stay staff-only.
2. **Staff** can build, publish, and maintain reports and datasets with fewer
   steps, fewer surprises, and clear feedback.
3. **Every surface** (web UI, interactive report, PDF) conforms to the CTData
   brand guideline (`docs/CTData_Brandguideline.pdf`), using **Poppins** as the
   single typeface.

## 2. Where we are today

| Area | Current state | Problem |
| --- | --- | --- |
| Access | Every `/api` route except `/api/auth` requires a session (`src/app.js:73-74`). | The public can't see anything. |
| Reports | `reports` stores only a `selection` JSON; no status or visibility. | You can't tell a draft from a finished report. Every report is visible to all staff. |
| Report viewing | Clicking a report opens `builder.html?report=id`. | You can't read a report without the editing UI around it. |
| Builder | One long form with six fieldsets, ↑/↓ reorder buttons, and no unsaved-changes guard. | Heavy for simple reports and easy to lose work. |
| Datasets | Upload is validated all-or-nothing on the server; no preview; versions are not grouped. | Uploads are trial and error, and the admin table won't scale. |
| Indicators | Create-only form; ratio keys typed by hand. | Typos can't be fixed, and the list can't be browsed. |
| Users | Role `<select>` saves immediately; links copied by hand. | Easy to change a role by accident. |
| Nav | `town.html` is linked from nowhere; `users.html` isn't in the nav. | Features can't be found. |
| Brand | Placeholder palette in `src/shared/theme.js` and `public/css/app.css`; system fonts; PDF uses Helvetica. | Off-brand, and colors are duplicated in two places. |

## 3. Brand system (applies to all phases)

### 3.1 Typography: Poppins only

We're departing from the guideline on purpose: **Poppins replaces Roboto Slab
for headlines and sub-heads**, so the whole product uses one family.

| Use | Weight | Color |
| --- | --- | --- |
| Headlines (h1) | Poppins ExtraBold 800 | Dark Blue `#262558` or Teal `#39738C` |
| Sub-heads (h2/h3) | Poppins SemiBold 600 | Teal `#39738C` or Dark Blue |
| Section heads in body copy | Poppins SemiBold 600 | Accent color (see contrast rules) |
| Body copy | Poppins Regular 400 | Dark Blue `#262558` |
| Captions, quotes | Poppins Italic 400 | Charcoal `#363635` (or Dark Blue for quotes) |
| Buttons / CTAs | Poppins ExtraBold 800, Title Case | White on Dark Blue, or Dark Blue on white |

- **Self-host** the font (`public/fonts/poppins-{400,400i,600,800}.woff2`, SIL OFL).
  Don't use the Google Fonts CDN. Self-hosting keeps CSP at `font-src 'self'`
  and sends no visitor data to third parties.
- Fallback stack: `"Poppins", Arial, Helvetica, sans-serif`. The guideline names
  Arial as Poppins' substitute.
- PDF: embed the same Poppins TTFs in pdfkit (`registerFont`) in place of
  Helvetica.

### 3.2 Color tokens

Define these once in `src/shared/theme.js`. That module is already shared by
the browser and the server, so it should be the single source. Generate or
mirror the CSS custom properties from it, and add a unit test that the CSS
values match theme.js.

| Token | Hex | Role | Contrast on white |
| --- | --- | --- | --- |
| `--brand` / ink | `#262558` Dark Blue | Body copy, logo, primary buttons | 14.1 ✅ |
| `--accent-teal` | `#39738C` | Headlines, links | 5.2 ✅ AA text |
| `--accent-green` | `#008881` | Accent blocks, success | 4.3 ⚠️ large text / UI only |
| `--accent-orange` | `#DE6F59` | Sparing highlights, separators, icons | 3.2 ⚠️ large text / non-text only |
| `--yellow` | `#F9DE8D` | Text on Dark Blue only; color blocks | 10.7 on Dark Blue ✅ |
| `--charcoal` | `#363635` | Captions, quotes | 12.1 ✅ |
| `--lilac` | `#9194A2` | Borders, decorative backgrounds | 3.0 (not for text) |
| `--ground` | `#F4F4F6` Light Gray | Page background | n/a |
| `--surface` | `#FFFFFF` | Cards, report canvas | n/a |

**Accessibility rules.** The guideline requires ADA contrast compliance, so
these override any aesthetic preference:
- Orange and green never carry normal-size text on white or light gray. For
  short section heads, use them only at ≥ 24px or ≥ 18.66px bold. Otherwise use
  them as rules, icons, or fills behind white or dark-blue text.
- Never put teal and green text on top of each other. Never put yellow text on
  accent colors.
- Keep a visible focus ring. Replace `--focus #f0a202` with a 3px Dark Blue
  outline plus a 2px white offset, which works on every brand fill.
- Status colors (`--danger`, `--ok`, `--warn-bg`) stay functional. Check each
  against the new ground.

### 3.3 Chart palette

The guideline says not to use teal and green in the same chart. Series order:

1. Dark Blue `#262558` (primary town)
2. Orange `#DE6F59`
3. Teal `#39738C`
4. Plum Purple `#9A3890`
5. Lime Green `#6AA343`
6. Bright Blue `#00A3BD`

The CT benchmark is drawn in Lilac Gray `#9194A2` with a hatched or dashed
pattern, so it doesn't rely on color alone. Lime and Bright Blue are 3.0:1 on
white, which passes the 3:1 non-text minimum but nothing more. Charts must also
have direct labels or the data table toggle (already present).

### 3.4 Copy rules

Copy rules from the guideline, to apply in UI strings and the PDF:
- One- or two-word headings in Title Case; longer ones in sentence case.
- Buttons are short and in Title Case ("Publish Report", "Download PDF").
- Bulleted items end with a period.
- Times are written "10:00 a.m."
- Quotes are italic.

## 4. Phased plan

### Phase 0: Brand foundation (≈1 week)

> **Status: implemented on `feature/phase0-brand` (2026-10-09).** Notes:
> - Poppins comes from the `@fontsource/poppins` npm package (Latin subset). Browsers
>   get WOFF2. The PDF embeds the WOFF files, because fontkit can't subset WOFF2.
>   Characters outside the Latin subset (e.g. `≥`, `↑`) have no glyph in either
>   format. Helvetica had the same gap, so this isn't a regression.
> - The header logo is static HTML in each page (no layout shift). `layout.js` adds
>   the nav and the shared footer.
> - Still to do: a favicon, and replacing the 178×61 PNG logo with an SVG once
>   it's available.

Ship this first: every later screen is built on it.

1. Brand tokens in `src/shared/theme.js` and a rewrite of the token block in
   `public/css/app.css`. Add a type scale (`--fs-100…--fs-700`) and spacing scale
   (`--space-1…--space-8`).
2. Self-hosted Poppins plus `@font-face` with `font-display: swap`.
3. One shared site header and footer rendered by `public/js/layout.js` instead
   of the hard-coded `<header class="site">` copied into each page. Include the
   CTData logo (asset needed, see §6) and an orange separator rule.
4. Restyle the components: buttons, inputs, cards, tables, alerts, tabs, and
   the report article.
5. PDF renderer: embed Poppins, adopt the new palette, and brand the header and
   footer (`src/services/pdf/pdfkit-renderer.js`).
6. Tests: theme/CSS parity, a contrast check for every text-on-background
   token pair, and an updated `test/pdf.test.js`.

### Phase 1: Published reports and the interactive report page (≈2–3 weeks)

This is the main deliverable.

**Data model** (`migrations/005_report_publishing.sql`):
- On `reports`, add:
  - `status` (`draft` | `published` | `archived`, default `draft`)
  - `slug` (unique, URL-safe)
  - `published_at`, `published_by`
  - `summary` (short description for cards and SEO)
- New `report_snapshots` table: `id`, `report_id`, `version`, `rendered` JSONB,
  `dataset_id`, `created_at`.
  - On publish, save the fully computed report (blocks, values, sources) as a
    snapshot.
  - The public page serves the snapshot, so a published report never changes
    when someone uploads a new dataset version, and it costs no computation
    per view.
  - Republishing creates a new snapshot version.

**Static publishing** (new `src/services/publish/`). The public site is
**plain static files**, not served by Node. The Node app stays the staff tool;
"Publish" writes files. This is what makes the move to WordPress painless:
the static site keeps working next to WordPress or inside it, and WordPress
never has to run Node.

- Staff side: `POST /api/reports/:id/publish` and `/unpublish`.
  - **Any staff member** can publish or unpublish their own reports. Admins
    can do it for any report.
  - Publishing returns the public URL.
- Publish writes these files into `PUBLIC_OUTPUT_DIR`:

  ```
  index.html                  public dashboard (report cards)
  embed.html                  chrome-less dashboard for iframes
  embed.js                    iframe auto-resize helper (for WordPress pages)
  reports.json                feed of every published report (cards, search)
  assets/                     fonts, CSS, JS, Chart.js, logo (versioned file names)
  r/<slug>/index.html         interactive report page (pre-rendered HTML)
  r/<slug>/embed.html         chrome-less variant for iframes
  r/<slug>/report.json        snapshot data that drives the charts
  r/<slug>/report.pdf         branded PDF
  r/<slug>/data.csv           all block data
  ```

- Writes are atomic: build into a temp directory, then `rename`, so visitors
  never see a half-written report. Unpublish removes `r/<slug>/` and
  regenerates `index.html` and `reports.json`.
- A "Rebuild Public Site" admin action (and `npm run publish:rebuild`)
  regenerates everything after a template or brand change.
- Report pages are **pre-rendered HTML**: text, tables and headings are in the
  markup, so they're readable and indexable without JS. A small script then
  draws the charts from `report.json`.
- Deploy target behind an interface (`src/services/publish/targets/`):
  - `local-dir` now: nginx serves the directory.
  - `rsync`/`s3` later: push to any static host or CDN.

**Hosting layout (subdomain).** Default name `reports.ctdata.org`, set with
`PUBLIC_BASE_URL`:
- `reports.ctdata.org`: static public files (nginx, or a CDN).
- `staff.reports.ctdata.org` (or a staff-only path proxied to Node): the
  Express app, login, and builder. This keeps the staff login off the public
  host.
- After the WordPress migration, `ctdata.org` (WordPress) links to the
  subdomain. Nothing on the subdomain has to change.

**WordPress integration: iframes** (decided 2026-10-09). WordPress shows
public content through iframes. No PHP plugin, and the app never runs inside
WordPress.

- **What gets embedded:** only the **public static pages**:
  - The dashboard: `embed.html`.
  - Individual reports: `r/<slug>/embed.html`.
  - The **staff app is never iframed.** It keeps `frame-ancestors 'self'`
    (the current helmet default) to prevent clickjacking on the login and
    builder.
- **Embed variants:** the same content and interactivity as the full page, but
  without the site header and footer, and with a transparent-friendly
  background. They include:
  - A small "Open Full Report ↗" link (`target="_blank"`), so visitors can
    reach the shareable URL, PDF, and print view.
  - Report cards in the embedded dashboard that open full reports in a new
    tab, or in the parent page if a `?target=parent` option is set.
- **Auto-height:** the embed pages post their height to the parent page with
  `postMessage` (`{type: "ctdata:resize", height}`, sent on load and on
  `ResizeObserver` changes). `embed.js` on the WordPress side listens,
  **checks `event.origin` is `https://reports.ctdata.org`**, and sets the
  matching iframe's height. Without `embed.js`, the iframe falls back to a
  fixed `min-height` and scrolls inside itself.
- **Embed code generator:** the staff publish panel and the dashboard both get
  a **Copy Embed Code** button. It produces a snippet that can be pasted into
  a WordPress "Custom HTML" block:

  ```html
  <iframe src="https://reports.ctdata.org/r/<slug>/embed.html"
          title="<Report title>" loading="lazy"
          style="width:100%;border:0;min-height:600px"
          data-ctdata-embed></iframe>
  <script src="https://reports.ctdata.org/embed.js" async></script>
  ```

  Embedding `embed.js` once in the WordPress theme's footer means the
  per-page snippet is only the `<iframe>`.
- **Headers on the static host:**
  - Embed pages: `Content-Security-Policy: frame-ancestors 'self'
    https://ctdata.org https://*.ctdata.org`.
  - Full pages: `frame-ancestors 'self'`.
  - No cookies are set anywhere on the public host, so iframes raise no
    third-party-cookie issues.
- **Accessibility:** every iframe has a descriptive `title`. Embedded charts
  keep their table alternatives and keyboard controls.
- **SEO:** search engines credit iframe content to the subdomain, not the
  WordPress page. The full pages on `reports.ctdata.org` are pre-rendered and
  indexable, and each embed page carries
  `<link rel="canonical">` pointing to its full page, so ranking isn't split.
  The WordPress post around the iframe should include its own summary text.
- **Links:** WordPress menus can also link straight to
  `reports.ctdata.org` for the full-screen experience.

**Interactive report page** (`templates/report-page.html` +
`public/js/report-page.js`, written to `r/<slug>/index.html`):
- Reuses `report-view.js` rendering in read-only mode, with no builder chrome.
- Interactive charts (Chart.js, already vendored):
  - Hover tooltips with formatted values and units.
  - Click a legend item to show or hide a town.
  - Toggle Chart ⇄ Table per block.
  - Switch between bar and line where the data allows.
- Sortable data tables with sticky headers. "Download CSV" on each block.
- Report-level actions: **Download PDF**, **Copy Link**, **Print** (a print
  stylesheet that drops the chrome).
- A table of contents generated from the text block headings, with in-page
  anchors for long reports.
- Header with title, subtitle, "Published Oct 9, 2026", and data source and
  vintage. Footer with methodology and sources.
- Accessibility:
  - Every chart has a text summary and the data table.
  - All controls are keyboard-operable.
  - Legend toggles respect `aria-pressed`.
  - Animation honors `prefers-reduced-motion`.
- Responsive down to 360px. Charts resize; tables scroll inside their own
  container, never the page.
- Open Graph meta tags and the canonical URL are baked into the HTML at
  publish time, so shared links preview well.

Out of scope: a live "compare your town" mode where visitors re-render a
report for other towns. Public pages only ever serve published snapshots.

### Phase 2: Public report dashboard (≈1–2 weeks)

- The static `index.html` at `reports.ctdata.org` becomes the **public
  dashboard**: a responsive grid of report cards for published reports.
  - Each card shows the title, summary, towns covered, dataset and vintage,
    and the published date, with an orange accent rule. Cards link to
    `r/<slug>/`.
  - The cards are pre-rendered into the HTML, so the page works without JS.
  - Search box plus filter chips (town, dataset/topic, year) run on the
    client over `reports.json`. That's instant and fine for hundreds of
    reports. Show 24 at a time with "Load More".
  - Sort: Newest (default) / Title.
  - Branded header with the CT Data Collaborative logo, a link back to
    ctdata.org, and a footer.
- The staff app keeps its own dashboard (the current `index.html`), restyled.
  It stays on the staff host and gets a "View Public Site" link. The public
  site has no sign-in link.
- `town.html` and `dataset.html` stay staff-only; Phase 3 links them in the
  staff nav.

### Phase 3: Staff workflow (≈3 weeks)

**Builder → guided editor**
- Keep the single page but add a **step rail**: Data → Places → Indicators →
  Layout → Review & Publish. Each step collapses to a summary when done, so
  power users can still jump around.
- Drag-and-drop reordering of layout blocks and indicators (pointer and
  keyboard; keep ↑/↓ as the accessible fallback).
- Town pickers become a validated combobox. Unknown towns are rejected at
  input time, not at preview time.
- **Autosave a draft** every 10 seconds when there are changes, and show a
  `beforeunload` warning when there are unsaved changes.
- Mixed-unit chart errors are caught inline on the chart block (filter the
  indicator picker by unit) instead of as a server error.
- "Preview as Public" renders the same static template for the current draft
  and serves it from the staff app (auth required). It is not written to the
  public directory.
- Publish panel: status badge, slug editor, summary field, Publish / Unpublish
  / Republish, and a link to the public page.

**Report library (staff)**
- Tabs: My Reports / All Reports / Published / Drafts. Filters for owner,
  town, dataset, and status.
- An inline rename dialog replaces `prompt()`. A proper confirmation dialog
  replaces `confirm()`, and deletion becomes archiving.
- Clicking a card opens the **read-only view**, with an "Edit" button.

**Dataset upload**
- Two steps: **Validate** (`POST /api/datasets/validate`, a dry run) shows the
  detected columns, row count, a 25-row preview, and problems grouped by type.
  Then **Import**.
- Warn when name + vintage already exists ("This will create version 3").
- Admin datasets table: grouped by dataset with versions collapsed, plus
  search, sort, status filter, and inline Activate / Deactivate.
- Add the endpoints the audit found missing: edit dataset metadata and delete
  an inactive version.

**Indicators**
- An indicator list page with search, plus edit and deactivate
  (`PATCH /api/indicators/:id`).
- Ratio numerator and denominator become pickers from existing indicators.

**Users**
- Role changes need confirmation. Add search and filter, and allow editing
  names.
- A "Copy Invite Link" button with clear expiry text. Sending email is out of
  scope unless an SMTP relay is chosen.

**Navigation**
- Staff nav: Reports · Datasets · Towns · Indicators · Users (admin) · View
  Public Site.

### Phase 4: Hardening and polish (≈1 week)

- Browser tests with Playwright: one smoke test per page and an axe-core
  accessibility scan on the public pages. Fail CI on serious violations.
- An embed test: a test page on another origin iframes the dashboard and a
  report. Check that auto-height works, that messages from the wrong origin
  are ignored, and that the staff app refuses to be framed.
- Lighthouse budget for the public report page: LCP < 2.5s, CLS < 0.1, and
  perf/a11y scores ≥ 90.
- CSP stays at defaults. All vendor JS stays served locally, and no analytics
  or third-party scripts are added.
- Update the docs: `api-routes.md`, `architecture.md`, `schema.dbml`, and the
  README screenshots.

## 5. Technical notes

- **No build step.** Stay on native ES modules. Poppins and any new vendor
  libraries (e.g. SortableJS for drag-and-drop, or hand-rolled) are served from
  `/vendor`, the same way Chart.js is.
- **Security.**
  - The public site is static, so it has no public API, no database access, and
    no server-side input to attack. The Node app (and its login) is never
    exposed on the public host.
  - Published files contain snapshot data only. They never include
    `selection`, user IDs, or staff names unless the report is meant to credit
    an author.
  - Drafts are never written to the public directory.
  - Slugs are checked against `^[a-z0-9-]{1,80}$` before any filesystem write
    (no path traversal).
  - Static host headers: a strict CSP (`script-src 'self'`), HSTS,
    `X-Content-Type-Options`, and long-cache immutable assets with
    `no-cache` on HTML and JSON.
- **Reuse.** `report-view.js`, `src/services/presenters.js`, and
  `src/shared/format.js` are already shared. The public page should import
  them, not fork them.
- **Migration.** Existing reports become `draft`. Admins publish selectively.

## 6. Assets

- **Logo:** `public/img/ctdata-logo.png` (CT Data Collaborative wordmark,
  178×61). It's fine as a placeholder, but it will blur on high-DPI screens
  and in the PDF. **We still need an SVG** (or a PNG of at least 3×), plus a
  reversed/white variant for dark-blue headers and a favicon.
- Poppins TTF/WOFF2 files (Google Fonts download, OFL).
- Public host: a **ctdata.org subdomain** (default `reports.ctdata.org`).
  Report URLs take the form `https://reports.ctdata.org/r/<slug>/`. The Open
  Graph tags and the canonical URLs use `PUBLIC_BASE_URL`. DNS records and TLS
  certificates are needed for the public subdomain and the staff host.

## 7. Decisions

Settled 2026-10-09:
- The public sees **published reports only**, shown as cards on the public
  dashboard.
- **No** "compare your town" mode.
- **All staff** can publish their own reports; admins can publish any report.
- The public site lives on a **ctdata.org subdomain**, separate from the
  future WordPress site.
- Public pages are **static files** written at publish time.
- WordPress integrates through **iframes** of the public embed pages (the
  dashboard and individual reports), with auto-height. The staff app is never
  embedded.
- **Poppins** is the only typeface.

Still open (these don't block Phase 0 or 1):
1. **Subdomain name:** `reports.ctdata.org` (default), `data.ctdata.org`, or
   something else. It's a single env var.
2. **Static host:** nginx on the existing server (simplest), or a static
   host/CDN (S3 + CloudFront, Cloudflare Pages, etc.).
3. **Staff host name** and whether staff access should also be IP- or
   VPN-restricted.
