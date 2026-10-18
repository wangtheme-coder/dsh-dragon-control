const MODE_PATH = '/dragon-control/mode';

function admittedBy(connection, request) {
  if (typeof connection?.admit === 'function') {
    const verdict = connection.admit(request);
    return Boolean(verdict?.peer) && !Object.hasOwn(verdict, 'rejection');
  }
  if (typeof connection?.isAuthenticated === 'function') return connection.isAuthenticated(request) === true;
  return false;
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) { reject(Object.assign(Error('too large'), { status: 413 })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(Error('invalid json'), { status: 400 })); }
    });
  });
}

/**
 * Mount the composer-chip routes. Only `/dragon-control/mode` exists here; the value is
 * read from and written to permissions.json so scripts/mode.mjs and the chip agree.
 * Returns the disposer registered on the web server (or a no-op).
 */
export function mountModeRoutes({ webServer, connection, permissions }) {
  const disposer = webServer?.register?.({
    kind: 'prefix',
    path: '/dragon-control',
    handler: (request, response) => (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname !== MODE_PATH) return sendJson(response, 404, { error: 'not-found' });
      if (!admittedBy(connection, request)) { response.writeHead(401); response.end(); return; }
      const origin = request.headers.origin;
      const site = request.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none' || origin &&
          !['http:', 'https:'].some(protocol => origin === `${protocol}//${request.headers.host}`)) return sendJson(response, 403, { error: 'cross-origin' });
      if (request.method === 'GET') return sendJson(response, 200, { mode: await permissions.currentMode() });
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method-not-allowed' });
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' ||
          request.headers['x-dragon-mode-intent'] !== 'user') return sendJson(response, 403, { error: 'user-intent-required' });
      const body = await readJson(request);
      if (body?.mode !== 'owner' && body?.mode !== 'auto') return sendJson(response, 400, { error: 'invalid-mode' });
      if (Object.keys(body).some(key => !['mode', 'acknowledge'].includes(key)) ||
          body.mode === 'auto' && body.acknowledge !== true) return sendJson(response, 400, { error: 'explicit-opt-in-required' });
      sendJson(response, 200, { mode: await permissions.setMode(body.mode) });
    })().catch(error => {
      if (response.headersSent) { response.end(); return; }
      sendJson(response, error?.status ?? 500, { error: 'request-failed' });
    }),
  });
  return typeof disposer === 'function' ? disposer : () => {};
}
