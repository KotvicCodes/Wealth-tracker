import { httpGet } from './forbes.js';
import { storage } from './storage.js';
import type { ReferenceData } from '../shared/types.js';

const COUNTRY_ISO3: Record<string, string> = {
    "Afghanistan": "AFG", "Albania": "ALB", "Algeria": "DZA", "Argentina": "ARG",
    "Armenia": "ARM", "Australia": "AUS", "Austria": "AUT", "Barbados": "BRB",
    "Belgium": "BEL", "Belize": "BLZ", "Brazil": "BRA", "Bulgaria": "BGR",
    "Canada": "CAN", "Chile": "CHL", "China": "CHN", "Colombia": "COL",
    "Croatia": "HRV", "Cyprus": "CYP", "Czech Republic": "CZE", "Denmark": "DNK",
    "Egypt": "EGY", "Estonia": "EST", "Eswatini (Swaziland)": "SWZ",
    "Finland": "FIN", "France": "FRA", "Georgia": "GEO", "Germany": "DEU",
    "Greece": "GRC", "Hong Kong": "HKG", "Hungary": "HUN", "Iceland": "ISL",
    "India": "IND", "Indonesia": "IDN", "Ireland": "IRL", "Israel": "ISR",
    "Italy": "ITA", "Japan": "JPN", "Kazakhstan": "KAZ", "Lebanon": "LBN",
    "Liechtenstein": "LIE", "Luxembourg": "LUX", "Malaysia": "MYS",
    "Mexico": "MEX", "Monaco": "MCO", "Morocco": "MAR", "Nepal": "NPL",
    "Netherlands": "NLD", "New Zealand": "NZL", "Nigeria": "NGA",
    "Norway": "NOR", "Oman": "OMN", "Pakistan": "PAK", "Peru": "PER",
    "Philippines": "PHL", "Poland": "POL", "Portugal": "PRT", "Qatar": "QAT",
    "Romania": "ROU", "Russia": "RUS", "Saudi Arabia": "SAU",
    "Singapore": "SGP", "Slovakia": "SVK", "South Africa": "ZAF",
    "South Korea": "KOR", "Spain": "ESP", "St. Kitts and Nevis": "KNA",
    "Sweden": "SWE", "Switzerland": "CHE", "Tanzania": "TZA", "Thailand": "THA",
    "Turkey": "TUR", "Ukraine": "UKR", "United Arab Emirates": "ARE",
    "United Kingdom": "GBR", "United States": "USA", "Uruguay": "URY",
    "Venezuela": "VEN", "Vietnam": "VNM", "Zimbabwe": "ZWE",
};
const REFRESH_DAYS = 7;
interface PopulationRow { countryiso3code?: string; value: number | null }
type PopulationResponse = [unknown, PopulationRow[]?];

export async function refreshIfStale(): Promise<'fresh' | 'updated' | 'failed'> {
  const now = Date.now();
  try {
    const stored = await storage.readBestEffort<ReferenceData>('reference.json');
    if (now - (stored.updatedAt || 0) < REFRESH_DAYS * 86_400_000) return 'fresh';
    const codes = [...new Set(Object.values(COUNTRY_ISO3))].sort().concat('WLD').join(';');
    const payload = await httpGet<PopulationResponse>(
      `https://api.worldbank.org/v2/country/${codes}/indicator/SP.POP.1564.TO?format=json&mrnev=1&per_page=400`,
      30_000,
    );
    const populations = new Map((payload[1] || [])
      .filter((row) => row.countryiso3code && typeof row.value === 'number')
      .map((row) => [row.countryiso3code!, row.value!]));
    const world = populations.get('WLD');
    const countryAdultsM = Object.fromEntries(Object.entries(COUNTRY_ISO3)
      .filter(([, iso]) => populations.has(iso))
      .map(([name, iso]) => [name, Math.round(populations.get(iso)! / 1e3) / 1e3]));
    if (!world || !Object.keys(countryAdultsM).length) throw new Error('World Bank response missing expected values');
    await storage.write('reference.json', {
      updatedAt: now, source: 'World Bank SP.POP.1564.TO (population ages 15-64)',
      worldAdultsM: Math.round(world / 1e5) / 10, countryAdultsM,
    } satisfies ReferenceData);
    return 'updated';
  } catch (error) {
    console.warn('warning: reference refresh failed:', error);
    return 'failed';
  }
}
