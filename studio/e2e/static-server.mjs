// sam-ui (Apache-2.0). New file, not from SAM 2.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** A static server for a build folder, at URL's path (e.g. /sam-ui/); `also` serves more folders by path on the same origin. */
export function serve(dir, url, also = {}) {
  const u = new URL(url);
  const mounts = [[u.pathname, path.resolve(dir)], ...Object.entries(also).map(([prefix, d]) => [prefix, path.resolve(d)])];
  const types = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm'};
  Object.assign(types, {'.json': 'application/json', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'});
  const server = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const mount = mounts.find(([prefix]) => p.startsWith(prefix));
    if (mount == null) {
      res.writeHead(404).end();
      return;
    }
    const [prefix, root] = mount;
    let file = path.join(root, p.slice(prefix.length));
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {'Content-Type': types[path.extname(file)] ?? 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(u.port), u.hostname, () => resolve(server));
  });
}

