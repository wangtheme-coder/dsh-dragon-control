// 真实浏览器冒烟：启动本机 Edge/Chrome（无头），跑一遍 open/snapshot/fill/click/wait/a11y/scrape/screenshot/execute。
// Usage: node scripts/self-browser-smoke.mjs
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissions } from '../permissions.mjs';
import { createSelfHostedBrowser } from '../browser-self.mjs';

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Dragon Self Browser Smoke</title></head>
<body>
<h1 id="title">龙爪自立浏览器</h1>
<label for="user">用户名</label><input id="user" name="user" autocomplete="off">
<label for="note">备注</label><textarea id="note" name="note"></textarea>
<select id="color" name="color"><option value="r">红</option><option value="b">蓝</option></select>
<label><input type="checkbox" id="agree" name="agree"> 同意</label>
<form id="form" method="get" action="/submitted"><input type="hidden" name="ok" value="1">
<button id="go" type="submit">提交</button></form>
<ul id="list"><li><h3>条目一</h3><a href="/one">链接一</a></li><li><h3>条目二</h3><a href="/two">链接二</a></li></ul>
</body></html>`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw Error(`检查失败：${name} ${detail ? JSON.stringify(detail) : ''}`);
};

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/submitted') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html><head><meta charset="utf-8"><title>已提交</title></head><body><h1 id="done">提交成功</h1></body></html>`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const stateDir = await mkdtemp(join(tmpdir(), 'dragon-self-smoke-'));
const downloads = join(stateDir, 'downloads');
const permissionsFile = join(stateDir, 'permissions.json');
await writeFile(permissionsFile, JSON.stringify({ version: 1, mode: 'auto', apps: {}, origins: {}, allowPageScript: true }) + '\n');

const permissions = createPermissions({ get: () => undefined }, permissionsFile);
await permissions.initialize();
const browser = createSelfHostedBrowser({ stateDir, downloadsDir: downloads, permissions });
const exec = { agent: { id: 'smoke-agent', session: 'smoke-session' }, signal: new AbortController().signal };

try {
  const opened = await browser.open(exec, { url: `http://127.0.0.1:${port}/` });
  check('open 返回快照', opened.url.endsWith('/') && opened.count > 0, { url: opened.url, count: opened.count });
  check('快照包含提交按钮', opened.elements.some(element => element.name.includes('提交') || element.selector.includes('go')));

  const snap = await browser.snapshot(exec, {});
  check('snapshot 有 selector', snap.elements.every(element => typeof element.selector === 'string'));

  const content = await browser.content(exec, { format: 'markdown' });
  check('content markdown 含标题', content.content.includes('龙爪自立浏览器'), content.content.slice(0, 120));

  const filled = await browser.fill(exec, { fields: [
    { selector: '#user', value: '龙爪' },
    { selector: '#note', value: '自立测试' },
    { selector: '#color', value: 'b' },
    { selector: '#agree', value: true }
  ] });
  check('fill 四个字段都成功', filled.fields.every(field => field.ok), filled.fields);

  const userValue = await browser.getValue(exec, { target: { by: 'css', value: '#user' } });
  check('get_value 读到输入值', userValue.value === '龙爪', userValue);
  const colorValue = await browser.getValue(exec, { target: { by: 'css', value: '#color' } });
  check('get_value 读到 select', colorValue.value === 'b' && colorValue.selectedText === '蓝', colorValue);
  const agreeValue = await browser.getValue(exec, { target: { by: 'css', value: '#agree' } });
  check('get_value 读到 checkbox', agreeValue.checked === true, agreeValue);

  const a11y = await browser.a11y(exec, {});
  check('a11y 返回按钮/输入框', a11y.nodes.some(node => node.role === 'button') && a11y.nodes.some(node => node.role === 'textbox'), a11y.count);

  const scraped = await browser.scrape(exec, { item: '#list li', fields: { title: 'h3', url: 'a@href' } });
  check('scrape 提取两条', scraped.count === 2 && scraped.items[0].title === '条目一' && scraped.items[0].url === '/one', scraped);

  const shot = await browser.screenshot(exec, { format: 'png' });
  check('screenshot 返回 png', shot.dataUrl.startsWith('data:image/png;base64,') && shot.bytes > 1000, shot.bytes);

  const executed = await browser.execute(exec, { script: 'return document.querySelectorAll("li").length;' });
  check('execute 返回页面脚本结果', executed.ok && executed.value === 2, executed);

  const challenge = await browser.challenge(exec, {});
  check('challenge 未误报', challenge.blocked === false, challenge);

  await browser.click(exec, { target: { by: 'text', value: '提交' } });
  const waited = await browser.wait(exec, { url: `/submitted`, timeoutMs: 8000 });
  check('click 后表单提交并跳转', waited.ready === true, waited);
  const done = await browser.content(exec, { format: 'txt' });
  check('提交后页面内容正确', done.content.includes('提交成功'), done.content.slice(0, 80));

  const tabs = await browser.listTabs(exec, {});
  check('list_tabs 至少一个标签', tabs.tabs.length >= 1, tabs.tabs.length);

  console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? String(error), code: error?.code, checks: results }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.dispose();
  server.close();
  await rm(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}
