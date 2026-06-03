# worldart-globe — Claude context

Real-time 3D globe (globe.gl / Three.js) deployed on Vercel. Zero npm dependencies in the
front-end; `public/index.html` is a single self-contained file. Node 22.x required.

Repo: `Jem-Jem-Jem/worldart-globe`

---

## Architecture

| File | Role |
|---|---|
| `public/index.html` | Entire front-end — globe, layers, UI, all JS inline |
| `api/feed.js` | Node.js serverless function — proxies earthquakes, events, aircraft (fallback), gdacs, geocode, ships |
| `api/intelligence.js` | Node.js serverless function — news RSS → Gemini pipeline for the conflict/OSINT layer |
| `api/aircraft.js` | Vercel **Edge** function — aircraft fallback; uses Web Request/Response API, NOT Node req/res |
| `dev-server.js` | Local dev — runs all three API handlers in-process at `http://localhost:4321` |
| `vercel.json` | Zero-config deploy; adds CORS headers on `/api/(.*)` |

---

## Critical architecture rules

**Aircraft is browser-direct, not server-side.** Community ADS-B feeds (adsb.lol, airplanes.live,
adsb.one) block datacenter IPs — Vercel returns 403. The browser fetches with its residential IP,
falling back across three feeds, then finally to `/api/feed?source=aircraft` as a last resort.
**Do not move aircraft back to a server-side fetch — it will break.**

**`api/aircraft.js` uses Edge Runtime** (`export const config = { runtime: 'edge' }`). It takes a
Web `Request` and returns a `Response`. The dev-server adapts it with `new Request(...)`.
**Do not add Node.js APIs to aircraft.js.**

**`api/feed.js` and `api/intelligence.js` use Node.js Runtime** (req/res pattern).

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AISSTREAM_KEY` | No | Ships layer via aisstream.io WebSocket. Without it → `_unconfigured`, layer silently hidden. |
| `GEMINI_API_KEY` | No | Conflict/OSINT intelligence layer. Without it → `_unconfigured`, layer silently hidden. |
| `GEMINI_MODEL` | No | Override Gemini model (default `gemini-1.5-flash`). |

Both optional layers follow the same pattern: API returns `{ ..., _unconfigured: true }` and the
front-end auto-hides the layer and shows `—` in the legend with a tooltip explaining how to enable.

---

## Layers (front-end `LAYERS` object in index.html)

| Key | Group | Source string | Data source | Notes |
|---|---|---|---|---|
| `earthquakes` | hazards | `earthquakes` | USGS FDSNWS | size/rings by magnitude |
| `fires` | hazards | `events` | NASA EONET | category filter |
| `volcanoes` | hazards | `events` | NASA EONET | category filter |
| `storms` | hazards | `events` | NASA EONET | category filter |
| `floods` | hazards | `events` | NASA EONET | category filter |
| `alerts` | alerts | `gdacs` | GDACS | coloured by alert level (Green/Orange/Red); Red pulses |
| `conflict` | conflict | `intelligence` | `/api/intelligence` | size/pulse by severity 1-5 |
| `aircraft` | air | `aircraft` | browser-direct ADS-B | live only; `rotate` by heading |
| `military` | air | `military` | browser-direct ADS-B mil | live only |
| `ships` | maritime | `ships` | aisstream.io WebSocket | live only; requires `AISSTREAM_KEY` |

The `source` string in each layer maps to a branch in the `refresh(source)` function.

---

## Polling / caching

```js
REFRESH_MS = {
  earthquakes:   60_000,
  events:       300_000,
  intelligence: 1_800_000,  // 30 min — matches Vercel edge cache s-maxage
  aircraft:      20_000,
  military:      30_000,
  gdacs:        900_000,
  ships:         60_000,
}
```

---

## Intelligence pipeline (`api/intelligence.js`)

1. Fetch 4 RSS feeds concurrently (Google News conflict query, BBC World, Al Jazeera, UN News)
2. Parse XML (dependency-free regex), dedupe by title prefix, keep 60 newest headlines
3. Single Gemini call with JSON response schema → array of `{ lat, lon, place, country, eventType,
   severity(1-5), summary }`
4. Stitch model output back onto source record (headline, url, published, source name)
5. Return `{ items: [...], generated: ISO }` with `s-maxage=1800, stale-while-revalidate=7200`

Event types enum: `Armed conflict, Airstrike, Terrorism, Civil unrest, Political crisis,
Humanitarian, Cyber, Other`

Debug endpoint: `/api/intelligence?debug=1` — returns headline count, item count, sample[0..2].

---

## Ships layer (`api/feed.js` — `collectAisStream`)

Uses Node 22 native `WebSocket` (no npm dep). Opens a WebSocket to `wss://stream.aisstream.io/v0/stream`,
subscribes to a lat/lon bounding box (±15°), collects `PositionReport` + `ShipStaticData` messages
for 2500ms, then closes and returns normalised vessel objects.

Field names returned: `MMSI, LATITUDE, LONGITUDE, NAME, COG, SOG, HEADING, TYPE, DEST`

---

## Front-end patterns

- **`EXTRACT.*`** functions normalise raw API responses into plain `{ lat, lon, place, type, ... }` objects
- **`compose()`** iterates all visible layers, culls far-hemisphere markers (dot-product > 0), applies
  global marker budget (350), pushes to `globe.htmlElementsData()`
- **`showTip(d)`** — hover tooltip; **`showDetail(d)`** — click expanded brief (conflict only)
- `pinnedTip` flag — set on non-intelligence marker click to lock the tooltip; cleared on globe background click
- **`_unconfigured`** state flag — used by both `ships` and `conflict` layers; handled in `updateLegend()` and `updateStatus()`

---

## Recent PRs (this session)

| PR | Status | Description |
|---|---|---|
| #17 | Merged | README: fix ships row, env var section, Node version |
| #18 | Merged | Ships layer: replace AIS Hub with aisstream.io WebSocket |
| #19 | Merged | Conflict layer: replace dead GDELT endpoint with news → Gemini OSINT pipeline |

---

## Pending actions (user)

- [ ] Add `GEMINI_API_KEY` to Vercel env vars → activates conflict/OSINT layer
- [ ] Add `AISSTREAM_KEY` to Vercel env vars → activates ships layer
- Verify both with `?debug=1` on production after keys are set

---

## Known non-issues

- GDELT GEO 2.0 API (`api.gdeltproject.org/api/v2/geo/geo`) is dead — returns 404. Fully replaced
  by `/api/intelligence`. Do not attempt to restore GDELT.
- AIS Hub (`data.aishub.net`) is not viable — requires feeding raw AIS data upstream in exchange.
  Fully replaced by aisstream.io. Do not use AIS Hub.
- Outbound network is blocked in the Claude Code sandbox environment (even USGS/GDACS return 403
  from here). This is a sandbox policy, not a code bug — everything works in production on Vercel.
