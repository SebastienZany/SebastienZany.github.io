// Static file server + a POST /__save endpoint so a render running in the
// browser can write its output to disk. Dev-only; not part of the deployed site.
//
//   node replay/devserver.mjs [port]
//
// POST /__save?name=out.mp4   body = raw bytes  ->  writes replay/out/out.mp4

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] ?? 8123);
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'replay', 'out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
};

await mkdir(OUT, { recursive: true });

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/__save') {
    try {
      const name = (url.searchParams.get('name') || 'out.bin').replace(/[^\w.\-]/g, '_');
      const body = await readBody(req);
      const dest = join(OUT, name);
      await writeFile(dest, body);
      console.log(`[save] ${name} <- ${body.length} bytes`);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, path: dest, bytes: body.length }));
    } catch (err) {
      console.error('[save] failed', err);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
    return;
  }

  // static
  let p = normalize(decodeURIComponent(url.pathname));
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}  (saves -> ${OUT})`);
});
