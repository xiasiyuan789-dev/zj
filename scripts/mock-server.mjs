// Local mock of the vault API + static file server for e2e testing.
// Mirrors the request/response shapes of functions/handler.mjs, in memory.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8787;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const vaults = new Map(); // passwordHash -> { id, encryptedData }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (body, type = 'application/json', status = 200) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  if (url.pathname.startsWith('/functions/v1/app')) {
    const action = url.searchParams.get('action');
    let body = null;
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(null); }
        });
      });
    }
    if (action === 'register' && body) {
      const id = crypto.randomUUID();
      vaults.set(body.passwordHash, { id, encryptedData: body.encryptedData });
      console.log(`[mock] register -> ${id}`);
      return send(JSON.stringify({ id }));
    }
    if (action === 'login' && body) {
      const v = vaults.get(body.passwordHash);
      if (!v) return send(JSON.stringify({ error: 'not_found' }), 'application/json', 404);
      return send(JSON.stringify({ id: v.id, encryptedData: v.encryptedData }));
    }
    if (action === 'save' && body) {
      const v = [...vaults.values()].find((x) => x.id === body.id);
      if (v) v.encryptedData = body.encryptedData;
      console.log(`[mock] save ok=${!!v}`);
      return send(JSON.stringify({ ok: true }));
    }
    if (action === 'load') {
      const v = [...vaults.values()].find((x) => x.id === url.searchParams.get('id'));
      if (!v) return send(JSON.stringify({ error: 'not_found' }), 'application/json', 404);
      return send(JSON.stringify({ id: v.id, encryptedData: v.encryptedData }));
    }
    return send(JSON.stringify({ error: 'not_found' }), 'application/json', 404);
  }

  // static files
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  const rootNorm = ROOT.replaceAll('\\', '/');
  const file = normalize(join(ROOT, path)).replaceAll('\\', '/');
  if (!file.startsWith(rootNorm)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const data = await readFile(file);
    return send(data, MIME[extname(file)] || 'application/octet-stream');
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`mock server running: http://localhost:${PORT}`));
