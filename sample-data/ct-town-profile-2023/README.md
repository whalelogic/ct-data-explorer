# Connecticut Town Profile 2023

`ct-town-profile-2023.xlsx` is a real, public-domain dataset for demonstrating the explorer. It covers all 169 towns plus a Connecticut statewide row, with figures on people, jobs, income, housing and schools. Every value comes from the State of Connecticut open data portal (data.ct.gov). `build_workbook.py` downloads the figures and rebuilds the workbook; it needs `openpyxl`.

```sh
python3 build_workbook.py   # writes ct-town-profile-2023.xlsx next to this file
```

## Worksheets

| Sheet | Rows | What it shows |
| --- | --- | --- |
| Town profile 2023 | 170 | 13 fields: population, land area, median household and per capita income, labor force, unemployed residents, unemployment rate, median home value, housing units, assisted affordable units, % affordable, public school enrollment, education spending per pupil |
| Unemployment 2019-2024 | 170 | Annual unemployment rate for each year, 2019 to 2024 (the COVID spike in 2020 stands out) |
| Sources and notes | — | Sources, years and how the Connecticut row was built. This sheet is not for upload. |

Each data sheet uploads as its own dataset. The `Town` column is suggested automatically and every name matches. The upload guesses these units:
- **Currency:** incomes, "Median home value ($)" and "Education spending per pupil ($)".
- **Percent:** "Unemployment rate (%)" (stored as 0.032, shown as 3.2%) and "% of housing units affordable".
- **Plain numbers:** everything else.

## Sources

| Fields | Agency | data.ct.gov dataset |
| --- | --- | --- |
| Population (2023 estimate) | Department of Public Health, via OPM Municipal Fiscal Indicators | `xgef-f6jp` |
| Land area | 2020 Census, via OPM Municipal Fiscal Indicators | `xgef-f6jp` |
| Median household and per capita income, median home value | Census ACS 5-year (2019–2023), via OPM | `xgef-f6jp` |
| Labor force, unemployed, unemployment rate (both sheets) | Department of Labor annual averages, benchmarked by OPM | `5ijb-j6bn` |
| Housing units, assisted units, % affordable | Department of Housing, 2023 Affordable Housing Appeals List | `3udy-56vi` |
| School enrollment, spending per pupil | State Department of Education (FY 2023), via OPM | `xgef-f6jp` |

## The Connecticut row

The Connecticut row uses published statewide figures where they exist: incomes and the labor figures.
- **Summed from the 169 towns:** population, land area, school enrollment and the housing counts. % affordable is then assisted units ÷ housing units (11.47%).
- **Left blank (shown as N/A):** median home value and spending per pupil. No statewide figure is published for them.
- **Capped incomes:** the ACS caps medians at $250,000, so Westport's 250000 means "$250,000 or more".

Crime data is not included. Connecticut's open data portal has no town-level crime dataset, and the FBI Crime Data API needs a registered key.

## Report ideas

These use features of the report builder:
- **Summary cards.** In step 2 (Show), add calculated fields under *One value for the whole report*:
  - *Average per town* of Median household income.
  - *Highest* of Median home value (Darien, $1,728,400).
  - *Lowest* of Unemployment rate (Roxbury, 2.1%).
  - Leave the Connecticut comparison ticked.
- **Ratios.** Use *One field divided by another* for these:
  - Population ÷ Land area gives people per square mile.
  - Unemployed residents ÷ Labor force recomputes the rate.
- **Ranked chart.** Choose all towns and add a bar chart of % of housing units affordable. Under **Arrange**, set *Highest first*, *Show only the highest 15* and *Bars run: Across*. Hartford leads at 39.7%, and Connecticut sits at 11.5%, close to the 10% threshold in the state's affordable housing appeals law.
- **Trend lines.** Upload the *Unemployment 2019-2024* sheet. Pick a few towns, such as Hartford, Waterbury, Stamford and Roxbury, and add a line chart with *Along the axis: Fields, one color per town*. Each town becomes a line across the years, with Connecticut as the benchmark.
- **Comparison table.** Choose a group of neighboring towns and show income, home value and spending per pupil side by side with the statewide figures.
