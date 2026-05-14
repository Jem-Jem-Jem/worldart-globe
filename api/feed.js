// Single dynamic proxy that forwards to free public data sources.
// Runs as a standard Vercel Node.js Serverless Function (AWS Lambda).
//
// Usage: /api/feed?source=earthquakes | events | aircraft

const SOURCES = {
  earthquakes: {
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    ttl: 60,
  },
  events: {
    url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=600',
    ttl: 600,
  },
  aircraft: {
    url: 'https://opensky-network.org/api/states/all',
    ttl: 30,
  },
};

// ---------------------------------------------------------------------------
// OpenSky OAuth2 token cache (module-scope survives warm Lambda invocations)
// ---------------------------------------------------------------------------
let _oskyToken    = null;
let _oskyTokenExp = 0;

async function getOpenSkyToken() {
  if (_oskyToken && Date.now() < _oskyTokenExp - 60_000) return _oskyToken;

  const clientId     = (process.env.OPENSKY_CLIENT_ID     ?? '').trim();
  const clientSecret = (process.env.OPENSKY_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;

  try {
    const resp = await fetch(
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        },
        body:   'grant_type=client_credentials',
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!resp.ok) return null;
    const data    = await resp.json();
    _oskyToken    = data.access_token ?? null;
    _oskyTokenExp = Date.now() + (data.expires_in ?? 3600) * 1000;
    return _oskyToken;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main handler  (req: IncomingMessage, res: ServerResponse)
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const urlObj = new URL(req.url, `https://${req.headers.host}`);
  const source = urlObj.searchParams.get('source');

  const send = (obj, status = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type':               'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    res.end(body);
  };

  if (!source || !(source in SOURCES)) {
    return send({ error: 'Unknown or missing `source` parameter.', valid: Object.keys(SOURCES) }, 400);
  }

  // ------- Debug mode: ?source=aircraft&debug=1 ----------------------------
  if (source === 'aircraft' && urlObj.searchParams.get('debug') === '1') {
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
              'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
            },
            body:   'grant_type=client_credentials',
            signal: AbortSignal.timeout(8000),
          },
        );
        const txt = await tr.text();
        tokenResult = `HTTP ${tr.status} — ${txt.slice(0, 300)}`;
      } catch (e) {
        tokenResult = `fetch error: ${e}`;
      }
    }
    return send({ hasClientId: hasId, hasClientSecret: hasSec, tokenResult });
  }
  // -------------------------------------------------------------------------

  const { url: upstream, ttl } = SOURCES[source];

  const reqHeaders = {
    'User-Agent': 'worldart-globe/1.0 (non-commercial open-source)',
    'Accept':     'application/json,application/geo+json',
  };

  if (source === 'aircraft') {
    const token = await getOpenSkyToken();
    if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(upstream, {
      headers: reqHeaders,
      signal:  AbortSignal.timeout(10_000),
    });

    if (source === 'aircraft' && [401, 403, 429].includes(resp.status)) {
      return send({ states: [], time: Date.now() / 1000, _limited: true });
    }

    const body        = await resp.text();
    const contentType = resp.headers.get('content-type') ?? 'application/json; charset=utf-8';
    res.writeHead(resp.status, {
      'content-type':               contentType,
      'cache-control':              `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
      'access-control-allow-origin': '*',
      'x-source':                   source,
      'x-upstream':                 upstream,
    });
    res.end(body);
  } catch (err) {
    if (source === 'aircraft') {
      return send({ states: [], time: Date.now() / 1000, _error: String(err) });
    }
    return send({ error: 'Upstream fetch failed', detail: String(err), upstream }, 502);
  }
}
