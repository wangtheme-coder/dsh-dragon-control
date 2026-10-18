// Live smoke test: start a real Chrome with a debug port, attach, and drive a local page.
// Usage: node scripts/cdp-smoke.mjs [path-to-chrome.exe]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createChromeBridge } from '../chrome-cdp.mjs';

const CANDIDATES = [
  process.argv[2],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

const chromePath = CANDIDATES.find(p => existsSync(p));
if (!chromePath) { console.error('没有找到 Chrome 或 Edge。'); process.exit(2); }

let port;
const profile = await mkdtemp(join(tmpdir(), 'dragon-cdp-smoke-'));
const grants = [];
const permissions = { require: async (_exec, resource, scope) => { grants.push(`${scope}:${resource.id}`); }, confirm: async () => {} };
const bridge = createChromeBridge({ permissions });
const exec = { signal: new AbortController().signal };

const page = `<!doctype html><meta charset="utf-8">
<title>龙爪 CDP</title><body>
<input id="name" value=""><button id="go" onclick="document.getElementById('out').textContent='你好 ' + document.getElementById('name').value">打招呼</button>
<div id="out">未点击</div><div id="late" style="display:none">稍后出现</div>
<script>setTimeout(() => { document.getElementById('late').style.display = 'block'; }, 400);</script>
</body>`;

const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const chrome = spawn(chromePath, [
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'
  , '--no-proxy-server'
], { stdio: 'ignore' });

const waitForPort = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      port = Number(contents.split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && !chrome.exitCode) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};

const steps = [];
let failed = null;
try {
  if (!await waitForPort()) throw new Error('调试端口没有起来');
  const attached = await bridge.attach({ port }, exec);
  steps.push(`attach ${attached.browser} tabs=${attached.tabs.length}`);

  const opened = await bridge.execute('open', { url }, exec);
  steps.push(`open own local fixture`);
  await bridge.execute('wait', { selector: '#name', timeout_ms: 5000 }, exec);

  const tabs = await bridge.execute('tabs', {}, exec);
  steps.push(`tabs=${tabs.tabs.length} titles=${tabs.tabs.map(t => t.title).join('|')}`);

  await bridge.execute('fill', { selector: '#name', value: '龙爪' }, exec);
  steps.push('fill ok');
  await bridge.execute('click', { selector: '#go' }, exec);
  steps.push('click ok');

  const text = await bridge.execute('text', {}, exec);
  if (!text.text.includes('你好 龙爪')) throw new Error(`页面文字不符：${text.text.slice(0, 120)}`);
  steps.push('text contains 你好 龙爪');

  const waited = await bridge.execute('wait', { selector: '#late', timeout_ms: 5000 }, exec);
  steps.push(`wait matched=${waited.matched}`);

  const shot = await bridge.execute('screenshot', {}, exec);
  if (!shot.dataUrl.startsWith('data:image/png;base64,')) throw new Error('截图格式不对');
  steps.push(`screenshot bytes=${shot.bytes}`);

  let blocked = false;
  try { await bridge.execute('open', { url: 'file:///C:/Windows/win.ini' }, exec); } catch { blocked = true; }
  if (!blocked) throw new Error('file:// 没有被拦住');
  steps.push('file:// blocked');

  bridge.detach(exec);
  steps.push('detach ok');
} catch (error) {
  failed = error;
} finally {
  bridge.dispose();
  chrome.kill();
  server.close();
  await new Promise(r => setTimeout(r, 300));
  const cleanupRoot = resolve(tmpdir()) + sep;
  if (!resolve(profile).startsWith(cleanupRoot) || !resolve(profile).slice(cleanupRoot.length).startsWith('dragon-cdp-smoke-')) throw Error('Unsafe cleanup path');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

if (failed) { console.error('失败：', failed.message); console.error(steps.join('\n')); process.exit(1); }
console.log('通过：'); for (const line of steps) console.log('  ' + line);
if (process.env.DRAGON_TEST_OUTPUT_DIR) await writeFile(join(process.env.DRAGON_TEST_OUTPUT_DIR, 'cdp-verification.json'), JSON.stringify({
  version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
  ownIsolatedBrowser: true, remoteModelCalls: 0, approvals: 'controlled test service', checks: steps
}, null, 2) + '\n');
