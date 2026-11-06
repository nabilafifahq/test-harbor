// Local server: static files from public/ plus the API. On Vercel, public/ is served by the CDN and api/index.js runs the API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './app.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handle(req, res);
  let file = path.join(PUBLIC, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' });
  fs.createReadStream(file).pipe(res);
});
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`Harbor Point Order Desk on http://localhost:${PORT}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
