---
name: flightclaw
description: Search Google Flights for prices, find cheapest dates, track routes over time, and get alerts when prices drop. Use when the user asks about flight prices, wants to compare routes, or track a fare. Requires uv and Python 3.10+.
---

# flightclaw

Search and track flight prices from Google Flights.

## Prerequisites

`uv` must be available on PATH. Dependencies are installed automatically on first run via inline script metadata — no manual setup needed.

## Scripts

All scripts are run with `uv run` from the skill directory. Use relative paths from this skill's root.

### Search Flights

Find flights for a route and date. Supports multiple airports and date ranges.

```bash
uv run scripts/search-flights.py LHR JFK 2025-07-01
uv run scripts/search-flights.py LHR JFK 2025-07-01 --cabin BUSINESS
uv run scripts/search-flights.py LHR JFK 2025-07-01 --return-date 2025-07-08
uv run scripts/search-flights.py LHR JFK 2025-07-01 --stops NON_STOP --results 10
# Multiple airports (searches all combinations)
uv run scripts/search-flights.py LHR,MAN JFK,EWR 2025-07-01
# Date range (searches each day)
uv run scripts/search-flights.py LHR JFK 2025-07-01 --date-to 2025-07-05
```

Arguments:
- `origin` — IATA airport code(s), comma-separated (e.g. LHR or LHR,MAN)
- `destination` — IATA airport code(s), comma-separated (e.g. JFK or JFK,EWR)
- `date` — Departure date (YYYY-MM-DD)
- `--date-to` — End of date range (YYYY-MM-DD), searches each day inclusive
- `--return-date` — Return date for round trips (YYYY-MM-DD)
- `--cabin` — ECONOMY (default), PREMIUM_ECONOMY, BUSINESS, FIRST
- `--stops` — ANY (default), NON_STOP, ONE_STOP, TWO_STOPS
- `--results` — Number of results (default: 5)

### Track a Flight

Add a route to price tracking and record the current price.

```bash
uv run scripts/track-flight.py LHR JFK 2025-07-01
uv run scripts/track-flight.py LHR JFK 2025-07-01 --target-price 400
uv run scripts/track-flight.py LHR JFK 2025-07-01 --return-date 2025-07-08 --cabin BUSINESS
# Track multiple airports and dates
uv run scripts/track-flight.py LHR,MAN JFK,EWR 2025-07-01 --date-to 2025-07-03 --target-price 400
```

Additional arguments:
- `--target-price` — Alert when price drops below this amount

### Check Prices

Check all tracked flights for price changes. Reports drops and alerts when targets are hit.

```bash
uv run scripts/check-prices.py
uv run scripts/check-prices.py --threshold 5
```

Arguments:
- `--threshold` — Percentage drop to trigger alert (default: 10)

### List Tracked Flights

Show all tracked flights with current vs original prices.

```bash
uv run scripts/list-tracked.py
```

## Currency

Prices are returned in the user's local currency (auto-detected from IP via Google Flights). The currency symbol is displayed automatically.

## Data

Price history is stored in `data/tracked.json` within this skill directory.
