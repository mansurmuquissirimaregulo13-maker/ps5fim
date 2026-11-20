const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

// 1. Load .env file automatically
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  });
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.mp4':  'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf'
};

function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.end(data);
  });
}

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(buf);
    });
    req.on('error', () => {
      resolve(Buffer.alloc(0));
    });
  });
}

// Enhance req and res with Next.js/Express-like helpers
function decorateReqRes(req, res, parsedUrl) {
  req.query = parsedUrl.query || {};

  res.status = function(code) {
    this.statusCode = code;
    return this;
  };

  res.json = function(data) {
    if (!this.getHeader('Content-Type')) {
      this.setHeader('Content-Type', 'application/json');
    }
    this.end(JSON.stringify(data));
    return this;
  };

  res.send = function(data) {
    this.end(data);
    return this;
  };

  res.redirect = function(url) {
    this.writeHead(302, { Location: url });
    this.end();
    return this;
  };
}

async function handleApi(route, req, res, parsedUrl) {
  decorateReqRes(req, res, parsedUrl);

  const rawBuf = await collectBody(req);
  req.rawBody = rawBuf;
  const rawStr = rawBuf.toString('utf8');

  if (rawStr) {
    try {
      req.body = JSON.parse(rawStr);
    } catch {
      req.body = rawStr;
    }
  } else {
    req.body = {};
  }

  const apiFile = path.join(__dirname, 'api', `${route}.js`);
  if (!fs.existsSync(apiFile)) {
    return res.status(404).json({ error: `API endpoint /api/${route} not found` });
  }

  try {
    const handler = require(apiFile);
    if (typeof handler !== 'function') {
      return res.status(500).json({ error: 'Handler is not a function' });
    }
    await handler(req, res);
  } catch (err) {
    console.error(`API Error on /api/${route}:`, err);
    if (!res.writableEnded) {
      res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  // API routing
  if (pathname.startsWith('/api/')) {
    const route = pathname.replace(/^\/api\//, '').replace(/\.(js|php)$/i, '').replace(/\/+$/, '');
    return handleApi(route, req, res, parsedUrl);
  }

  // Static routing
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  serveStatic(req, res, filePath);
});

process.on('uncaughtException', (err) => {
  console.error('[dev-server uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[dev-server unhandledRejection]', reason);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MANSUR dev server running at http://localhost:${PORT}`);
  console.log(`Product page: http://localhost:${PORT}/playstation_5_gta6.html`);
});
