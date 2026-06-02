// Conflict / OSINT intelligence layer.
//
// Replaces the dead GDELT GEO 2.0 endpoint with a news → LLM pipeline:
//   1. Fetch a handful of free, key-less RSS wire feeds (Google News conflict
//      query, BBC World, Al Jazeera, UN News).
//   2. Parse the XML, dedupe, keep the most recent headlines.
//   3. Make a SINGLE Gemini call that geotags + analyses the batch, returning
//      structured nodes (lat/lon, event type, severity, a short analysis).
//
// Usage:
//   /api/intelligence            → { items: [...], generated: ISO }
//   /api/intelligence?debug=1    → diagnostics (feed counts, model, raw sample)
//
// Requires GEMINI_API_KEY. Without it the endpoint returns
// { items: [], _unconfigured: true } and the front-end silently hides the layer
// (same pattern as the ships layer / AISSTREAM_KEY).
//
// Model is overridable via GEMINI_MODEL (default: gemini-1.5-flash). The call is
// cached at the edge for 30 min (s-maxage=1800) so the free tier comfortably
// covers it — at most ~48 model calls/day.

const RSS_FEEDS = [
  { name: 'Google News',
    url: 'https://news.google.com/rss/search?q=' +
         encodeURIComponent('(conflict OR airstrike OR offensive OR clashes OR militants OR shelling OR attack OR ceasefire) when:1d') +
         '&hl=en-US&gl=US&ceid=US:en' },
  { name: 'BBC World',     url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera',    url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'UN News',       url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
];

const MAX_HEADLINES = 60;   // sent to the model
const MAX_ITEMS      = 45;   // returned to the client
const CACHE_TTL      = 1800; // 30 min edge cache

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const EVENT_TYPES  = ['Armed conflict', 'Airstrike', 'Terrorism', 'Civil unrest',
                      'Political crisis', 'Humanitarian', 'Cyber', 'Other'];

// --- tiny, dependency-free helpers --------------------------------------

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

// Extract <item> (RSS) and <entry> (Atom) blocks into normalised records.
function parseFeed(xml, sourceName) {
  const out = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    let link = tag(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);   // Atom <link href="">
      if (m) link = m[1];
    }
    const dateStr = tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published');
    const ts = Date.parse(dateStr);
    out.push({
      title,
      link,
      source: sourceName,
      published: isNaN(ts) ? null : new Date(ts).toISOString(),
      _ts: isNaN(ts) ? 0 : ts,
    });
  }
  return out;
}

async function fetchFeed(feed) {
  try {
    const resp = await fetch(feed.url, {
      headers: { 'User-Agent': 'worldart-globe/2.0 (+https://github.com/jem-jem-jem/worldart-globe)' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    return parseFeed(await resp.text(), feed.name);
  } catch {
    return [];
  }
}

async function gatherHeadlines() {
  const lists = await Promise.all(RSS_FEEDS.map(fetchFeed));
  const seen  = new Set();
  const all   = [];
  for (const list of lists) {
    for (const it of list) {
      const key = it.title.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(it);
    }
  }
  all.sort((a, b) => b._ts - a._ts);   // newest first
  return all.slice(0, MAX_HEADLINES);
}

// --- Gemini -------------------------------------------------------------

function buildPrompt(headlines) {
  const list = headlines
    .map((h, i) => `${i}. [${h.source}] ${h.title}`)
    .join('\n');
  return [
    'You are a geopolitical OSINT analyst. Below is a numbered list of recent news headlines.',
    'Select ONLY items that describe a concrete conflict, security, military, terrorism,',
    'civil-unrest, political-crisis or humanitarian-emergency event tied to a SPECIFIC,',
    'identifiable place. Ignore sports, business, entertainment, opinion, weather and',
    'vague/global items with no clear location.',
    '',
    'For each selected item return an object with:',
    '- index: the headline number it came from',
    '- place: the most specific location name (city/region, country)',
    '- country: country name',
    '- lat, lon: approximate decimal coordinates of that location',
    `- eventType: one of ${EVENT_TYPES.join(', ')}`,
    '- severity: integer 1 (minor) to 5 (major/mass-casualty or strategic)',
    '- summary: 2-3 sentence neutral analytical brief of what is happening and why it matters',
    '',
    `Return at most ${MAX_ITEMS} objects, highest-severity first. If nothing qualifies, return an empty array.`,
    '',
    'HEADLINES:',
    list,
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      index:     { type: 'INTEGER' },
      place:     { type: 'STRING' },
      country:   { type: 'STRING' },
      lat:       { type: 'NUMBER' },
      lon:       { type: 'NUMBER' },
      eventType: { type: 'STRING', enum: EVENT_TYPES },
      severity:  { type: 'INTEGER' },
      summary:   { type: 'STRING' },
    },
    required: ['index', 'place', 'lat', 'lon', 'eventType', 'severity', 'summary'],
  },
};

async function analyse(key, headlines) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    signal:  AbortSignal.timeout(25_000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(headlines) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema:   RESPONSE_SCHEMA,
        temperature:      0.2,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('Gemini returned non-JSON: ' + text.slice(0, 200)); }
  if (!Array.isArray(parsed)) parsed = parsed.items || [];

  // Stitch the model output back onto the source headline (link, published, source).
  return parsed
    .filter(o => Number.isFinite(o.lat) && Number.isFinite(o.lon))
    .map(o => {
      const src = headlines[o.index] || {};
      return {
        lat: o.lat, lon: o.lon,
        place:     o.place || src.title || 'Reported location',
        country:   o.country || '',
        eventType: EVENT_TYPES.includes(o.eventType) ? o.eventType : 'Other',
        severity:  Math.max(1, Math.min(5, Math.round(o.severity || 1))),
        summary:   o.summary || '',
        headline:  src.title || '',
        source:    src.source || '',
        url:       src.link || '',
        published: src.published || null,
      };
    })
    .slice(0, MAX_ITEMS);
}

// --- handler ------------------------------------------------------------

export default async function handler(req, res) {
  const send = (obj, status = 200, ttl = 0) => {
    res.writeHead(status, {
      'content-type':                'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...(ttl ? { 'cache-control': `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` } : {}),
    });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  const debug = new URL(req.url, `https://${req.headers.host || 'localhost'}`)
    .searchParams.get('debug') === '1';

  const key = process.env.GEMINI_API_KEY;
  if (!key) return send({ items: [], _unconfigured: true });

  try {
    const headlines = await gatherHeadlines();
    if (!headlines.length) {
      return send({ items: [], _error: 'no headlines fetched' }, 200, 0);
    }
    const items = await analyse(key, headlines);

    if (debug) {
      return send({
        provider: 'gemini', model: GEMINI_MODEL,
        headlines: headlines.length, items: items.length,
        sample: items.slice(0, 3),
      });
    }
    return send({ items, generated: new Date().toISOString() }, 200, CACHE_TTL);
  } catch (err) {
    return send({ items: [], _error: String(err) }, 200, 0);
  }
}
