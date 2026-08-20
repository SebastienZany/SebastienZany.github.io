import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolDirectory, '../..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const mimeByExtension = new Map([
  ['.bin', 'application/octet-stream'],
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.wgsl', 'text/wgsl; charset=utf-8'],
]);

createServer((request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    let filePath = resolve(repositoryRoot, `.${requestPath}`);
    if (filePath !== repositoryRoot && !filePath.startsWith(`${repositoryRoot}${sep}`)) {
      throw new Error('Path escapes the repository root');
    }
    if (statSync(filePath).isDirectory()) filePath = resolve(filePath, 'index.html');
    const type = mimeByExtension.get(extname(filePath)) || 'application/octet-stream';
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': type });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
  }
}).listen(port, host, () => {
  console.log(`Serving ${repositoryRoot} at http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  if (host !== '0.0.0.0') return;
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (entry?.family !== 'IPv4' || entry.internal) continue;
    console.log(`  also reachable on this network at http://${entry.address}:${port}`);
  }
});
