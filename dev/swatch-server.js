// Dev-only static server for the brush swatch harness.
//
// Deliberately separate from the app's server.js: the harness needs an
// endpoint that WRITES files to disk (so rendered swatch sheets land in
// dev/out/ where they can be opened and compared against real-media
// reference scans), and that has no business existing in production.
// Zero dependencies, same as the main server.
//
//   node dev/swatch-server.js
//   -> http://localhost:4600/dev/brush-swatches.html
//
// The harness renders every brush, POSTs each sheet here as a PNG, and
// dev/out/ ends up holding one image per family.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = process.env.SWATCH_PORT || 4600;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- Save a rendered sheet ----
  if (req.method === 'POST' && url.pathname === '/__save') {
    // Sanitised to a bare filename: this writes to disk, and the harness is
    // the only intended caller, but a path-traversing name shouldn't be able
    // to scribble outside dev/out/ even so.
    const name = path.basename(url.searchParams.get('name') || 'sheet.png');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const file = path.join(OUT, name);
      fs.writeFile(file, Buffer.concat(chunks), err => {
        if (err) {
          res.writeHead(500);
          return res.end(String(err));
        }
        console.log('saved', path.relative(ROOT, file));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    return;
  }

  // ---- Static files out of the repo root ----
  let filePath = path.normalize(path.join(ROOT, url.pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (url.pathname === '/') filePath = path.join(__dirname, 'brush-swatches.html');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`swatch harness: http://localhost:${PORT}/dev/brush-swatches.html`);
  console.log(`writing sheets to ${path.relative(ROOT, OUT)}/`);
});
