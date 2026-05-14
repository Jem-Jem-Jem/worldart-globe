// Local dev server — mimics the Vercel runtime so we can preview without
// authenticating to Vercel. Not used in production; ignored on deploy.
//
//   node dev-server.js           # → http://localhost:4321

import http  from 'node:http';
import fs    from 'node:fs/promises';
import path  from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC    = path.join(__dirname, 'public');
const PORT      = process.env.PORT || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
};

// Import the actual edge function and adapt to Node http
const feedModule = await import('./api/feed.js');
const feedHandler = feedModule.default;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Proxy /api/feed*
  if (url.pathname === '/api/feed') {
    try {
      const edgeReq = new Request(`http://localhost${req.url}`, { method: req.method });
      const edgeRes = await feedHandler(edgeReq);
      res.writeHead(edgeRes.status, Object.fromEntries(edgeRes.headers));
      res.end(await edgeRes.text());
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC, p);
  try {
    const data = await fs.readFile(filePath);
    const ext  = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`World Globe dev → http://localhost:${PORT}/`);
});
