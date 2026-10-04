// sam-ui (Apache-2.0). New file, not from SAM 2.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** A static server for a build folder, at URL's path (e.g. /sam-ui/). */
export function serve(dir, url) {
  const u = new URL(url);
  const types = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm'};
  Object.assign(types, {'.json': 'application/json', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'});
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!p.startsWith(u.pathname)) {
      res.writeHead(404).end();
      return;
    }
    let file = path.join(root, p.slice(u.pathname.length));
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

