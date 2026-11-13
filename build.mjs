import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, 'src');
const destination = join(root, 'dist', 'server');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const assets = Object.create(null);
async function collect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) { await collect(absolute); continue; }
    if (!entry.isFile() || absolute === join(source, 'server.mjs')) continue;
    const data = await readFile(absolute);
    const key = '/' + relative(source, absolute).split('\\').join('/');
    assets[key] = { type: types[extname(entry.name).toLowerCase()] || 'application/octet-stream', data: data.toString('base64'), hash: createHash('sha256').update(data).digest('hex').slice(0, 20) };
  }
}
for (const required of ['index.html', 'style.css', 'app.js']) await readFile(join(source, required));
await collect(source);
const template = await readFile(join(source, 'server.mjs'), 'utf8');
const marker = '/* BUILD_ASSETS */ {}';
if (template.split(marker).length !== 2) throw new Error('Server asset marker is missing or ambiguous.');
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'index.js'), template.replace(marker, () => JSON.stringify(assets)));
const total = Object.values(assets).reduce((sum, asset) => sum + Math.floor(asset.data.length * 3 / 4), 0);
console.log(`Built ${Object.keys(assets).length} assets (${total.toLocaleString('en-US')} bytes) into ${resolve(destination, 'index.js')}`);
