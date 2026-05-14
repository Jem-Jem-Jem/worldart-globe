// Single dynamic proxy that forwards to free public data sources.
//
// Usage: /api/feed?source=earthquakes | events | aircraft
//
// Edge runtime keeps cold starts near-zero. Cache headers are set
// generously so we stay within the public sources' rate limits.

// Switched to Node.js serverless runtime (AWS Lambda IPs) instead of Edge
// (Cloudflare IPs) because OpenSky blocks most Cloudflare egress ranges.
export const config = { runtime: 'nodejs' };

const SOURCES = {
  // USGS Earthquake Hazards Program — last 24 h, all magnitudes
  earthquakes: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    ttl: 60,
  },
  // NASA EONET v3 — Earth Observatory Natural Event Tracker
  events: {
    url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=600',
    ttl: 600,
  },
  // OpenSky Network — all active aircraft states (positional)
  // Uses OAuth2 client credentials (OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET).
  // Falls back to an empty payload if credentials are missing or upstream fails.
  aircraft: {
    url: 'https://opensky-network.org/api/states/all',
    ttl: 30,
  },
};

// ---------------------------------------------------------------------------
// OpenSky OAuth2 — client credentials flow
// Token is cached at module scope so warm edge instances reuse it.
// ---------------------------------------------------------------------------
let _oskyToken    = null;
let _oskyTokenExp = 0;   // unix ms

async function getOpenSkyToken() {
  if (_oskyToken && Date.now() < _oskyTokenExp - 60_000) return _oskyToken;

  const clientId     = (globalThis.process?.env?.OPENSKY_CLIENT_ID     ?? '').trim();
  const clientSecret = (globalThis.process?.env?.OPENSKY_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;

  try {
    const resp = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
        },
        body:   'grant_type=client_credentials',
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!resp.ok) return null;
    const data     = await resp.json();
    _oskyToken     = data.access_token ?? null;
    _oskyTokenExp  = Date.now() + (data.expires_in ?? 3600) * 1000;
    return _oskyToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req) {
  const url    = new URL(req.url);
  const source = url.searchParams.get('source');

  // Debug mode: ?source=aircraft&debug=1
  // Shows whether env vars are loaded and whether the token exchange works.
  if (source === 'aircraft' && url.searchParams.get('debug') === '1') {
    const clientId     = (process.env.OPENSKY_CLIENT_ID     ?? '').trim();
    const clientSecret = (process.env.OPENSKY_CLIENT_SECRET ?? '').trim();
    const hasId  = clientId.length > 0;
    const hasSec = clientSecret.length > 0;
    let tokenResult = 'not attempted (missing credentials)';
    if (hasId && hasSec) {
      try {
        const tr = await fetch(
          'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
          {
            method: 'POST',
            headers: {
              'Content-Type':  'application/x-www-form-urlencoded',
              'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
            },
            body:   'grant_type=client_credentials',
            signal: AbortSignal.timeout(8000),
          },
        );
        tokenResult = `HTTP ${tr.status} — ${await tr.text()}`;
      } catch (e) {
        tokenResult = `fetch error: ${e}`;
      }
    }
    return json({ hasClientId: hasId, hasClientSecret: hasSec, tokenResult });
  }

  if (!source || !(source in SOURCES)) {
    return json({
      error: 'Unknown or missing `source` parameter.',
      valid: Object.keys(SOURCES),
    }, 400);
  }

  const { url: upstream, ttl } = SOURCES[source];

  const reqHeaders = {
    'User-Agent': 'worldart-globe/1.0 (non-commercial open-source)',
    'Accept':     'application/json,application/geo+json',
  };

  // Attach Bearer token for aircraft requests
  if (source === 'aircraft') {
    const token = await getOpenSkyToken();
    if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(upstream, {
      headers: reqHeaders,
      cf: { cacheTtl: ttl },
      signal: AbortSignal.timeout(8000),
    });

    // Rate-limited or blocked — return empty payload so globe stays healthy
    if (source === 'aircraft' && (resp.status === 429 || resp.status === 403 || resp.status === 401)) {
      return json({ states: [], time: Date.now() / 1000, _limited: true }, 200);
    }

    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        'content-type':              resp.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control':             `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
        'access-control-allow-origin': '*',
        'x-source':                  source,
        'x-upstream':                upstream,
      },
    });
  } catch (err) {
    // Network-level failure — degrade gracefully for aircraft, hard error otherwise
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
      'content-type':              'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}
