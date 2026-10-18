import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { htmlToMarkdown, resolveDownloadPath, targetExpression, createSelfHostedBrowser } from '../browser-self.mjs';
import { browserAlive, browserCandidates, findManagedBrowser, killBrowserByProfile, readDevToolsPort } from '../browser-launch.mjs';

test('targetExpression supports css, text and xpath without interpolating raw input', () => {
  assert.match(targetExpression({ by: 'css', value: '#submit' }), /document\.querySelector\("#submit"\)/);
  assert.match(targetExpression({ by: 'text', value: '登录' }), /=== "登录"/);
  assert.match(targetExpression({ by: 'xpath', value: '//button[1]' }), /document\.evaluate\("\/\/button\[1\]"/);
  assert.match(targetExpression({ by: 'css', value: 'a"onmouseover="x' }), /"a\\"onmouseover=\\"x"/);
  assert.throws(() => targetExpression({ by: 'css' }), /target\.value/);
  assert.throws(() => targetExpression({ by: 'regex', value: 'x' }), /target\.by/);
});

test('htmlToMarkdown keeps headings, links and list items', () => {
  const markdown = htmlToMarkdown('<h1>标题</h1><p>正文 <a href="/x">链接</a></p><ul><li>一</li><li>二</li></ul><script>bad()</script>');
  assert.match(markdown, /^# 标题/m);
  assert.match(markdown, /\[链接\]\(\/x\)/);
  assert.match(markdown, /- 一/);
  assert.doesNotMatch(markdown, /bad\(\)/);
});

test('resolveDownloadPath stays inside the plugin download directory and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dragon-path-'));
  try {
    assert.equal(resolveDownloadPath(dir, 'shot.png'), join(dir, 'shot.png'));
    assert.equal(resolveDownloadPath(dir, join(dir, 'nested', 'shot.png')), join(dir, 'nested', 'shot.png'));
    assert.throws(() => resolveDownloadPath(dir, '..\\escape.png'), /下载目录/);
    assert.throws(() => resolveDownloadPath(dir, resolve(dir, '..', 'escape.png')), /下载目录/);
    await writeFile(join(dir, 'exists.png'), 'x');
    assert.throws(() => resolveDownloadPath(dir, 'exists.png'), /不覆盖/);
    assert.equal(resolveDownloadPath(dir, ''), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readDevToolsPort accepts only the documented two-line format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dragon-port-'));
  try {
    await writeFile(join(dir, 'DevToolsActivePort'), '51234\n/devtools/browser/abc-DEF_123\r\n');
    assert.deepEqual(readDevToolsPort(dir), { port: 51234, wsPath: '/devtools/browser/abc-DEF_123' });
    await writeFile(join(dir, 'DevToolsActivePort'), '0\n/devtools/browser/x\n');
    assert.equal(readDevToolsPort(dir), null);
    await writeFile(join(dir, 'DevToolsActivePort'), '51234\nhttps://evil.example/devtools/browser/x\n');
    assert.equal(readDevToolsPort(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findManagedBrowser honours DRAGON_BROWSER_PATH and ignores missing candidates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dragon-browser-'));
  try {
    const exe = join(dir, 'custom-browser.exe');
    await writeFile(exe, '');
    const env = { DRAGON_BROWSER_PATH: exe, ProgramFiles: join(dir, 'none'), 'ProgramFiles(x86)': join(dir, 'none2'), LOCALAPPDATA: join(dir, 'none3') };
    assert.deepEqual(findManagedBrowser(env), { name: 'DRAGON_BROWSER_PATH', path: exe });
    assert.equal(findManagedBrowser({ ProgramFiles: join(dir, 'a'), 'ProgramFiles(x86)': join(dir, 'b'), LOCALAPPDATA: join(dir, 'c') }), null);
    assert.ok(browserCandidates({ DRAGON_BROWSER_PATH: '' }).every(candidate => candidate.path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('browser status reports the managed backend before launch without spawning anything', () => {
  const browser = createSelfHostedBrowser({ stateDir: join(tmpdir(), 'dragon-status-only'), downloadsDir: join(tmpdir(), 'dragon-status-only', 'downloads'), permissions: { require: async () => {}, confirm: async () => {}, pageScriptEnabled: async () => false } });
  const status = browser.status();
  assert.equal(status.backend, 'dragon-cdp');
  assert.equal(status.launched, false);
  assert.equal(status.downloadsDir, join(tmpdir(), 'dragon-status-only', 'downloads'));
  assert.equal(typeof status.hasBrowser, 'undefined');
  assert.equal(typeof browser.hasBrowser(), 'boolean');
});

test('killBrowserByProfile builds one semicolon-separated PowerShell command and passes the profile via env', async () => {
  let captured;
  const ok = await killBrowserByProfile('C:\tmp\profile', {
    execFileImpl: (file, args, options, callback) => { captured = { file, args, options }; callback(null); }
  });
  assert.equal(ok, true);
  assert.match(captured.file, /powershell\.exe$/i);
  assert.equal(captured.args[0], '-NoProfile');
  assert.equal(captured.args[1], '-NonInteractive');
  assert.match(captured.args[3], /\$ErrorActionPreference="SilentlyContinue"; \$dir=\$env:DRAGON_CLOSE_PROFILE; Get-CimInstance/);
  assert.equal(captured.options.env.DRAGON_CLOSE_PROFILE, 'C:\tmp\profile');
  assert.equal(captured.options.windowsHide, true);
});

test('browserAlive follows the DevTools HTTP endpoint', async () => {
  const http = await import('node:http');
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{"Browser":"Edge/1"}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await browserAlive(port), true);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await browserAlive(port, { timeoutMs: 300 }), false);
  } finally {
    server.close();
  }
});
