# 🌍 World Globe — Live Planetary Intelligence

A real-time 3D globe visualizing live world-event feeds: earthquakes, wildfires, volcanoes, severe storms, floods, and live air-traffic positions. Each data category gets a distinct visual treatment so the globe reads as a stratified intelligence display.

**Concept & aggregation strategy inspired by [worldmonitor.app](https://worldmonitor.app/)**, an open-source global intelligence dashboard. Because their hosted API requires a key, we proxy directly to the same free public upstream sources WorldMonitor itself aggregates from — keeping the project free, auth-less, and self-deployable.

---

## Live data sources (all free, no keys)

| Layer | Source | Endpoint |
|---|---|---|
| **Earthquakes** | USGS Earthquake Hazards Program | `earthquake.usgs.gov/.../summary/all_day.geojson` |
| **Wildfires** | NASA EONET (Earth Observatory Natural Event Tracker) | `eonet.gsfc.nasa.gov/api/v3/events` (category `wildfires`) |
| **Volcanoes** | NASA EONET | same (category `volcanoes`) |
| **Severe storms** | NASA EONET | same (category `severeStorms`) |
| **Floods** | NASA EONET | same (category `floods`) |
| **Aircraft** | OpenSky Network states API | `opensky-network.org/api/states/all` |

All of these are public datasets used by WorldMonitor too. We proxy them through a single Vercel Edge function (`/api/feed`) which adds permissive CORS headers and 30–600 s edge caching so we stay within the upstreams' rate limits (OpenSky in particular).

---

## Architecture

```
worldart-globe/
├── public/index.html       Globe + HUD + tooltip
│                           (globe.gl on top of three.js)
├── api/feed.js             Vercel Edge function — single dynamic proxy
│                           Routes ?source=earthquakes|events|aircraft
│                           to the right upstream URL with edge cache.
├── vercel.json             Static + API routing + CORS headers
├── package.json
└── README.md
```

### Visual style per layer

| Layer | Visual | Color |
|---|---|---|
| Earthquakes | Vertical pillars, height ∝ magnitude · pulse rings on M4.5+ | Cyan `#6cdfff` |
| Wildfires | Glow dots | Orange `#ff6020` |
| Volcanoes | Dots with constant pulse rings | Yellow `#ffd400` |
| Severe storms | Large dots with wide pulse rings | Magenta `#ff44cc` |
| Floods | Mid-size flat dots | Blue `#3a82ff` |
| Aircraft | Heading-projected animated arcs at altitude | White `#ffffff` |

### Refresh cadences

- Earthquakes: **60 s** (USGS updates every minute)
- EONET events (fires/volcanoes/storms/floods): **5 min**
- Aircraft: **30 s** (respects OpenSky anonymous rate cap with edge cache)

---

## Run locally

```bash
npm install -g vercel        # one-time
vercel dev                    # → http://localhost:3000
```

The Vercel runtime simulates the `/api/feed` edge function so the full experience works locally. Any plain static server works for the globe shell but the data feeds need the edge function.

---

## Deploy

1. Push this folder to a GitHub repo
2. Import the repo at [vercel.com/new](https://vercel.com/new) — zero config needed
3. Get a permanent URL like `https://<your-name>.vercel.app`
4. Every `git push` auto-redeploys

---

## Attribution

- Aggregation idea & cross-domain composition inspired by **[worldmonitor.app](https://worldmonitor.app/)** ([source on GitHub](https://github.com/koala73/worldmonitor)). Please support upstream.
- Data: USGS · NASA EONET · OpenSky Network. All credit to those programs.
- Visualization built with [globe.gl](https://globe.gl/) (three.js).

Licensed **AGPL-3.0**.
