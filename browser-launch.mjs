import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fault } from './validation.mjs';

// 龙爪自带浏览器：直接启动本机已安装的 Microsoft Edge / Google Chrome，
// 用插件自己的 user-data-dir 和一个随机调试端口，再由 CdpClient 连上去。
// 不依赖 dsh-orb 的 Electron，也不依赖 dsh-builtin-browser。

const portFile = profileDir => join(profileDir, 'DevToolsActivePort');

export function browserCandidates (env = process.env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA ?? '';
  return [
    { name: 'DRAGON_BROWSER_PATH', path: env.DRAGON_BROWSER_PATH },
    { name: 'Microsoft Edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Google Chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') }
  ].filter(candidate => typeof candidate.path === 'string' && candidate.path.length > 0);
}

export function findManagedBrowser (env = process.env) {
  for (const candidate of browserCandidates(env)) {
    if (existsSync(candidate.path)) return { name: candidate.name, path: candidate.path };
  }
  return null;
}

/** 读取 Chrome/Edge 写在 user-data-dir 里的调试端口文件（两行：端口、ws 路径）。 */
export function readDevToolsPort (profileDir) {
  try {
    const text = readFileSync(portFile(profileDir), 'utf8').slice(0, 4096);
    const [first, second] = text.split(/\r?\n/);
    const port = Number(first);
    const wsPath = (second ?? '').trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(wsPath)) return null;
    return { port, wsPath };
  } catch {
    return null;
  }
}

/** 端口文件存在不等于进程还活着：用 /json/version 探一次。 */
export async function probeManagedBrowser (profileDir, signal, { timeoutMs = 1500 } = {}) {
  const found = readDevToolsPort(profileDir);
  if (!found) return null;
  const timeout = AbortSignal.timeout(timeoutMs);
  const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${found.port}/json/version`, { redirect: 'error', signal: bound });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const body = await response.json();
    if (typeof body.webSocketDebuggerUrl !== 'string') return null;
    return { ...found, wsUrl: body.webSocketDebuggerUrl, browser: String(body.Browser ?? 'browser').slice(0, 128) };
  } catch {
    return null;
  }
}

function launchArgs (profileDir, headless) {
  return [
    `--user-data-dir=${profileDir}`,
    // 0 = 让浏览器自己挑一个空闲端口，避免和用户已经开着的 9222 调试端口打架。
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ];
}

/**
 * 启动（或复用）插件自己的浏览器。
 * 复用场景：DSH 重启后，上一次启动的浏览器还开着；此时直接连回它的调试端口，
 * 用户已经登录的页面和 cookie 都不会丢。
 */
export async function launchManagedBrowser ({ profileDir, signal, headless = process.env.DRAGON_BROWSER_HEADLESS === '1', timeoutMs = 20000, spawnImpl = spawn } = {}) {
  if (!profileDir) throw fault('DRAGON_BROWSER_UNAVAILABLE', '缺少浏览器配置目录。');
  await mkdir(profileDir, { recursive: true });

  const reused = await probeManagedBrowser(profileDir, signal);
  if (reused) return { ...reused, child: null, reused: true, profileDir };

  const found = findManagedBrowser();
  if (!found) {
    throw fault('DRAGON_BROWSER_UNAVAILABLE', '找不到 Microsoft Edge 或 Google Chrome。可设置环境变量 DRAGON_BROWSER_PATH 指向浏览器可执行文件。');
  }

  // 上一次异常退出可能留下过期端口文件；先清掉，免得连到别人的端口。
  try { unlinkSync(portFile(profileDir)); } catch {}

  let child;
  try {
    child = spawnImpl(found.path, launchArgs(profileDir, headless), { stdio: 'ignore', windowsHide: headless });
  } catch (error) {
    throw fault('DRAGON_BROWSER_UNAVAILABLE', `无法启动浏览器：${error?.message ?? error}`);
  }

  let failure = null;
  let exitCode = null;
  child.once('error', error => { failure ??= fault('DRAGON_BROWSER_UNAVAILABLE', `浏览器启动失败：${error?.message ?? error}`); });
  // Windows 上 Edge/Chrome 的启动器进程可能先把工作交给另一个进程再退出（代码 0），
  // 所以这里只记录退出码，继续等 DevToolsActivePort；连不上才算失败。
  child.once('exit', code => { exitCode = code; });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (failure) throw failure;
    if (readDevToolsPort(profileDir)) {
      const ready = await probeManagedBrowser(profileDir, signal);
      if (ready) {
        return { ...ready, child, reused: false, browser: found.name, executable: found.path, profileDir };
      }
    }
    await delay(120, undefined, { signal });
  }
  try { child.kill(); } catch {}
  throw fault('DRAGON_BROWSER_TIMEOUT', `浏览器启动超时${exitCode === null ? '' : `（进程已退出，代码 ${exitCode}）`}；请确认本机 Edge/Chrome 能正常打开，或检查 DRAGON_BROWSER_PATH。`);
}

/** 只关闭本次由插件启动的进程；复用到的用户进程不碰。 */
export function closeManagedBrowser (handle) {
  if (!handle || handle.reused || !handle.child) return;
  try { handle.child.kill(); } catch {}
}

/** 探测某个调试端口是否仍在响应；用于确认浏览器是否真的关掉了。 */
export async function browserAlive (port, { timeoutMs = 800 } = {}) {
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

/**
 * 兜底关闭：按 --user-data-dir 精确匹配本插件 profile 的 Edge/Chrome 进程树。
 * 启动器进程可能先退出、真正的浏览器进程被交接出去，child.kill() 不一定够。
 */
export async function killBrowserByProfile (profileDir, { timeoutMs = 8000, execFileImpl = execFile } = {}) {
  const powershell = (() => {
    const absolute = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return existsSync(absolute) ? absolute : 'powershell.exe';
  })();
  // 每段都要用分号隔开，否则 PowerShell 会把 $dir 赋值和后面的命令连成一条。
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$dir=$env:DRAGON_CLOSE_PROFILE',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    'exit 0'
  ].join('; ');
  return await new Promise(resolve => {
    try {
      execFileImpl(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: timeoutMs, env: { ...process.env, DRAGON_CLOSE_PROFILE: profileDir }
      }, error => resolve(!error));
    } catch { resolve(false); }
  });
}
