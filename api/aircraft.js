// Edge function: retries community ADS-B feeds from Cloudflare IPs.
// Runs on Vercel Edge Runtime (Cloudflare network), which has different IP
// ranges than Vercel's Node.js serverless functions (AWS Lambda).
//
// Usage:
//   /api/aircraft?lat=..&lon=..&dist=..   civilian aircraft in area
//   /api/aircraft                         military aircraft (global /v2/mil)
//
// Primary path is still browser-direct in index.html (residential IP).
// This edge function is the server fallback — if Cloudflare IPs are accepted
// by the feeds, aircraft will appear for users on corporate/VPN networks where
// browser-direct requests are blocked by CORS or firewall.

export const config = { runtime: 'edge' };

const ADSB_FEEDS = [
  'https://api.adsb.lol',
  'https://api.airplanes.live',
  'https://api.adsb.one',
];

const UA = 'worldart-globe/2.0 (non-commercial open-source; https://github.com/jem-jem-jem/worldart-globe)';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin':  '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age':       '86400',
      },
    });
  }

  const url   = new URL(req.url);
  const lat   = url.searchParams.get('lat');
  const lon   = url.searchParams.get('lon');
  const dist  = url.searchParams.get('dist') || '250';
  const isMil = lat == null || lon == null;

  const corsAndCache = {
    'content-type':                'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control':               'public, s-maxage=15, stale-while-revalidate=60',
  };

  const path = isMil
    ? '/v2/mil'
    : `/v2/point/${parseFloat(lat).toFixed(3)}/${parseFloat(lon).toFixed(3)}/${dist}`;

  for (const base of ADSB_FEEDS) {
    try {
      const resp = await fetch(`${base}${path}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(8_000),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data && (data.ac || data.aircraft)) {
        return new Response(JSON.stringify(data), { status: 200, headers: corsAndCache });
      }
    } catch {
      // feed unreachable from this edge node — try next
    }
  }

  return new Response(JSON.stringify({ ac: [], _limited: true }), {
    status: 200,
    headers: corsAndCache,
  });
}
