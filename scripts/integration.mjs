import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { runtime } from './runtime.mjs';
const load = runtime();
const [{ Context }, { ToolRuntime }, plugin] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), import('../index.mjs')
]);
if (process.platform !== 'win32') throw Error('Real Windows desktop required.');
const source = fileURLToPath(new URL('../', import.meta.url));
await promisify(execFile)('powershell.exe', ['-NoProfile', '-File', join(source, 'test', 'fixtures', 'build.ps1')], { windowsHide: true });
const fixture = spawn(join(source, 'test', 'fixtures', 'Fixture.exe'), [], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
let transcript = ''; fixture.stdout.on('data', bytes => { transcript += bytes.toString(); });
const until = async (condition, timeout = 10000) => { const start = Date.now(); while (!condition()) { if (Date.now() - start >= timeout) throw Error('Integration condition timed out'); await delay(50); } };
await until(() => /READY (\d+)/.test(transcript));
const hwnd = Number(transcript.match(/READY (\d+)/)[1]);
const stateDir = await mkdtemp(join(tmpdir(), 'dragon-integration-'));
const checks = [], images = []; let requests = 0, submitted = 0, approvalAllowed = true, approvalPolicy = 'ask';
const server = http.createServer((req, res) => {
  requests++;
  if (req.url === '/file') { res.setHeader('Content-Type', 'text/plain'); res.end('integration-download'); return; }
  if (req.url?.startsWith('/submit')) { submitted++; res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end('<title>Submitted</title><p>Form completed</p>'); return; }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><title>Dragon browser fixture</title><form action="/submit"><label>Name<input name="name" id="name"></label><button type="submit" id="send">Submit test form</button></form><div id="result">Ready</div>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const ctx = new Context();
ctx.provide('systemPrompt', { section: () => () => {}, tools: () => () => {} });
ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) });
ctx.provide('attachments', { saveImage: async ({ data, mediaType, name }) => {
  const id = 'fixture-' + images.length; images.push(data);
  return { attachmentId: id, mediaType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20), name };
} });
ctx.provide('webServer', { register: () => () => {} });
ctx.provide('connection', { admit: () => true, isAuthenticated: () => true });
const approvalReasons = [];
ctx.provide('approval', { effectivePolicy: () => approvalPolicy,
  request: async request => { approvalReasons.push(request.reason); return approvalAllowed ? 'allowed-once' : 'rejected'; } });
new ToolRuntime(ctx);
const events = [{ type: 'user/message', seq: 1, data: { source: { kind: 'user' } } }];
const agent = { id: 'integration', status: 'running', session: { snapshotEvents: () => events,
  requestHeader: () => ({ config: { provider: 'test', model: 'text-only' } }) }, ctx };
const exec = { agent, signal: new AbortController().signal };
const parse = result => JSON.parse(result.content.find(c => c.type === 'text').text);
const call = (tool, action, args = {}) => ctx.tools.get(tool).execute({ action, args }, exec);
const desktop = async (action, args) => parse(await call('dragon_desktop', action, args));
const browser = (action, args) => call('dragon_browser', action, args);
try {
  await ctx.plugin(plugin, { dataDir: stateDir });
  assert.deepEqual(ctx.tools.schemas().map(x => x.name).sort(), ['dragon_browser', 'dragon_desktop']);
  for (const tool of ['dragon_browser', 'dragon_desktop']) {
    const menu = parse(await call(tool, 'help'));
    for (const action of menu.actions) await call(tool, 'help', { action });
  }
  checks.push('only two registered tools; all action schemas available');
  let tree = await desktop('a11y', { window_id: hwnd });
  assert.doesNotMatch(JSON.stringify(tree), /do-not-return-this|runtimeId/);
  assert.equal(images.length, 0);
  const target = (name, pattern) => {
    const matches = tree.elements.filter(e => e.name === name && (!pattern || e.patterns.includes(pattern)));
    assert.equal(matches.length, 1, `Expected unique ${name}/${pattern}; got ${JSON.stringify(tree.elements)}`); return matches[0];
  };
  const act = async (action, name, pattern, extra = {}) => {
    const item = target(name, pattern);
    tree = await desktop(action, { a11y_id: tree.a11y_id, element_id: item.element_id, ...extra }); return tree;
  };
  const stale = { a11y_id: tree.a11y_id, element_id: target('Integration input', 'set_value').element_id, value: 'never' };
  await act('set_element_value', 'Integration input', 'set_value', { value: 'Unicode 龙娘 integration' });
  assert.equal(tree.valueVerified, true);
  await assert.rejects(desktop('set_element_value', stale), { code: 'DRAGON_ELEMENT_STALE' });
  await act('toggle_element', 'Integration toggle', 'toggle');
  assert.equal(target('Integration toggle', 'toggle').toggle, 'On');
  await act('select_element', 'Choice B', 'select');
  assert.equal(target('Choice B', 'select').selected, true);
  await act('click_element', 'Apply input', 'invoke');
  assert(tree.elements.some(e => e.name.includes('Applied: Unicode 龙娘 integration')));
  checks.push('real Windows UIA SetValue/Toggle/Select/Invoke with state readback and no image model');
  tree = await desktop('wait_for', { window_id: hwnd, name: 'Apply input', role: 'Button', timeout_ms: 1000 });
  assert.equal(tree.matched, true);
  await assert.rejects(desktop('wait_for', { window_id: hwnd, name: 'never-present', timeout_ms: 0 }), { code: 'DRAGON_WAIT_TIMEOUT' });
  checks.push('native condition wait and explicit timeout');
  tree = await desktop('a11y', { window_id: hwnd });
  approvalAllowed = false;
  await assert.rejects(act('click_element', 'Apply input', 'invoke'), { code: 'DRAGON_PERMISSION_DENIED' });
  approvalAllowed = true;
  tree = await desktop('a11y', { window_id: hwnd });
  await act('click_element', 'Open test dialog', 'invoke');
  await until(() => /DIALOG (\d+)/.test(transcript));
  const dialogId = Number(transcript.match(/DIALOG (\d+)/)[1]);
  tree = await desktop('a11y', { window_id: dialogId });
  await act('click_element', 'Close test dialog', 'invoke');
  await until(() => transcript.includes('DIALOG_CLOSED'));
  checks.push('owned real Windows dialog opened and closed semantically');
  const beforeInvalid = requests;
  await assert.rejects(browser('open', { url, unexpected: true }), { code: 'DRAGON_INVALID_ARGS' });
  await assert.rejects(browser('open', { url: ['bad'] }), { code: 'DRAGON_INVALID_ARGS' });
  assert.equal(requests, beforeInvalid);
  checks.push('official schema validation rejects invalid parameters before network side effects');
  approvalAllowed = false;
  await assert.rejects(browser('open', { url }), { code: 'DRAGON_PERMISSION_DENIED' });
  assert.equal(requests, beforeInvalid);
  checks.push('rejected website scope causes zero navigation requests');
  // Use another test Agent: a rejected origin remains rejected in the first Session.
  agent.id = 'integration-browser'; agent.session = { snapshotEvents: () => events };
  approvalAllowed = true;
  const opened = await browser('open', { url }); assert.match(JSON.stringify(opened), /Dragon browser fixture/);
  await browser('type', { target: { by: 'css', value: '#name' }, text: 'fixture-value' });
  await browser('wait', { selector: '#send', timeoutMs: 1000 });
  await browser('click', { target: { by: 'css', value: '#send' } });
  await browser('wait', { url: url + 'submit', timeoutMs: 3000 });
  assert.match(JSON.stringify(await browser('content', { format: 'txt' })), /Form completed/);
  assert.equal(submitted, 1);
  checks.push('real visible browser form input, one submit, conditional wait and result readback');
  await assert.rejects(browser('execute', { script: 'document.body.textContent' }), { code: 'DRAGON_SCRIPT_DISABLED' });
  const downloadPath = join(stateDir, 'downloads', 'fixture.txt');
  await browser('download', { url: url + 'file', savePath: downloadPath });
  assert.equal(await readFile(downloadPath, 'utf8'), 'integration-download');
  await assert.rejects(browser('download', { url: url + 'file', savePath: downloadPath }), { code: 'DRAGON_FILE_EXISTS' });
  await assert.rejects(browser('download', { url: url + 'file', savePath: join(stateDir, 'outside.txt') }), { code: 'DRAGON_DOWNLOAD_PATH' });
  checks.push('download content verified; overwrite and directory escape rejected; page script disabled');
  const history = parse(await browser('history', { limit: 100 }));
  assert(history.events.length > 0); assert.doesNotMatch(JSON.stringify(history), /fixture-value|script|token=/);
  checks.push('session-scoped audit contains outcomes without field values or scripts');
  approvalPolicy = 'never'; agent.id = 'integration-never'; agent.session = { snapshotEvents: () => events };
  await assert.rejects(desktop('a11y', { window_id: hwnd }), { code: 'DRAGON_PERMISSION_REQUIRED' });
  checks.push('never approval policy fails closed');
  const report = { version: plugin.VERSION, remoteModelCalls: 0, checks, realWindowsFixture: true, realBrowser: true,
    approvals: 'controlled test service, not a human approval UI test',
    stillManual: ['physical Esc from a human keyboard', 'mixed-DPI/multi-monitor matrix', 'DSH UI approval rendering', 'real model planning task', 'current elevated Orb overlay'],
    snapshotsCreated: images.length };
  const output = process.env.DRAGON_TEST_OUTPUT_DIR;
  if (output) { await mkdir(output, { recursive: true }); await writeFile(join(output, 'release-verification.json'), JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await ctx.fiber.dispose(); fixture.kill(); await new Promise(resolve => server.close(resolve));
}
