// Serves the Ledra sandbox (demo/app) on localhost for recording Friday's demo.
//   npm run demo-app            then open the printed address
//   PORT=4180 npm run demo-app  on another port

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'app');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Ledra sandbox: http://localhost:${PORT}  (Ctrl+C to stop)`));
