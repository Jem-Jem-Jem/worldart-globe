// Single dynamic proxy that forwards to free public data sources.
// Runs as a standard Vercel Node.js Serverless Function.
//
// Usage:
//   /api/feed?source=earthquakes[&from=ISO&to=ISO]
//   /api/feed?source=events[&from=ISO&to=ISO]
//   /api/feed?source=aircraft&lat=..&lon=..&dist=..   (browser uses feeds direct; this is a fallback)
//   /api/feed?source=gdacs
//   /api/feed?source=geocode&q=...
//   /api/feed?source=ships&lat=..&lon=..              (requires AISSTREAM_KEY env var)
//
// Aircraft is deliberately NOT the primary path from this server: community
// ADS-B feeds block datacenter IPs, so the browser fetches them directly
// (residential IP); this proxy is only a fallback.
//
// Ships (aisstream.io): requires AISSTREAM_KEY env var (free signup at aisstream.io).
// Opens a WebSocket, collects PositionReport + ShipStaticData messages for ~2.5 s,
// normalises to AIS Hub field names, and returns a { vessels: [...] } snapshot.
// Returns { vessels: [], _unconfigured: true } gracefully when key is absent.

const DEFAULT_TTL = 60;

// Resolve a request into an upstream URL + cache TTL.
// (Conflict intelligence lives in its own function — see api/intelligence.js.)
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
    case 'ships': {
      const key = process.env.AISSTREAM_KEY;
      if (!key) return { unconfigured: true };
      const lat = parseFloat(params.get('lat') || '0');
      const lon = parseFloat(params.get('lon') || '0');
      return { wsStream: true, key, lat, lon, ttl: 60 };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// aisstream.io WebSocket snapshot collector
// Opens a connection, subscribes to a lat/lon bounding box, collects
// PositionReport + ShipStaticData messages for collectMs milliseconds, then
// closes and returns an array of normalised vessel objects (AIS Hub field names).
// ---------------------------------------------------------------------------
async function collectAisStream(key, lat, lon, padDeg = 15, collectMs = 2500) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    const byMmsi = new Map();
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve([...byMmsi.values()]);
    };

    const timer = setTimeout(finish, collectMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[lat - padDeg, lon - padDeg], [lat + padDeg, lon + padDeg]]],
        FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
      }));
    });

    ws.addEventListener('message', ({ data }) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : String(data));
        const mmsi = msg.MetaData?.MMSI;
        if (!mmsi) return;
        const existing = byMmsi.get(mmsi) || {};
        const meta = msg.MetaData || {};

        if (msg.MessageType === 'PositionReport') {
          const p = msg.Message?.PositionReport || {};
          byMmsi.set(mmsi, {
            ...existing,
            MMSI:      mmsi,
            LATITUDE:  meta.latitude  ?? existing.LATITUDE,
            LONGITUDE: meta.longitude ?? existing.LONGITUDE,
            NAME:      meta.ShipName?.trim()  || existing.NAME  || null,
            COG:       p.Cog    ?? existing.COG,
            SOG:       p.Sog    ?? existing.SOG,
            HEADING:   (p.TrueHeading != null && p.TrueHeading !== 511)
                         ? p.TrueHeading : (existing.HEADING ?? null),
          });
        } else if (msg.MessageType === 'ShipStaticData') {
          const s = msg.Message?.ShipStaticData || {};
          byMmsi.set(mmsi, {
            ...existing,
            MMSI:      mmsi,
            LATITUDE:  meta.latitude  ?? existing.LATITUDE,
            LONGITUDE: meta.longitude ?? existing.LONGITUDE,
            NAME:      s.Name?.trim() || meta.ShipName?.trim() || existing.NAME || null,
            TYPE:      s.TypeOfShipAndCargo ?? existing.TYPE,
            DEST:      s.Destination?.trim() || existing.DEST || null,
          });
        }
      } catch {}
    });

    ws.addEventListener('error', () => { clearTimeout(timer); finish(); });
    ws.addEventListener('close', () => { clearTimeout(timer); finish(); });
  });
}

// ---------------------------------------------------------------------------
// Main handler  (req: IncomingMessage, res: ServerResponse)
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age':       '86400',
    });
    res.end();
    return;
  }

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
      valid: ['earthquakes', 'events', 'aircraft', 'gdacs', 'geocode', 'ships'],
    }, 400);
  }
  if (resolved.unconfigured) {
    return send({ vessels: [], _unconfigured: true });
  }

  // WebSocket snapshot path (ships via aisstream.io)
  if (resolved.wsStream) {
    try {
      const vessels = await collectAisStream(resolved.key, resolved.lat, resolved.lon);
      if (debug) {
        return send({ source: 'ships', provider: 'aisstream.io', collected: vessels.length,
                      sample: vessels.slice(0, 3) });
      }
      return send({ vessels }, 200, resolved.ttl);
    } catch (err) {
      return send({ vessels: [], _error: String(err) }, 200, 0);
    }
  }

  const { url: upstream, ttl } = resolved;
  const reqHeaders = {
    'User-Agent': 'worldart-globe/2.0 (non-commercial open-source; https://github.com/jem-jem-jem/worldart-globe)',
    'Accept':     'application/json,application/geo+json',
  };

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
