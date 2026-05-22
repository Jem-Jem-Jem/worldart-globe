// Single dynamic proxy that forwards to free public data sources.
// Runs as a standard Vercel Node.js Serverless Function.
//
// Usage:
//   /api/feed?source=earthquakes[&from=ISO&to=ISO]
//   /api/feed?source=events[&from=ISO&to=ISO]
//   /api/feed?source=aircraft&lat=..&lon=..&dist=..   (browser uses feeds direct; this is a fallback)
//   /api/feed?source=ships&bbox=west,south,east,north
//   /api/feed?source=gdelt[&from=ISO&to=ISO]
//   /api/feed?source=deepstate[&ts=UNIX_SECONDS]
//   /api/feed?source=geocode&q=...
//
// Aircraft + AIS deliberately are NOT the primary path from this server: community
// ADS-B feeds and AIS providers block datacenter IPs, so the browser fetches ADS-B
// directly (residential IP). AIS is the exception — its key must stay server-side,
// so we open a short-lived WebSocket snapshot here.

const DEFAULT_TTL = 60;

function gdeltStamp(iso) {
  // GDELT wants YYYYMMDDHHMMSS (UTC)
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Resolve a request into an upstream URL + cache TTL. Returns null for sources
// that need special (non-passthrough) handling (ships).
function resolveUpstream(source, params) {
  switch (source) {
    case 'earthquakes': {
      const from = params.get('from');
      const to   = params.get('to');
      if (from || to) {
        const u = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
        u.searchParams.set('format', 'geojson');
        if (from) u.searchParams.set('starttime', from);
        if (to)   u.searchParams.set('endtime', to);
        u.searchParams.set('limit', '2000');
        u.searchParams.set('orderby', 'time');
        return { url: u.toString(), ttl: 600 };
      }
      return { url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', ttl: 60 };
    }
    case 'events': {
      const from = params.get('from');
      const to   = params.get('to');
      const u = new URL('https://eonet.gsfc.nasa.gov/api/v3/events');
      u.searchParams.set('limit', '600');
      if (from || to) {
        u.searchParams.set('status', 'all');
        if (from) u.searchParams.set('start', from.slice(0, 10));
        if (to)   u.searchParams.set('end', to.slice(0, 10));
      } else {
        u.searchParams.set('status', 'open');
      }
      return { url: u.toString(), ttl: 600 };
    }
    case 'aircraft': {
      // Fallback only — primary path is browser-direct to community feeds.
      const lat  = params.get('lat');
      const lon  = params.get('lon');
      const dist = params.get('dist') || '250';
      if (lat != null && lon != null) {
        return { url: `https://api.adsb.lol/v2/point/${lat}/${lon}/${dist}`, ttl: 15 };
      }
      return { url: 'https://api.adsb.lol/v2/mil', ttl: 15 };
    }
    case 'gdelt': {
      const query = '(conflict OR airstrike OR shelling OR offensive OR clashes OR militants OR insurgency)';
      const u = new URL('https://api.gdeltproject.org/api/v2/geo/geo');
      u.searchParams.set('query', query);
      u.searchParams.set('format', 'GeoJSON');
      u.searchParams.set('mode', 'PointData');
      const from = params.get('from');
      const to   = params.get('to');
      if (from && to) {
        const a = gdeltStamp(from), b = gdeltStamp(to);
        if (a) u.searchParams.set('startdatetime', a);
        if (b) u.searchParams.set('enddatetime', b);
      } else {
        u.searchParams.set('timespan', '1d');
      }
      return { url: u.toString(), ttl: 900 };
    }
    case 'deepstate': {
      const ts = params.get('ts');
      const seg = ts ? encodeURIComponent(ts) : 'last';
      return { url: `https://deepstatemap.live/api/history/${seg}/geojson`, ttl: 3600 };
    }
    case 'geocode': {
      const q = params.get('q') || '';
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.searchParams.set('q', q);
      u.searchParams.set('format', 'json');
      u.searchParams.set('limit', '1');
      return { url: u.toString(), ttl: 86400 };
    }
    default:
      return undefined;
  }
}

// --- AIS snapshot via aisstream.io WebSocket (key stays server-side) ----------
async function aisSnapshot(bbox) {
  const key = (process.env.AISSTREAM_API_KEY ?? '').trim();
  if (!key) return { ships: [], _disabled: 'AISSTREAM_API_KEY not set' };

  // Prefer the runtime global WebSocket (Node 22+), fall back to the `ws` package.
  let WS = globalThis.WebSocket;
  if (!WS) {
    try { WS = (await import('ws')).default; } catch { /* not installed */ }
  }
  if (!WS) return { ships: [], _unsupported: 'WebSocket not available in runtime' };

  // bbox = west,south,east,north  ->  aisstream wants [[lat1,lon1],[lat2,lon2]]
  let box = [[-90, -180], [90, 180]];
  if (bbox) {
    const [w, s, e, n] = bbox.split(',').map(Number);
    if ([w, s, e, n].every(Number.isFinite)) box = [[s, w], [n, e]];
  }

  return await new Promise((resolve) => {
    const ships = new Map();
    let ws;
    const done = () => {
      try { ws && ws.close(); } catch {}
      resolve({ ships: [...ships.values()] });
    };
    const timer = setTimeout(done, 3000);
    try {
      ws = new WS('wss://stream.aisstream.io/v0/stream');
      ws.onopen = () => ws.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [box],
        FilterMessageTypes: ['PositionReport'],
      }));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          const pr  = msg?.Message?.PositionReport;
          const meta = msg?.MetaData;
          if (!pr || meta == null) return;
          const mmsi = meta.MMSI;
          ships.set(mmsi, {
            mmsi,
            lat: pr.Latitude,
            lon: pr.Longitude,
            heading: (pr.TrueHeading != null && pr.TrueHeading < 360) ? pr.TrueHeading : pr.Cog,
            speed: pr.Sog,
            name: (meta.ShipName || '').trim(),
          });
          if (ships.size >= 500) { clearTimeout(timer); done(); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); done(); };
    } catch {
      clearTimeout(timer);
      resolve({ ships: [], _error: 'ws init failed' });
    }
  });
}

// ---------------------------------------------------------------------------
// Main handler  (req: IncomingMessage, res: ServerResponse)
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const urlObj = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const source = urlObj.searchParams.get('source');
  const params = urlObj.searchParams;

  const send = (obj, status = 200, ttl = 0) => {
    res.writeHead(status, {
      'content-type':                'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...(ttl ? { 'cache-control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` } : {}),
    });
    res.end(JSON.stringify(obj));
  };

  // AIS — special path (WebSocket snapshot, not a passthrough fetch)
  if (source === 'ships') {
    const snap = await aisSnapshot(params.get('bbox'));
    return send(snap, 200, 60);
  }

  const resolved = resolveUpstream(source, params);
  if (!resolved) {
    return send({
      error: 'Unknown or missing `source` parameter.',
      valid: ['earthquakes', 'events', 'aircraft', 'ships', 'gdelt', 'deepstate', 'geocode'],
    }, 400);
  }

  const { url: upstream, ttl } = resolved;
  const reqHeaders = {
    'User-Agent': 'worldart-globe/2.0 (non-commercial open-source; https://github.com/jem-jem-jem/worldart-globe)',
    'Accept':     'application/json,application/geo+json',
  };

  // DeepState sits behind Cloudflare and blocks non-browser agents from
  // datacenter IPs, so present browser-like headers for that source.
  if (source === 'deepstate') {
    reqHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    reqHeaders['Accept']          = 'application/json, text/plain, */*';
    reqHeaders['Accept-Language'] = 'en-US,en;q=0.9';
    reqHeaders['Referer']         = 'https://deepstatemap.live/';
    reqHeaders['Origin']          = 'https://deepstatemap.live';
  }

  try {
    const resp = await fetch(upstream, {
      headers: reqHeaders,
      signal:  AbortSignal.timeout(10_000),
    });

    if (source === 'aircraft' && [401, 403, 429].includes(resp.status)) {
      return send({ ac: [], _limited: true });
    }

    const body        = await resp.text();
    const contentType = resp.headers.get('content-type') ?? 'application/json; charset=utf-8';
    res.writeHead(resp.status, {
      'content-type':                contentType,
      'cache-control':               `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
      'access-control-allow-origin':  '*',
      'x-source':                    source,
    });
    res.end(body);
  } catch (err) {
    return send({ error: 'Upstream fetch failed', detail: String(err), upstream }, 502);
  }
}
