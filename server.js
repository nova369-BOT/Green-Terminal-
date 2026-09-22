/**
 * GREEN TERMINAL — static dev server.
 *
 * Deliberately dependency-free: the terminal is authored as native ES modules,
 * so there is no bundler between you and the running app. Swap in Vite/Next when
 * you add npm packages; the /src tree is unchanged either way.
 *
 * Binds 0.0.0.0 so the app is reachable through the sandbox preview proxy.
 */
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  // Terminal ships as same-origin ES modules; no third-party frames/scripts.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;",
};

async function resolveTarget(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT)) return null; // path traversal guard
  // Never expose dot-entries (.git, .env, editor dirs…): the git directory in
  // particular is the whole project history + remote config — not a static asset.
  const relToRoot = abs.slice(ROOT.length).split(path.sep);
  if (relToRoot.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) return null;
  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isFile()) return abs;
  if (stat?.isDirectory()) {
    const idx = path.join(abs, 'index.html');
    if (await fs.stat(idx).then((s) => s.isFile()).catch(() => false)) return idx;
  }
  // SPA fallback
  return path.join(ROOT, 'index.html');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end('method not allowed');
  }

  // Health endpoint for the preview proxy + liveness checks.
  if (req.url.startsWith('/__health')) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    return res.end(JSON.stringify({ ok: true, uptime_s: process.uptime() }));
  }

  const file = await resolveTarget(req.url || '/');
  if (!file) {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end('not found');
  }

  const ext = path.extname(file).toLowerCase();
  const isEntry = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // HTML never caches so the preview always shows the latest edit; modules are
    // revalidated rather than immutably cached (dev ergonomics over CDN policy).
    'Cache-Control': isEntry ? 'no-cache' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.on('end', () => {
    if (process.env.QUIET !== '1') {
      const ms = Date.now() - started;
      process.stdout.write(`${req.method} ${req.url} → ${path.relative(ROOT, file)} (${ms}ms)\n`);
    }
  });
  stream.pipe(res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`GREEN TERMINAL  http://${HOST}:${PORT}  (root: ${ROOT})\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
