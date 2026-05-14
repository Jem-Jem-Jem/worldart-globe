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
  // Anonymous access is heavily rate-limited and often blocked on cloud IPs.
  // Set OPENSKY_USER + OPENSKY_PASS env vars (free account at opensky-network.org)
  // to use authenticated access (10× higher rate limit, no IP blocking).
  aircraft: {
    url: 'https://opensky-network.org/api/states/all',
    ttl: 30,    // 30s edge cache keeps us friendly with upstream
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

  // Build request headers — add Basic auth for OpenSky if credentials are set
  const reqHeaders = {
    'User-Agent': 'worldart-globe/1.0 (non-commercial open-source)',
    'Accept': 'application/json,application/geo+json',
  };

  if (source === 'aircraft') {
    const user = globalThis.process?.env?.OPENSKY_USER ?? '';
    const pass = globalThis.process?.env?.OPENSKY_PASS ?? '';
    if (user && pass) {
      reqHeaders['Authorization'] = 'Basic ' + btoa(`${user}:${pass}`);
    }
  }

  try {
    const resp = await fetch(upstream, {
      headers: reqHeaders,
      cf: { cacheTtl: ttl },
      signal: AbortSignal.timeout(8000),   // don't hang longer than 8s
    });

    // OpenSky returns 429 when rate-limited — surface a clean empty payload
    // rather than letting the globe show a broken state.
    if (source === 'aircraft' && (resp.status === 429 || resp.status === 403)) {
      return json({ states: [], time: Date.now() / 1000, _limited: true }, 200);
    }

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
    // Network-level failure (timeout, DNS, IP block) — return empty aircraft
    // payload so the globe continues to render the other layers normally.
    if (source === 'aircraft') {
      return json({ states: [], time: Date.now() / 1000, _error: String(err) }, 200);
    }
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
