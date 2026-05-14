// Single dynamic proxy that forwards to free public data sources.
// Originally targeted api.worldmonitor.app, but their hosted API requires
// an API key. Since this project is non-commercial, we proxy directly to
// the same public upstream sources WorldMonitor itself aggregates.
//
// Usage: /api/feed?source=earthquakes | events | aircraft
//
// Edge runtime keeps cold starts near-zero. Cache headers are set
// generously so we stay within the public sources' rate limits
// (OpenSky in particular is 1 request / 10s for anonymous callers).

export const config = { runtime: 'edge' };

const SOURCES = {
  // USGS Earthquake Hazards Program — last 24 h, all magnitudes
  earthquakes: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    ttl: 60,    // USGS updates every minute
  },
  // NASA EONET v3 — Earth Observatory Natural Event Tracker
  // Returns open events across wildfires, volcanoes, severe storms,
  // floods, and many other categories. Frontend splits by category.
  events: {
    url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=600',
    ttl: 600,   // EONET refreshes on slow cadence
  },
  // OpenSky Network — all active aircraft states (positional)
  aircraft: {
    url: 'https://opensky-network.org/api/states/all',
    ttl: 30,    // hammered at full rate is rude; 30s edge cache is friendly
  },
};

export default async function handler(req) {
  const url    = new URL(req.url);
  const source = url.searchParams.get('source');

  if (!source || !(source in SOURCES)) {
    return json({
      error: 'Unknown or missing `source` parameter.',
      valid: Object.keys(SOURCES),
    }, 400);
  }

  const { url: upstream, ttl } = SOURCES[source];

  try {
    const resp = await fetch(upstream, {
      headers: {
        'User-Agent': 'worldart-globe/1.0 (https://github.com/koala73/worldmonitor inspired)',
        'Accept': 'application/json,application/geo+json',
      },
      cf: { cacheTtl: ttl },
    });

    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
        'access-control-allow-origin': '*',
        'x-source': source,
        'x-upstream': upstream,
      },
    });
  } catch (err) {
    return json({ error: 'Upstream fetch failed', detail: String(err), upstream }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
