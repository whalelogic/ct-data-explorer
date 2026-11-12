"""Build ct-town-profile-2023.xlsx from public-domain State of Connecticut open data.

Every figure comes from data.ct.gov; nothing is estimated here. Where a source has no
statewide row, the Connecticut row sums the 169 towns (see the "Sources and notes" sheet).

Usage: python3 build_workbook.py [output.xlsx]   (needs openpyxl)
"""
import json
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('ct-town-profile-2023.xlsx')
STATE = 'Connecticut'
MFI_EDITION = 'Report Edition: 2019-2023'


def fetch(dataset_id, **query):
    """One Socrata query against data.ct.gov, as a list of row dicts."""
    params = urllib.parse.urlencode({'$limit': 50000, **query})
    with urllib.request.urlopen(f'https://data.ct.gov/resource/{dataset_id}.json?{params}', timeout=60) as response:
        return json.load(response)


# Department of Housing names the 169 towns exactly as the app does.
doh_rows = fetch('3udy-56vi', year='2023')
towns = sorted(row['town'] for row in doh_rows)
assert len(towns) == 169, len(towns)
proper = {name.upper(): name for name in towns}


def name_of(raw):
    raw = raw.strip().upper()
    if raw == 'STATEWIDE':
        return STATE
    return proper.get(raw)


mfi = defaultdict(dict)
for row in fetch('xgef-f6jp', year='2023') + fetch('xgef-f6jp', metric='Area in sq miles 2020 census'):
    # Land area is only published in the 2016-2020 edition (2020 Census).
    is_area = row['metric'] == 'Area in sq miles 2020 census'
    if not is_area and row['municipal_fiscal_indicators_report_edition_'] != MFI_EDITION:
        continue
    town = name_of(row['town'])
    if town and row.get('value') not in (None, ''):
        mfi[row['metric']][town] = float(row['value'])

labor = defaultdict(dict)
for row in fetch('5ijb-j6bn'):
    town = name_of(row['town'])
    if town:
        labor[int(row['year'])][town] = row

doh = {}
for row in doh_rows:
    town = name_of(row['town'])
    assert town, row['town']
    doh[town] = row

missing = [t for t in towns if t not in labor[2023] or t not in doh or t not in mfi['Estimated population (DPH)']]
assert not missing, missing

# Statewide housing figures are sums of the 169 towns (DOH publishes no statewide row).
doh[STATE] = {
    '_2010_census': sum(int(doh[t]['_2010_census']) for t in towns),
    'total_assisted': sum(int(doh[t]['total_assisted']) for t in towns),
}
doh[STATE]['percent_assisted'] = round(100 * doh[STATE]['total_assisted'] / doh[STATE]['_2010_census'], 2)
STATE_MEDIANS = {
    'Median household income (ACS)': 'Statewide Median: Median household income (ACS)',
    'Per capita income (ACS)': 'Statewide Median: Per capita income (ACS)',
}

# Counts with no published statewide row are sums of the 169 towns.
STATE_SUMS = {'Area in sq miles 2020 census', 'Estimated population (DPH)', 'School enrollment (average daily membership)(CSDE)'}


def metric(name, town):
    if town == STATE and name in STATE_MEDIANS and STATE not in mfi[name]:
        return mfi[STATE_MEDIANS[name]].get(STATE)
    if town == STATE and name in STATE_SUMS and STATE not in mfi[name]:
        return round(sum(mfi[name][t] for t in towns), 2)
    return mfi[name].get(town)


def whole(value):
    return None if value is None else round(value)


PROFILE = [
    ('Population (2023 estimate)', lambda t: whole(metric('Estimated population (DPH)', t))),
    ('Land area (sq mi)', lambda t: metric('Area in sq miles 2020 census', t)),
    ('Median household income', lambda t: whole(metric('Median household income (ACS)', t))),
    ('Per capita income', lambda t: whole(metric('Per capita income (ACS)', t))),
    ('Labor force', lambda t: int(labor[2023][t]['labor_force'])),
    ('Unemployed residents', lambda t: int(labor[2023][t]['unemployed'])),
    ('Unemployment rate (percent decimal)', lambda t: round(float(labor[2023][t]['unemp_rate']), 4)),
    ('Median home value ($)', lambda t: whole(metric('Median value of owner occupied homes (ACS)', t))),
    ('Housing units (2020 Census)', lambda t: int(doh[t]['_2010_census'])),
    ('Assisted affordable housing units', lambda t: int(doh[t]['total_assisted'])),
    ('% of housing units affordable', lambda t: float(doh[t]['percent_assisted'])),
    ('Public school enrollment', lambda t: whole(metric('School enrollment (average daily membership)(CSDE)', t))),
    ('Education spending per pupil ($)', lambda t: whole(metric('Net current education expenditures per pupil (CSDE)', t))),
]

workbook = Workbook()
bold = Font(bold=True)

sheet = workbook.active
sheet.title = 'Town profile 2023'
sheet.append(['Town'] + [label for label, _ in PROFILE])
for town in [STATE] + towns:
    sheet.append([town] + [get(town) for _, get in PROFILE])

years = sorted(labor)
trend = workbook.create_sheet('Unemployment 2019-2024')
trend.append(['Town'] + [f'{year} unemployment rate (percent decimal)' for year in years])
for town in [STATE] + towns:
    trend.append([town] + [round(float(labor[year][town]['unemp_rate']), 4) for year in years])

for ws in (sheet, trend):
    for cell in ws[1]:
        cell.font = bold
    ws.freeze_panes = 'B2'
    ws.column_dimensions['A'].width = 18
    for column in ws.iter_cols(min_col=2, max_row=1):
        ws.column_dimensions[column[0].column_letter].width = max(14, len(str(column[0].value)) + 2)
    for row in ws.iter_rows(min_row=2, min_col=2):
        for cell in row:
            header = ws.cell(row=1, column=cell.column).value
            if 'unemployment rate' in header.lower():
                cell.number_format = '0.0%'
            elif '$' in header or 'income' in header.lower():
                cell.number_format = '"$"#,##0'
            elif 'area' in header.lower() or header.startswith('%'):
                cell.number_format = '#,##0.00'
            else:
                cell.number_format = '#,##0'

notes = workbook.create_sheet('Sources and notes')
NOTES = [
    ('Connecticut Town Profile 2023', ''),
    ('', ''),
    ('Field', 'Source'),
    ('Population (2023 estimate)', 'CT Department of Public Health estimate, via OPM Municipal Fiscal Indicators (data.ct.gov xgef-f6jp), calendar year 2023'),
    ('Land area (sq mi)', '2020 Census land area, via OPM Municipal Fiscal Indicators (xgef-f6jp)'),
    ('Median household income, Per capita income', 'U.S. Census Bureau ACS 5-year estimates (2019-2023), via OPM Municipal Fiscal Indicators (xgef-f6jp); the Connecticut row is the statewide figure OPM publishes'),
    ('Median home value ($)', 'Median value of owner-occupied homes, ACS 5-year (2019-2023), via OPM Municipal Fiscal Indicators (xgef-f6jp)'),
    ('Labor force, Unemployed residents, Unemployment rate', 'CT Department of Labor annual averages, benchmarked by OPM (data.ct.gov 5ijb-j6bn), 2023'),
    ('Housing units, Assisted affordable housing units, % affordable', 'CT Department of Housing, 2023 Affordable Housing Appeals List (data.ct.gov 3udy-56vi); housing units are 2020 Census counts'),
    ('Public school enrollment, Education spending per pupil', 'CT State Department of Education (average daily membership and net current expenditures per pupil), via OPM Municipal Fiscal Indicators (xgef-f6jp), fiscal year ending 2023; rounded to whole pupils and dollars'),
    ('Unemployment 2019-2024 sheet', 'OPM Municipal Fiscal Indicators: Benchmark Labor Data (5ijb-j6bn); earlier years are benchmarked to 2023 by OPM'),
    ('', ''),
    ('Connecticut row', 'Published statewide figures where the source has them. Population, land area, school enrollment and the housing counts are sums of the 169 towns (% affordable = assisted units / housing units). Median home value and spending per pupil have no published statewide figure here and are left blank.'),
    ('Unemployment rate', 'Stored as a decimal (0.032 = 3.2%).'),
    ('Income cap', 'The ACS publishes medians above $250,000 as "250,000+", so 250000 means $250,000 or more.'),
    ('Licence', 'All sources are public domain (State of Connecticut open data).'),
    ('Retrieved', f'{date.today().isoformat()} from data.ct.gov by build_workbook.py'),
]
for row in NOTES:
    notes.append(list(row))
notes['A1'].font = Font(bold=True, size=14)
notes['A3'].font = bold
notes['B3'].font = bold
notes.column_dimensions['A'].width = 52
notes.column_dimensions['B'].width = 120

workbook.save(out)
print(f'Wrote {out}: {sheet.max_row - 1} profile rows, {trend.max_row - 1} trend rows')
