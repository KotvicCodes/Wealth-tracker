import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, sendJson, type Route } from './lib/handler.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const production = process.argv.includes('--production');
const vite = production ? undefined : await (await import('vite')).createServer({
  root, server: { middlewareMode: true }, appType: 'spa',
});
const staticRoot = resolve(root, 'dist');
const routes: Route[] = ['billionaires', 'history', 'reference', 'cron'];
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    const route = pathname.slice(5) as Route;
    if (routes.includes(route)) await handleApi(route, req, res, true);
    else sendJson(req, res, 404, { error: 'not found' });
    return;
  }
  if (vite) { vite.middlewares(req, res); return; }
  try {
    const path = resolve(staticRoot, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(staticRoot + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': contentTypes[extname(path)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end('Not found'); }
});

const port = Number(process.env.PORT || 8000);
server.listen(port, '127.0.0.1', () => console.log(`Wealth Tracker running at http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); void vite?.close(); });
}
