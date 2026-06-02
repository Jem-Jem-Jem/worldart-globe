# 🌍 World Globe — Live Planetary Intelligence

A real-time 3D globe visualizing live world-event feeds: earthquakes, wildfires, volcanoes,
severe storms, floods, live air traffic, and open-source conflict intelligence. Each data
category gets a **distinct icon, colour and motion** so the globe reads as a stratified
intelligence display, with a switchable satellite surface, a global time scrubber, and basic
geospatial tools.

**Concept inspired by [worldmonitor.app](https://worldmonitor.app/).** We proxy directly to free
public upstream sources, keeping the project free, key-less, and self-deployable.

---

## Live data sources

| Layer | Source | Endpoint | Key | Path |
|---|---|---|---|---|
| **Earthquakes** | USGS | `…/summary/all_day.geojson` (live) · `fdsnws/event` (history) | No | proxy |
| **Wildfires / Volcanoes / Storms / Floods** | NASA EONET v3 | `eonet.gsfc.nasa.gov/api/v3/events` | No | proxy |
| **Aircraft** | adsb.lol → airplanes.live → adsb.one | `/v2/point/{lat}/{lon}/250` | No | **browser-direct** (proxy fallback) |
| **Military aircraft** | adsb.lol (and fallbacks) | `/v2/mil` | No | browser-direct (proxy fallback) |
| **Conflict events** | GDELT GEO 2.0 | `api.gdeltproject.org/api/v2/geo/geo` | No | proxy |
| **Disaster alerts** | GDACS | `gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP` | No | proxy |
| **Place search** | OSM Nominatim | `nominatim.openstreetmap.org/search` | No | proxy |
| **Country borders** | Natural Earth (110m) | GitHub raw GeoJSON | No | browser-direct |
| **Maritime vessels** | AIS Hub | `data.aishub.net/ws.php` | Yes (free, optional) | proxy |
| **Satellite surface** | NASA Blue Marble texture / NASA GIBS daily imagery (WMS) | `gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi` | No | browser-direct |

All upstream calls go through the single Vercel function `/api/feed`, which adds permissive CORS
and edge caching — **except aircraft**, see the architecture note below.

---

## Why aircraft is handled differently (architecture note)

OpenSky (the previous aircraft source) and the community ADS-B feeds **block datacenter IPs**, so
fetching them server-side from Vercel returns `403`. The fix:

- **Aircraft / military:** fetched **directly from the user's browser** (a residential IP, which the
  feeds accept), querying around the current camera view (feeds cap radius at ~250 NM). If a
  browser request hits CORS/403 it falls back to the next feed, then to the `/api/feed` proxy.

Please don't "simplify" aircraft back into a plain server-side fetch — it will break.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AISHUB_KEY` | No | Enables the ships layer. Free signup at [aishub.net](https://www.aishub.net/). Without it the layer is silently hidden. |

> Node **22.x** required.

---

## Features

- **Distinct node design** — every layer has its own SVG glyph (quake epicenter rings, flame,
  volcano+plume, cyclone, water waves, plane, military diamond, conflict burst), signature
  colour, size-by-severity, heading rotation (aircraft) and pulse/alert animation. Emergency
  transponder squawks (7500 hijack / 7600 radio-fail / 7700 emergency) flash an alert.
- **Disaster alerts (GDACS)** — multi-hazard alerts (cyclones, floods, quakes, droughts, volcanoes,
  wildfires) coloured by alert level (green/orange/red); red alerts pulse with an expanding ring.
- **Grouped, collapsible legend** (Hazards / Alerts / Conflict / Air) — click a row to toggle a
  layer, a group header to collapse it.
- **Satellite surface cycle** — the surface button cycles night-Earth → daytime Blue Marble →
  live NASA GIBS daily satellite imagery (fetched as a full-world WMS image, so it follows the
  time scrubber).
- **Global time scrubber** — drag back up to 30 days to replay quakes, hazards, and conflict
  events together. Live-only layers (aircraft) hide during playback; the **LIVE** button returns
  everything to realtime.
- **Geospatial tools** — country borders, place search (fly-to), day/night terminator overlay, and
  click-two-points distance measurement (km / NM).

---

## Run locally

```bash
npm run dev          # → http://localhost:4321  (no deps, no Vercel CLI needed)
```

`dev-server.js` runs the `/api/feed` function in-process so every layer works locally.

---

## Deploy

1. Push to GitHub.
2. Import at [vercel.com/new](https://vercel.com/new) (zero config).
3. Every `git push` auto-redeploys.

---

## Attribution & licenses

- Concept inspired by **[worldmonitor.app](https://worldmonitor.app/)** ([source](https://github.com/koala73/worldmonitor)).
- **USGS**, **NASA EONET / Blue Marble / GIBS** — public domain.
- **ADS-B**: adsb.lol / airplanes.live / adsb.one — community feeds; respect their non-commercial terms.
- **AIS Hub** — maritime vessel tracking; free tier requires attribution and non-commercial use.
- **GDELT** — [The GDELT Project](https://www.gdeltproject.org/).
- **GDACS** — [Global Disaster Alert and Coordination System](https://www.gdacs.org/) (UN/EC JRC).
- **OpenStreetMap / Nominatim** — © OpenStreetMap contributors, per the
  [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max 1 req/s).
- **Natural Earth** — public domain.
- Visualization built with [globe.gl](https://globe.gl/) (three.js).

Licensed **AGPL-3.0**.
