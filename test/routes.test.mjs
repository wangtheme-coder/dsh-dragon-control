import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissions } from '../permissions.mjs';
import { mountModeRoutes } from '../routes.mjs';

async function fixture() {
  const path = join(await mkdtemp(join(tmpdir(), 'dragon-mode-route-')), 'permissions.json');
  const service = { effectivePolicy: () => 'never', request: async () => 'rejected' };
  const permissions = createPermissions({ get: () => service }, path);
  await permissions.initialize();
  let handler;
  const webServer = { register: options => { handler = options.handler; return () => {}; } };
  const dispose = mountModeRoutes({ webServer, connection: { isAuthenticated: request => request.authorized === true }, permissions });
  return { path, permissions, handler, dispose };
}

function request(method, url, body) {
  const stream = new PassThrough();
  stream.method = method;
  stream.url = url;
  stream.authorized = true;
  stream.headers = { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json', 'x-dragon-mode-intent': 'user' };
  if (body !== undefined) stream.end(JSON.stringify(body));
  else stream.end();
  return stream;
}

function response() {
  return { status: 0, headersSent: false, body: '', writeHead(status) { this.status = status; this.headersSent = true; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; this.headersSent = true; } };
}

test('mode route answers only the authenticated composer chip', async () => {
  const f = await fixture();
  const deny = request('GET', '/dragon-control/mode');
  deny.authorized = false;
  const denied = response();
  await f.handler(deny, denied);
  assert.equal(denied.status, 401);

  const read = response();
  await f.handler(request('GET', '/dragon-control/mode'), read);
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), { mode: 'owner' });
});

test('POST switches the mode on disk and rejects anything else', async () => {
  const f = await fixture();
  const write = response();
  await f.handler(request('POST', '/dragon-control/mode', { mode: 'auto', acknowledge: true }), write);
  assert.equal(write.status, 200);
  assert.deepEqual(JSON.parse(write.body), { mode: 'auto' });
  assert.equal((JSON.parse(await readFile(f.path, 'utf8'))).mode, 'auto');
  assert.equal(write.headersSent, true);

  const bad = response();
  await f.handler(request('POST', '/dragon-control/mode', { mode: 'root' }), bad);
  assert.equal(bad.status, 400);

  const missing = response();
  await f.handler(request('GET', '/dragon-control/other'), missing);
  assert.equal(missing.status, 404);
  assert.equal(typeof f.dispose, 'function');
});

test('mode mutation refuses cross-site requests, simple forms and implicit auto opt-in', async () => {
  const f = await fixture();
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }, { 'x-dragon-mode-intent': '' }]) {
    const req = request('POST', '/dragon-control/mode', { mode: 'auto', acknowledge: true });
    Object.assign(req.headers, headers); const res = response(); await f.handler(req, res); assert.equal(res.status, 403);
  }
  const res = response(); await f.handler(request('POST', '/dragon-control/mode', { mode: 'auto' }), res); assert.equal(res.status, 400);
  assert.equal(await f.permissions.currentMode(), 'owner');
});

test('unrecognized connection admission never grants access', async () => {
  const f = await fixture(); let handler;
  mountModeRoutes({ webServer: { register: opts => { handler = opts.handler; } }, connection: { admit: () => true }, permissions: f.permissions });
  const res = response(); await handler(request('GET', '/dragon-control/mode'), res); assert.equal(res.status, 401);
});
