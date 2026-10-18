// Offline load smoke: apply the plugin against a minimal Cordis-shaped context.
// The plugin must not import host packages, so no DSH runtime checkout is needed.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') return next(new URL('./stub-dsh-tools.mjs', import.meta.url).href, context);
  return next(specifier, context);
} });
const plugin = await import('../index.mjs');

const stateDir = await mkdtemp(join(tmpdir(), 'dragon-load-'));
const tools = new Map();
const disposers = [];
const sections = [];
const routes = [];
const handlers = new Map();

const ctxServices = { webServer: { register: value => { routes.push(value); return () => {}; } }, connection: { admit: () => true, isAuthenticated: () => true } };
const ctx = {
  tools: {
    register: definition => { assert(!tools.has(definition.name), `duplicate ${definition.name}`); tools.set(definition.name, definition); },
    guard: () => () => {},
    schemas: () => [...tools.values()]
  },
  systemPrompt: { section: value => sections.push(value) },
  attachments: { saveImage: async () => { throw Error('no image expected'); } },
  webServer: ctxServices.webServer,
  connection: ctxServices.connection,
  on: (event, handler) => { handlers.set(event, handler); return () => {}; },
  effect: factory => { const dispose = factory(); disposers.push(dispose); return () => {}; },
  get: name => ({ llm: { resolveModelInfo: async () => null }, webServer: ctxServices.webServer, connection: ctxServices.connection })[name],
  fiber: { dispose: async () => {} }
};

const exec = { agent: { id: 'load-smoke' }, signal: new AbortController().signal };
const call = async (tool, action, args = {}) => tools.get(tool).execute({ action, args }, exec);
const parse = result => result.content.find(part => part.type === 'text')?.text ?? '';

try {
  await plugin.apply(ctx, { dataDir: stateDir });
  assert.deepEqual([...tools.keys()].sort(), ['dragon_browser', 'dragon_desktop']);
  assert.equal(sections.length, 1);
  assert.equal(routes.length, 1);

  const browserStatus = JSON.parse(parse(await call('dragon_browser', 'status')));
  assert.equal(browserStatus.version, plugin.VERSION);
  assert.equal(browserStatus.backend ?? browserStatus.browser.backend, 'dragon-cdp');
  assert.equal(browserStatus.browser.launched, false);
  assert.equal(browserStatus.backends.browser, 'dragon-cdp');
  assert.equal(browserStatus.supportedPlatform, 'Windows x64 only');
  const executable = browserStatus.browser.executable;
  assert(executable, 'managed browser executable should be detected');

  const desktopStatus = JSON.parse(parse(await call('dragon_desktop', 'status')));
  assert.equal(desktopStatus.backends.desktop, 'dragon-native');

  for (const tool of ['dragon_browser', 'dragon_desktop']) {
    const menu = JSON.parse(parse(await call(tool, 'help')));
    assert(menu.actions.length >= 20, `${tool} help returned ${menu.actions.length} actions`);
    for (const action of menu.actions) {
      const detail = JSON.parse(parse(await call(tool, 'help', { action })));
      assert.equal(detail[0].action, action);
    }
  }

  for (const [name, definition] of tools) {
    assert.equal(typeof definition.execute, 'function', name);
    assert.equal(definition.parameters.type, 'object', name);
  }

  await Promise.all(disposers.map(dispose => dispose()));
  console.log(JSON.stringify({ ok: true, version: plugin.VERSION, tools: [...tools.keys()], executable,
    actions: { browser: JSON.parse(parse(await call('dragon_browser', 'help'))).actions.length,
      desktop: JSON.parse(parse(await call('dragon_desktop', 'help'))).actions.length } }, null, 2));

  const errorLog = await readFile(join(stateDir, 'browser-error.log'), 'utf8').catch(() => '');
  assert.equal(errorLog, '', 'browser layer should not have logged a load error');
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
