# System architecture

How the CT Civic Data Explorer fits together. Solid arrows are requests and data flow; the dotted arrow is the session store.

```mermaid
flowchart TB
  Browser["Browser<br/>HTML pages · ES modules · Chart.js"]
  Scripts["npm scripts<br/>migrate · create-admin · seed"]

  subgraph App["Express app"]
    Middleware["Middleware<br/>helmet · session · requireAuth · CSRF"]
    Routes["API routes<br/>auth · towns · indicators · datasets · cards · users"]
    Middleware --> Routes
  end

  subgraph Services["Services"]
    Auth["Auth<br/>login · lockout · invite links"]
    Datasets["Datasets<br/>CSV validation · versions"]
    Cards["Cards<br/>selection to card data"]
    Pdf["PDF<br/>pdfkit"]
    Ai["AI summary<br/>optional"]
    Cards -->|"card data"| Pdf
    Cards -->|"card data"| Ai
  end

  DB[("MySQL 8.4<br/>users · sessions · sources · datasets<br/>towns · indicators · observations · cards")]
  Claude[["Claude API"]]

  Browser -->|"pages · JSON API"| Middleware
  Routes --> Services
  Services -->|"repositories · parameterized SQL"| DB
  Middleware -.->|"session store"| DB
  Ai -->|"public figures only"| Claude
  Scripts -->|"schema · first admin · sample data"| DB
```

- Every card starts as a **selection** (towns, indicators, and a layout of text, chart and table blocks). The Cards service turns it into one card-data object, which the browser preview, the PDF and the AI summary all use, so they always match.
- Rates such as poverty rate are computed on the server from stored values.
- The AI summary is optional; cards build and export without it.
