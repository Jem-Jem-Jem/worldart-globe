// Single dynamic proxy that forwards to free public data sources.
// Runs as a standard Vercel Node.js Serverless Function.
//
// Usage:
//   /api/feed?source=earthquakes[&from=ISO&to=ISO]
//   /api/feed?source=events[&from=ISO&to=ISO]
//   /api/feed?source=aircraft&lat=..&lon=..&dist=..   (browser uses feeds direct; this is a fallback)
//   /api/feed?source=gdelt[&from=ISO&to=ISO]
//   /api/feed?source=gdacs
//   /api/feed?source=geocode&q=...
//
// Aircraft is deliberately NOT the primary path from this server: community
// ADS-B feeds block datacenter IPs, so the browser fetches them directly
// (residential IP); this proxy is only a fallback.

const DEFAULT_TTL = 60;

function gdeltStamp(iso) {
  // GDELT wants YYYYMMDDHHMMSS (UTC)
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// Resolve a request into an upstream URL + cache TTL.
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
    case 'gdacs': {
      // Global Disaster Alert & Coordination System — last ~100 events / 4 days
      // as a GeoJSON FeatureCollection with per-event alert levels (Green/Orange/Red).
      return { url: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP', ttl: 900 };
    }
    case 'geocode': {
      const q = params.get('q') || '';
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.searchParams.set('q', q);
      u.searchParams.set('format', 'json');
      u.searchParams.set('limit', '1');
      return { url: u.toString(), ttl: 86400 };
    }
    case 'tile': {
      // Proxy NASA GIBS WMTS tiles so the browser receives them same-origin,
      // bypassing the WebGL cross-origin texture rejection that blocks direct tile loads.
      const layer = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
      const date  = params.get('date') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const z = params.get('z') ?? '1';
      const x = params.get('x') ?? '0';
      const y = params.get('y') ?? '0';
      // WMTS row/col order: z / TileRow(y) / TileCol(x)
      return {
        url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible/${z}/${y}/${x}.jpg`,
        ttl: 86400,
      };
    }
    default:
      return undefined;
  }
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

  const debug = params.get('debug') === '1';

  const resolved = resolveUpstream(source, params);
  if (!resolved) {
    return send({
      error: 'Unknown or missing `source` parameter.',
      valid: ['earthquakes', 'events', 'aircraft', 'gdelt', 'gdacs', 'geocode', 'tile'],
    }, 400);
  }

  const { url: upstream, ttl } = resolved;
  const isTile = source === 'tile';
  const reqHeaders = {
    'User-Agent': 'worldart-globe/2.0 (non-commercial open-source; https://github.com/jem-jem-jem/worldart-globe)',
    'Accept':     isTile ? 'image/jpeg,image/*' : 'application/json,application/geo+json',
  };

  try {
    const resp = await fetch(upstream, {
      headers: reqHeaders,
      signal:  AbortSignal.timeout(10_000),
    });

    if (source === 'aircraft' && [401, 403, 429].includes(resp.status)) {
      return send({ ac: [], _limited: true });
    }

    // Tiles are binary — stream as arrayBuffer to avoid text encoding corruption.
    if (isTile) {
      const buf = await resp.arrayBuffer();
      res.writeHead(resp.status, {
        'content-type':                'image/jpeg',
        'cache-control':               `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
        'access-control-allow-origin': '*',
      });
      res.end(Buffer.from(buf));
      return;
    }

    const body        = await resp.text();
    const contentType = resp.headers.get('content-type') ?? 'application/json; charset=utf-8';

    // ?debug=1 — surface exactly what the upstream returned (status, type, snippet).
    if (debug) {
      return send({
        source, upstream, status: resp.status, contentType,
        bodyStart: body.slice(0, 600), length: body.length,
      });
    }

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
