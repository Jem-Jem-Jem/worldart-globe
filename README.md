# 🌍 World Globe — Live Planetary Intelligence

A real-time 3D globe visualizing live world-event feeds: earthquakes, wildfires, volcanoes,
severe storms, floods, live air & sea traffic, and open-source conflict intelligence. Each data
category gets a **distinct icon, colour and motion** so the globe reads as a stratified
intelligence display, with a switchable satellite surface, a global time scrubber, and basic
geospatial tools.

**Concept inspired by [worldmonitor.app](https://worldmonitor.app/).** We proxy directly to free
public upstream sources, keeping the project free, mostly key-less, and self-deployable.

---

## Live data sources

| Layer | Source | Endpoint | Key | Path |
|---|---|---|---|---|
| **Earthquakes** | USGS | `…/summary/all_day.geojson` (live) · `fdsnws/event` (history) | No | proxy |
| **Wildfires / Volcanoes / Storms / Floods** | NASA EONET v3 | `eonet.gsfc.nasa.gov/api/v3/events` | No | proxy |
| **Aircraft** | adsb.lol → airplanes.live → adsb.one | `/v2/point/{lat}/{lon}/250` | No | **browser-direct** (proxy fallback) |
| **Military aircraft** | adsb.lol (and fallbacks) | `/v2/mil` | No | browser-direct (proxy fallback) |
| **Ships (AIS)** | aisstream.io | `wss://stream.aisstream.io/v0/stream` | **Free key** | proxy (WS snapshot) |
| **Conflict events** | GDELT GEO 2.0 | `api.gdeltproject.org/api/v2/geo/geo` | No | proxy |
| **Ukraine frontline** | DeepState Map | `deepstatemap.live/api/history/{ts}/geojson` | No | proxy |
| **Place search** | OSM Nominatim | `nominatim.openstreetmap.org/search` | No | proxy |
| **Country borders** | Natural Earth (110m) | GitHub raw GeoJSON | No | browser-direct |
| **Satellite surface** | NASA Blue Marble texture (Phase A) / NASA GIBS tiles (Phase B) | — | No | browser-direct |

All upstream calls go through the single Vercel function `/api/feed`, which adds permissive CORS
and edge caching — **except aircraft/AIS**, see the architecture note below.

---

## Why aircraft & AIS are handled differently (architecture note)

OpenSky (the previous aircraft source) and the community ADS-B feeds **block datacenter IPs**, so
fetching them server-side from Vercel returns `403`. The fix:

- **Aircraft / military:** fetched **directly from the user's browser** (a residential IP, which the
  feeds accept), querying around the current camera view (feeds cap radius at ~250 NM). If a
  browser request hits CORS/403 it falls back to the next feed, then to the `/api/feed` proxy.
- **AIS ships:** aisstream.io is a WebSocket and its key must stay secret, so `/api/feed?source=ships`
  opens a **short-lived (~3 s) WebSocket snapshot** server-side, filtered to the requested bounding
  box, and returns a plain JSON array — fitting the existing polling model without leaking the key.

Please don't "simplify" aircraft/AIS back into a plain server-side fetch — it will break.

---

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `AISSTREAM_API_KEY` | Optional (enables the Ships layer) | Free key from [aisstream.io](https://aisstream.io/) (sign in with GitHub → create an API key). Set it in **Vercel → Project → Settings → Environment Variables**. Without it the Ships layer self-disables gracefully. |

> Node **20+** recommended; the AIS snapshot uses the runtime's global `WebSocket` (Node 22+). On
> older runtimes the Ships layer returns empty rather than erroring.

---

## Features

- **Distinct node design** — every layer has its own SVG glyph (quake epicenter rings, flame,
  volcano+plume, cyclone, water waves, plane, military diamond, ship, conflict burst), signature
  colour, size-by-severity, heading rotation (aircraft/ships) and pulse/alert animation. Emergency
  transponder squawks (7500 hijack / 7600 radio-fail / 7700 emergency) flash an alert.
- **Grouped, collapsible legend** (Hazards / Conflict / Air / Sea) — click a row to toggle a layer,
  a group header to collapse it.
- **Satellite surface toggle** — swap the night-Earth texture for daytime Blue Marble (Phase A).
  Phase B (zoomable NASA GIBS tiles via globe.gl's `globeTileEngineUrl`) is a planned follow-up.
- **Global time scrubber** — drag back up to 30 days to replay quakes, hazards, conflict events and
  the DeepState frontline together. Live-only layers (aircraft, ships) hide during playback; the
  **LIVE** button returns everything to realtime.
- **Geospatial tools** — country borders, place search (fly-to), day/night terminator overlay, and
  click-two-points distance measurement (km / NM).

---

## Run locally

```bash
npm run dev          # → http://localhost:4321  (no deps, no Vercel CLI needed)
```

`dev-server.js` runs the `/api/feed` function in-process so every layer works locally. To exercise
the Ships layer locally, export `AISSTREAM_API_KEY=…` before starting.

---

## Deploy

1. Push to GitHub.
2. Import at [vercel.com/new](https://vercel.com/new) (zero config).
3. (Optional) add `AISSTREAM_API_KEY` for ships.
4. Every `git push` auto-redeploys.

---

## Attribution & licenses

- Concept inspired by **[worldmonitor.app](https://worldmonitor.app/)** ([source](https://github.com/koala73/worldmonitor)).
- **USGS**, **NASA EONET / Blue Marble / GIBS** — public domain.
- **ADS-B**: adsb.lol / airplanes.live / adsb.one — community feeds; respect their non-commercial terms.
- **AIS**: [aisstream.io](https://aisstream.io/).
- **GDELT** — [The GDELT Project](https://www.gdeltproject.org/).
- **DeepState Map** — [deepstatemap.live](https://deepstatemap.live/), used under their
  **non-commercial** [license](https://deepstatemap.live/license-en.html).
- **OpenStreetMap / Nominatim** — © OpenStreetMap contributors, per the
  [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max 1 req/s).
- **Natural Earth** — public domain.
- Visualization built with [globe.gl](https://globe.gl/) (three.js).

Licensed **AGPL-3.0**.
