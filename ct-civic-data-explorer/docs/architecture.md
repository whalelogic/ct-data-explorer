# System architecture

How the CT Civic Data Explorer fits together. Solid arrows are requests and data flow; the dotted arrow is the session store.

```mermaid
flowchart TB
  Browser["Browser<br/>HTML pages · ES modules · Chart.js"]
  Scripts["npm scripts<br/>migrate · create-admin · seed"]

  subgraph App["Express app"]
    Middleware["Middleware<br/>request id · helmet · session · requireAuth · rate limits · CSRF"]
    Routes["API routes<br/>auth · towns · indicators · datasets · reports · users · assistant · audit"]
    Middleware --> Routes
  end

  subgraph Services["Services"]
    Auth["Auth<br/>login · lockout · invite links"]
    Datasets["Datasets<br/>CSV validation · versions"]
    Reports["Reports<br/>selection to report data"]
    Pdf["PDF<br/>pdfkit"]
    Ai["AI summary and assistant<br/>optional"]
    Audit["Audit trail<br/>who did what, when"]
    Reports -->|"report data"| Pdf
    Reports -->|"report data"| Ai
  end

  DB[("MySQL 8.4<br/>users · sessions · sources · datasets<br/>towns · indicators · observations · reports · audit_log")]
  Claude[["Claude API"]]

  Browser -->|"pages · JSON API"| Middleware
  Routes --> Services
  Services -->|"repositories · parameterized SQL"| DB
  Middleware -.->|"session store"| DB
  Ai -->|"public figures only"| Claude
  Scripts -->|"schema · first admin · sample data"| DB
```

- Every report starts as a **selection** (towns, indicators, and a layout of text, chart and table blocks). The Reports service turns it into one report-data object, which the browser preview, the PDF and the AI summary all use, so they always match.
- Town selection has no count limit. `report-charts.js` includes every requested numeric indicator in the output: grouped bars and lines use separate charts per unit and at most six series per chart, while bars use one chart per indicator. A chart layout block may expand into multiple titled chart blocks. Source records are preserved without aggregation or truncation.
- Rates such as poverty rate are computed on the server from stored values.
- The AI summary and the data assistant are optional; reports build and export without them. The assistant reads data only through the same services as the signed-in user.
- Routes record sign-ins and changes to people, datasets and reports in the audit trail after the change succeeds; a failure to record never fails the request.
- Running it for real users is covered in [deployment.md](deployment.md).
