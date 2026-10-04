# System architecture

How the CT Civic Data Explorer fits together. Solid arrows are requests and data flow; the dotted arrow is the session store.

```mermaid
flowchart TB
  Browser["Browser<br/>HTML pages · ES modules · Chart.js"]
  Scripts["npm scripts<br/>migrate · create-admin · seed"]

  subgraph App["Express app"]
    Middleware["Middleware<br/>helmet · session · requireAuth · CSRF"]
    Routes["API routes<br/>auth · towns · indicators · datasets · reports · users"]
    Middleware --> Routes
  end

  subgraph Services["Services"]
    Auth["Auth<br/>login · lockout · invite links"]
    Datasets["Datasets<br/>CSV validation · versions"]
    Reports["Reports<br/>selection to report data"]
    Pdf["PDF<br/>pdfkit"]
    Ai["AI summary<br/>optional"]
    Reports -->|"report data"| Pdf
    Reports -->|"report data"| Ai
  end

  DB[("MySQL 8.4<br/>users · sessions · sources · datasets<br/>towns · indicators · observations · reports")]
  Claude[["Claude API"]]

  Browser -->|"pages · JSON API"| Middleware
  Routes --> Services
  Services -->|"repositories · parameterized SQL"| DB
  Middleware -.->|"session store"| DB
  Ai -->|"public figures only"| Claude
  Scripts -->|"schema · first admin · sample data"| DB
```

- Every report starts as a **selection** (towns, indicators, and a layout of text, chart and table blocks). The Reports service turns it into one report-data object, which the browser preview, the PDF and the AI summary all use, so they always match.
- Rates such as poverty rate are computed on the server from stored values.
- The AI summary is optional; reports build and export without it.
