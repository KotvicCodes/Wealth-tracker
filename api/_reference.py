"""Self-updating population reference data for the "Your Odds" view (stdlib only).

Once a week (piggybacking on the daily cron) this fetches working-age (15-64)
population per country and for the world from the World Bank API and stores it
next to the snapshot history (Blob in production, data/ locally). The frontend
merges these figures over its built-in estimates, so the odds math keeps
tracking real demographics without anyone maintaining the site.

Industry workforce figures are intentionally NOT refreshed: the odds math only
uses their ratios (billionaires-per-worker in a sector vs across all sectors),
so a uniform growth factor cancels out, and no public API reports workforce by
Forbes' industry categories. The ratios drift slowly enough to live in app.js.
"""
import json
import time

import _forbes
import _storage

REFERENCE_NAME = "reference.json"
REFRESH_DAYS = 7
WORLDBANK_URL = (
    "https://api.worldbank.org/v2/country/{codes}/indicator/SP.POP.1564.TO"
    "?format=json&mrnev=1&per_page=400"
)

# Forbes countryOfCitizenship -> World Bank ISO3 code. Countries absent here or
# missing from the World Bank response (e.g. Taiwan, Guernsey) keep the static
# fallback estimates bundled in app.js.
COUNTRY_ISO3 = {
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
}
WORLD_CODE = "WLD"


def _fetch_populations():
    """{iso3: persons} for every requested code the World Bank knows."""
    codes = ";".join(sorted(set(COUNTRY_ISO3.values())) + [WORLD_CODE])
    raw = _forbes._http_get(WORLDBANK_URL.format(codes=codes), timeout=30)
    payload = json.loads(raw)
    rows = payload[1] if len(payload) > 1 and payload[1] else []
    return {
        r["countryiso3code"]: r["value"]
        for r in rows
        if r.get("countryiso3code") and isinstance(r.get("value"), (int, float))
    }


def read_reference_bytes():
    return json.dumps(_storage.read_json(REFERENCE_NAME),
                      separators=(",", ":")).encode()


def refresh_if_stale():
    """Refresh stored population figures if older than REFRESH_DAYS; best-effort.

    Returns "fresh" (nothing to do), "updated", or "failed".
    """
    now_ms = int(time.time() * 1000)
    try:
        stored = _storage.read_json(REFERENCE_NAME)
        if now_ms - (stored.get("updatedAt") or 0) < REFRESH_DAYS * 86400 * 1000:
            return "fresh"
        pops = _fetch_populations()
        world = pops.get(WORLD_CODE)
        country_adults_m = {
            name: round(pops[iso] / 1e6, 3)
            for name, iso in COUNTRY_ISO3.items() if iso in pops
        }
        if not world or not country_adults_m:
            raise RuntimeError("world bank response missing expected values")
        _storage.write_json(REFERENCE_NAME, {
            "updatedAt": now_ms,
            "source": "World Bank SP.POP.1564.TO (population ages 15-64)",
            "worldAdultsM": round(world / 1e6, 1),
            "countryAdultsM": country_adults_m,
        })
        return "updated"
    except Exception as e:
        print(f"warning: reference refresh failed: {e}")
        return "failed"
