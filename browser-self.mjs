import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpClient } from './chrome-cdp.mjs';
import { webOrigin } from './permissions.mjs';
import { fault } from './validation.mjs';
import { closeManagedBrowser, findManagedBrowser, killBrowserByProfile, launchManagedBrowser, probeManagedBrowser } from './browser-launch.mjs';

// 网页侧自立实现：插件自己启动 Edge/Chrome（独立 user-data-dir），再用 CDP 驱动。
// 所有 DOM 读写都在隔离世界里执行，页面脚本改不到插件的执行环境。

const READ_OPS = new Set(['snapshot', 'a11y', 'content', 'getValue', 'wait', 'screenshot', 'scrape', 'challenge', 'tabs']);
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_RESULT = 33554432;

const text = value => [{ type: 'text', text: JSON.stringify(value) }];
const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
};

/** @type {string} 在隔离世界里收集快照的脚本（只读，返回 JSON 可序列化值）。 */
function snapshotExpression ({ maxNodes = 150, coords = false, includeHidden = false } = {}) {
  return `(() => {
    const MAX = ${Math.round(clamp(maxNodes, 1, 1000, 150))};
    const INCLUDE_HIDDEN = ${includeHidden ? 'true' : 'false'};
    const COORDS = ${coords ? 'true' : 'false'};
    const SELECTOR = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="combobox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],[onclick]';
    const out = [];
    const seen = new Set();
    let capped = false;
    const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const roleOf = el => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName;
      if (tag === 'A') return 'link';
      if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
      if (tag === 'SELECT') return 'combobox';
      if (tag === 'TEXTAREA') return 'textbox';
      if (tag === 'INPUT') return ({ text: 'textbox', search: 'searchbox', email: 'textbox', password: 'textbox', number: 'spinbutton', checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', file: 'button', range: 'slider', date: 'textbox', url: 'textbox', tel: 'textbox' })[el.type] ?? 'textbox';
      return 'generic';
    };
    const labelOf = el => {
      if (el.labels && el.labels.length) return norm([...el.labels].map(label => label.innerText).join(' '));
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const joined = norm(ids.split(/\\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' '));
        if (joined) return joined;
      }
      return norm(el.getAttribute('aria-label') || el.placeholder || el.title || el.alt || '');
    };
    const cssPath = el => {
      if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        let segment = node.tagName.toLowerCase();
        const name = node.getAttribute('name');
        if (name) segment += '[name="' + String(name).replace(/"/g, '\\\\"') + '"]';
        else if (node.parentElement) {
          const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(segment);
        node = node.parentElement;
      }
      return parts.join(' > ');
    };
    const add = el => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (out.length >= MAX) { capped = true; return; }
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
      if (!INCLUDE_HIDDEN && (hidden || rect.width <= 0 || rect.height <= 0)) return;
      const tag = el.tagName.toLowerCase();
      const role = roleOf(el);
      const name = labelOf(el) || (['input', 'textarea', 'select'].includes(tag) ? '' : norm(el.innerText).slice(0, 120));
      const states = [];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) states.push(el.checked ? 'checked' : 'unchecked');
      if (el.getAttribute('aria-expanded')) states.push('expanded=' + el.getAttribute('aria-expanded'));
      if (el.getAttribute('aria-selected') === 'true') states.push('selected');
      if (el.getAttribute('aria-current')) states.push('current');
      if (el.readOnly) states.push('readonly');
      if (el.required) states.push('required');
      const entry = { id: out.length + 1, role, tag, name: name.slice(0, 160) };
      if (el.getAttribute('type')) entry.type = el.getAttribute('type');
      if (tag === 'a' && el.getAttribute('href')) entry.href = String(el.getAttribute('href')).slice(0, 300);
      if (el.type !== 'password' && !(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'))) {
        const value = tag === 'select' ? el.value : el.value;
        if (value !== undefined && value !== null && String(value) !== '') entry.value = String(value).slice(0, 160);
      }
      if (tag === 'select' && el.selectedIndex >= 0) entry.selectedText = norm(el.options[el.selectedIndex]?.text ?? '').slice(0, 120);
      if (el.type === 'checkbox' || el.type === 'radio') entry.checked = Boolean(el.checked);
      if (states.length) entry.states = states;
      entry.selector = cssPath(el);
      entry.hidden = hidden;
      if (COORDS) entry.center = [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)];
      out.push(entry);
    };
    const walk = root => {
      for (const el of root.querySelectorAll(SELECTOR)) add(el);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    try { walk(document); } catch (error) { return { url: location.href, title: document.title, elements: out, truncated: capped, error: String(error?.message ?? error) }; }
    return { url: location.href, title: document.title, elements: out, truncated: capped };
  })()`;
}

/** 按 target 描述生成返回元素节点的表达式（css / text / xpath）。 */
export function targetExpression (target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw fault('DRAGON_BROWSER_TARGET', '需要 target 对象，例如 {"by":"css","value":"#submit"}。');
  const by = target.by ?? 'css';
  const value = target.value;
  if (typeof value !== 'string' || value.length === 0) throw fault('DRAGON_BROWSER_TARGET', 'target.value 必须是非空字符串。');
  if (value.length > 4000) throw fault('DRAGON_BROWSER_TARGET', 'target.value 过长。');
  const quoted = JSON.stringify(value);
  if (by === 'css') return `document.querySelector(${quoted})`;
  if (by === 'xpath') return `document.evaluate(${quoted}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
  if (by === 'text') {
    return `[...document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="submit"],input[type="button"],summary,label')].find(el => String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim() === ${quoted})`;
  }
  throw fault('DRAGON_BROWSER_TARGET', 'target.by 只能是 css、text 或 xpath。');
}

function targetLabel (target) {
  if (!target) return '';
  try { return `${target.by ?? 'css'}:${String(target.value).slice(0, 80)}`; } catch { return ''; }
}

export function resolveDownloadPath (downloadsDir, savePath) {
  if (typeof savePath !== 'string' || savePath.trim().length === 0) return null;
  const base = resolve(downloadsDir);
  const target = isAbsolute(savePath) ? resolve(savePath) : resolve(base, savePath);
  const lower = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (lower(target) !== lower(base) && !lower(target).startsWith(lower(base) + sep)) {
    throw fault('DRAGON_PATH', `保存路径必须位于插件下载目录内：${base}`);
  }
  if (existsSync(target)) throw fault('DRAGON_PATH', '目标文件已存在；本插件不覆盖文件。');
  return target;
}

export function htmlToMarkdown (html) {
  const strip = value => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n${'#'.repeat(Number(level))} ${strip(inner)}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${strip(inner)}`)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${strip(inner)}](${href})`)
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_, alt) => `![${alt}]()`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n{3,}/g, '\n\n')
    .trim();
}

const pad = value => String(value).padStart(2, '0');

export function createSelfHostedBrowser ({
  stateDir, downloadsDir, permissions,
  connect = CdpClient.connect,
  launch = launchManagedBrowser,
  probe = probeManagedBrowser,
  find = findManagedBrowser
} = {}) {
  const profileDir = resolve(stateDir, 'browser-profile');
  const sessions = new Map();
  let runtime = null;
  let launchHandle = null;
  let starting = null;
  let lastError = null;

  const sessionKey = exec => exec.agent?.id ?? 'local-test';

  function stateFor (exec) {
    const id = sessionKey(exec);
    const stamp = exec.agent?.session ?? 'local';
    let state = sessions.get(id);
    if (!state || state.stamp !== stamp) {
      state = { stamp, targetId: null, sessionId: null, world: `dragon-${randomUUID()}`, owned: new Set(), trace: [] };
      sessions.set(id, state);
    }
    return state;
  }

  function remember (state, entry) {
    state.trace.push({ at: new Date().toISOString(), ...entry });
    if (state.trace.length > 40) state.trace.shift();
  }

  async function ensure (exec) {
    if (runtime && !runtime.client.closed) return runtime;
    if (starting) return starting;
    starting = (async () => {
      try {
        const launched = await launch({ profileDir, signal: exec.signal });
        const client = await connect(`ws://127.0.0.1:${launched.port}${launched.wsPath}`, { signal: exec.signal });
        const handle = { ...launched, client };
        launchHandle = handle;
        runtime = handle;
        client.socket?.addEventListener?.('close', () => { if (runtime === handle) runtime = null; });
        lastError = null;
        return handle;
      } catch (error) {
        lastError = { time: new Date().toISOString(), code: error?.code ?? 'DRAGON_BROWSER_UNAVAILABLE', message: String(error?.message ?? error).slice(0, 500) };
        if (error?.code) throw error;
        throw fault('DRAGON_BROWSER_UNAVAILABLE', `无法启动或连接浏览器：${String(error?.message ?? error).slice(0, 300)}`);
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  async function targetList (exec) {
    const handle = await ensure(exec);
    const { targetInfos } = await handle.client.call('Target.getTargets', {}, undefined, exec.signal);
    return targetInfos ?? [];
  }

  async function attachTo (exec, targetId) {
    const handle = await ensure(exec);
    const state = stateFor(exec);
    if (state.targetId === targetId && state.sessionId) return state.sessionId;
    const { sessionId } = await handle.client.call('Target.attachToTarget', { targetId, flatten: true }, undefined, exec.signal);
    if (state.sessionId && state.sessionId !== sessionId) {
      await handle.client.call('Target.detachFromTarget', { sessionId: state.sessionId }, undefined, exec.signal).catch(() => {});
    }
    state.targetId = targetId;
    state.sessionId = sessionId;
    await handle.client.call('Page.enable', {}, sessionId, exec.signal).catch(() => {});
    return sessionId;
  }

  /** 取当前页；标签没了就开一个空白页，绝不自动切到用户的其他标签。 */
  async function pageFor (exec) {
    const handle = await ensure(exec);
    const state = stateFor(exec);
    const targets = await targetList(exec);
    let target = state.targetId ? targets.find(item => item.type === 'page' && item.targetId === state.targetId) : null;
    if (!target) {
      target = targets.find(item => item.type === 'page' && item.url === 'about:blank');
      if (!target) {
        const created = await handle.client.call('Target.createTarget', { url: 'about:blank' }, undefined, exec.signal);
        target = { targetId: created.targetId, url: 'about:blank', title: '' };
      }
      // 插件实例里的空白页也是我们自己开出来/接管的，记进 owned，tabs 才能正确标 ours。
      state.owned.add(target.targetId);
      state.targetId = target.targetId;
      state.sessionId = null;
    }
    const sessionId = await attachTo(exec, target.targetId);
    return { handle, state, target, sessionId };
  }

  async function evaluate (page, expression, signal, { awaitPromise = false } = {}) {
    const { frameTree } = await page.handle.client.call('Page.getFrameTree', {}, page.sessionId, signal);
    const { executionContextId } = await page.handle.client.call('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: page.state.world }, page.sessionId, signal);
    const result = await page.handle.client.call('Runtime.evaluate', {
      expression, contextId: executionContextId, returnByValue: true, awaitPromise: awaitPromise, userGesture: true
    }, page.sessionId, signal);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知错误';
      throw fault('DRAGON_BROWSER_EVALUATE', `页面脚本执行失败：${String(detail).slice(0, 300)}`);
    }
    return result.result?.value;
  }

  async function pageInfo (page, exec) {
    return evaluate(page, '({ url: location.href, title: document.title, ready: document.readyState })', exec.signal);
  }

  async function authorize (exec, scope, { allowBlank = false } = {}) {
    const page = await pageFor(exec);
    const info = await pageInfo(page, exec);
    let origin = null;
    if (info.url !== 'about:blank') {
      try { origin = webOrigin(info.url); } catch { throw fault('DRAGON_BROWSER_ORIGIN', '只允许操作 HTTP(S) 网页；当前标签不是网页。'); }
    }
    if (origin) await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, scope);
    else if (!allowBlank && scope !== 'read') throw fault('DRAGON_BROWSER_ORIGIN', '当前是空白标签；请先 open 一个网址。');
    return { ...page, info, origin };
  }

  async function confirm (exec, description, request) {
    await permissions.confirm(exec, description, request);
    exec.signal?.throwIfAborted();
  }

  async function waitUntil (page, exec, expression, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      exec.signal?.throwIfAborted();
      if (await evaluate(page, expression, exec.signal)) return true;
      await delay(120, undefined, { signal: exec.signal });
    }
    return false;
  }

  async function resolveElement (page, exec, target) {
    return evaluate(page, `(() => {
      const el = ${targetExpression(target)};
      if (!el) return { found: false };
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height,
        tag: el.tagName.toLowerCase(), disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
        visibility: style.visibility, display: style.display };
    })()`, exec.signal);
  }

  async function mouseClick (page, x, y, signal) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await page.handle.client.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, page.sessionId, signal);
    await page.handle.client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, page.sessionId, signal);
  }

  async function snapshot (exec, options = {}) {
    const page = await authorize(exec, 'read');
    const value = await evaluate(page, snapshotExpression(options), exec.signal) ?? {};
    const elements = Array.isArray(value.elements) ? value.elements : [];
    return { url: value.url ?? page.info.url, title: value.title ?? page.info.title, count: elements.length, elements, truncated: Boolean(value.truncated) };
  }

  async function open (exec, args = {}) {
    const href = String(args.url ?? '');
    let url;
    try { url = new URL(href).href; } catch { throw fault('DRAGON_INVALID_URL', '需要完整的 HTTP(S) 网址，例如 https://example.com。'); }
    const origin = webOrigin(url);
    await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, 'control');
    await confirm(exec, `浏览器打开 ${url}`, { op: 'open', url });
    const handle = await ensure(exec);
    const state = stateFor(exec);
    let page;
    if (args.newTab === true) {
      const created = await handle.client.call('Target.createTarget', { url: 'about:blank' }, undefined, exec.signal);
      state.owned.add(created.targetId);
      state.targetId = created.targetId;
      state.sessionId = null;
      page = await pageFor(exec);
    } else {
      page = await pageFor(exec);
    }
    const navigation = await handle.client.call('Page.navigate', { url }, page.sessionId, exec.signal);
    if (navigation.errorText) throw fault('DRAGON_BROWSER_NAVIGATION', `导航失败（${String(navigation.errorText).slice(0, 120)}）。`);
    await waitUntil(page, exec, `document.readyState === 'complete' && location.href !== 'about:blank'`, 15000);
    remember(state, { action: 'open', url, origin });
    return snapshot(exec);
  }

  async function click (exec, args = {}) {
    const page = await authorize(exec, 'control');
    const hasTarget = args.target !== undefined;
    const hasPoint = args.x !== undefined || args.y !== undefined;
    if (hasTarget === hasPoint) throw fault('DRAGON_BROWSER_ARGS', 'click 需要 target，或 x/y 坐标，二选一。');
    await confirm(exec, `在 ${page.origin} 点击 ${hasTarget ? targetLabel(args.target) : `${args.x},${args.y}`}`, { op: 'click', target: args.target ?? { x: args.x, y: args.y } });
    let x; let y;
    if (hasTarget) {
      const element = await resolveElement(page, exec, args.target);
      if (!element?.found) throw fault('DRAGON_BROWSER_MISSING', '找不到目标元素；请重新 snapshot。');
      if (element.disabled) throw fault('DRAGON_BROWSER_DISABLED', '目标元素处于禁用状态。');
      if (element.width <= 0 || element.height <= 0) throw fault('DRAGON_BROWSER_HIDDEN', '目标元素不可见；请重新 snapshot。');
      x = element.x; y = element.y;
    } else {
      x = Number(args.x); y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw fault('DRAGON_BROWSER_ARGS', 'x/y 必须是数字。');
    }
    await mouseClick(page, x, y, exec.signal);
    remember(stateFor(exec), { action: 'click', target: args.target ?? { x, y } });
    return { clicked: true, target: hasTarget ? args.target : { x: Math.round(x), y: Math.round(y) } };
  }

  async function type (exec, args = {}) {
    if (typeof args.text !== 'string' || args.text.length === 0) throw fault('DRAGON_BROWSER_ARGS', 'type 需要非空 text。');
    if (args.text.length > 20000) throw fault('DRAGON_BROWSER_ARGS', '单次输入文本过长。');
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 输入 ${args.text.length} 个字符`, { op: 'type', target: args.target });
    if (args.target) {
      const focused = await evaluate(page, `(() => { const el = ${targetExpression(args.target)}; if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); el.focus(); return true; })()`, exec.signal);
      if (!focused) throw fault('DRAGON_BROWSER_MISSING', '找不到要输入的输入框；请重新 snapshot。');
    }
    const active = await evaluate(page, '({ tag: document.activeElement?.tagName ?? "", type: document.activeElement?.type ?? "", editable: Boolean(document.activeElement?.isContentEditable) })', exec.signal);
    if (!active?.tag || active.tag === 'BODY' || active.tag === 'HTML') throw fault('DRAGON_BROWSER_FOCUS', '当前没有聚焦的输入框；请传 target 或先 click 输入框。');
    if (active.type === 'password') throw fault('DRAGON_BROWSER_PASSWORD', '密码输入需要用户自己完成。');
    await page.handle.client.call('Input.insertText', { text: args.text }, page.sessionId, exec.signal);
    return { typed: args.text.length, focused: String(active.tag).toLowerCase() };
  }

  async function key (exec, args = {}) {
    const table = {
      Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46],
      ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39],
      Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' ']
    };
    const entry = table[args.key];
    if (!entry) throw fault('DRAGON_BROWSER_KEY', `只支持：${Object.keys(table).join('、')}。`);
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 按 ${args.key}`, { op: 'key', key: args.key });
    const [code, typed] = entry;
    const pressed = { key: args.key, code: args.key, windowsVirtualKeyCode: code, ...(typed === undefined ? {} : { text: typed }) };
    await page.handle.client.call('Input.dispatchKeyEvent', { type: 'keyDown', ...pressed }, page.sessionId, exec.signal);
    await page.handle.client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key, code: args.key, windowsVirtualKeyCode: code }, page.sessionId, exec.signal);
    return { pressed: args.key };
  }

  async function scroll (exec, args = {}) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 滚动页面`, { op: 'scroll', args });
    if (args.selector) {
      const moved = await evaluate(page, `(() => { const el = document.querySelector(${JSON.stringify(String(args.selector))}); if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`, exec.signal);
      if (!moved) throw fault('DRAGON_BROWSER_MISSING', '找不到滚动目标。');
    } else if (args.toTop === true) {
      await evaluate(page, 'scrollTo(0, 0)', exec.signal);
    } else if (args.toBottom === true) {
      await evaluate(page, 'scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))', exec.signal);
    } else {
      const dx = clamp(args.deltaX, -100000, 100000, 0);
      const dy = clamp(args.deltaY, -100000, 100000, 600);
      await evaluate(page, `scrollBy(${Math.round(dx)}, ${Math.round(dy)})`, exec.signal);
    }
    return { scrolled: true };
  }

  async function fill (exec, args = {}) {
    const fields = args.fields;
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 50) throw fault('DRAGON_BROWSER_ARGS', 'fill 需要 1–50 个字段。');
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 填写 ${fields.length} 个字段${args.submit === true ? '并提交' : ''}`, { op: 'fill', fields, submit: args.submit === true });
    const expression = `(() => {
      const fields = ${JSON.stringify(fields)};
      const norm = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const locate = field => {
        if (field.selector) return document.querySelector(field.selector);
        if (field.name) return document.querySelector('[name="' + CSS.escape(String(field.name)) + '"]');
        if (field.label) {
          const label = [...document.querySelectorAll('label')].find(item => norm(item.innerText) === norm(field.label));
          if (label) return label.control ?? label.querySelector('input,textarea,select');
        }
        if (field.placeholder) return document.querySelector('[placeholder="' + CSS.escape(String(field.placeholder)) + '"]');
        return null;
      };
      const setValue = (element, value) => {
        if (element instanceof HTMLSelectElement) {
          const option = [...element.options].find(item => item.value === String(value)) ?? [...element.options].find(item => norm(item.text) === norm(value));
          if (!option) return { ok: false, message: '选项不存在' };
          element.value = option.value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: element.value, text: norm(option.text) };
        }
        if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
          const want = typeof value === 'boolean' ? value : !/^(false|0|no|off)$/i.test(String(value));
          if (element.checked !== want) element.click();
          return { ok: true, checked: element.checked };
        }
        if (element.type === 'password') return { ok: false, message: '密码输入需要用户处理' };
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          element.focus();
          setter.call(element, String(value));
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: element.value };
        }
        if (element.isContentEditable) {
          element.focus();
          element.textContent = String(value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        }
        return { ok: false, message: '不支持的控件' };
      };
      const results = fields.map((field, index) => {
        const element = locate(field);
        if (!element) return { index, ok: false, message: '找不到字段' };
        if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', behavior: 'instant' });
        const outcome = setValue(element, field.value);
        return { index, ...outcome, tag: element.tagName.toLowerCase() };
      });
      let submitted = false;
      if (${args.submit === true ? 'true' : 'false'}) {
        const form = document.querySelector('form');
        if (form) {
          try { if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit(); submitted = true; } catch { submitted = false; }
        } else {
          const button = [...document.querySelectorAll('button,[type="submit"]')].find(item => /提交|保存|登录|确定|submit|save|login/i.test(String(item.innerText || item.value || '')));
          if (button) { button.click(); submitted = true; }
        }
      }
      return { fields: results, submitted };
    })()`;
    return evaluate(page, expression, exec.signal);
  }

  async function setValue (exec, args = {}) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 设置 ${targetLabel(args.target)}`, { op: 'set_value', target: args.target });
    const value = await evaluate(page, `(() => {
      const el = ${targetExpression(args.target)};
      if (!el) return { ok: false, message: '找不到目标' };
      const value = ${JSON.stringify(String(args.value ?? ''))};
      if (el instanceof HTMLSelectElement) {
        const option = [...el.options].find(item => item.value === value) ?? [...el.options].find(item => String(item.text).trim() === value.trim());
        if (!option) return { ok: false, message: '选项不存在' };
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, method: 'select', value: el.value, text: option.text.trim() };
      }
      if (el.type === 'password') return { ok: false, message: '密码输入需要用户处理' };
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        el.focus();
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, method: 'native-setter', value: el.value };
      }
      if (el.isContentEditable) { el.focus(); el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true, method: 'contenteditable', value }; }
      return { ok: false, message: '不支持的控件' };
    })()`, exec.signal);
    if (!value?.ok) throw fault('DRAGON_BROWSER_SET_VALUE', value?.message ?? '设置失败。');
    return { method: value.method, value: value.value };
  }

  async function check (exec, args = {}) {
    const want = args.checked !== false;
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} ${want ? '勾选' : '取消勾选'} ${targetLabel(args.target)}`, { op: 'check', target: args.target, checked: want });
    const result = await evaluate(page, `(() => {
      const el = ${targetExpression(args.target)};
      if (!el) return { ok: false, message: '找不到目标' };
      if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) return { ok: false, message: '目标不是 checkbox/radio' };
      if (el.checked !== ${want ? 'true' : 'false'}) el.click();
      return { ok: true, checked: el.checked };
    })()`, exec.signal);
    if (!result?.ok) throw fault('DRAGON_BROWSER_CHECK', result?.message ?? '操作失败。');
    return { checked: result.checked };
  }

  async function select (exec, args = {}) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 选择选项 ${targetLabel(args.target)}`, { op: 'select', target: args.target, optionValue: args.optionValue, optionText: args.optionText, optionIndex: args.optionIndex });
    const result = await evaluate(page, `(() => {
      const el = ${targetExpression(args.target)};
      if (!el) return { ok: false, message: '找不到目标' };
      if (!(el instanceof HTMLSelectElement)) return { ok: false, message: '目标不是 select' };
      const options = [...el.options];
      let option = null;
      if (${JSON.stringify(args.optionValue ?? null)} !== null) option = options.find(item => item.value === ${JSON.stringify(String(args.optionValue ?? ''))});
      if (!option && ${JSON.stringify(args.optionText ?? null)} !== null) option = options.find(item => String(item.text).trim() === ${JSON.stringify(String(args.optionText ?? '').trim())});
      if (!option && ${Number.isInteger(args.optionIndex) ? args.optionIndex : 'null'} !== null) option = options[${Number.isInteger(args.optionIndex) ? args.optionIndex : 0}];
      if (!option) return { ok: false, message: '指定选项不存在' };
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value, text: String(option.text).trim().slice(0, 120) };
    })()`, exec.signal);
    if (!result?.ok) throw fault('DRAGON_BROWSER_SELECT', result?.message ?? '选择失败。');
    return { value: result.value, text: result.text };
  }

  async function clear (exec, args = {}) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 清空 ${targetLabel(args.target)}`, { op: 'clear', target: args.target });
    const result = await evaluate(page, `(() => {
      const el = ${targetExpression(args.target)};
      if (!el) return { ok: false, message: '找不到目标' };
      if (el.type === 'password') return { ok: false, message: '密码输入需要用户处理' };
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) el.click(); return { ok: true, cleared: true }; }
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        el.focus(); setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, cleared: true };
      }
      if (el.isContentEditable) { el.focus(); el.textContent = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true, cleared: true }; }
      return { ok: false, message: '不支持的控件' };
    })()`, exec.signal);
    if (!result?.ok) throw fault('DRAGON_BROWSER_CLEAR', result?.message ?? '清空失败。');
    return { cleared: true };
  }

  async function getValue (exec, args = {}) {
    const page = await authorize(exec, 'read');
    const result = await evaluate(page, `(() => {
      const el = ${targetExpression(args.target)};
      if (!el) return { ok: false, message: '找不到目标' };
      if (el.type === 'password') return { ok: false, message: '不读取密码输入框' };
      const value = {};
      if (el instanceof HTMLSelectElement) { value.value = el.value; value.selectedText = String(el.options[el.selectedIndex]?.text ?? '').trim(); }
      else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) value.checked = Boolean(el.checked);
      else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) value.value = el.value;
      else if (el.isContentEditable) value.value = el.textContent;
      else value.value = el.innerText;
      return { ok: true, ...value };
    })()`, exec.signal);
    if (!result?.ok) throw fault('DRAGON_BROWSER_GET_VALUE', result?.message ?? '读取失败。');
    const { ok, ...value } = result;
    return value;
  }

  async function content (exec, args = {}) {
    const format = args.format ?? 'markdown';
    if (!['html', 'markdown', 'txt', 'json'].includes(format)) throw fault('DRAGON_BROWSER_ARGS', 'format 只能是 html、markdown、txt 或 json。');
    const page = await authorize(exec, 'read');
    const selector = typeof args.selector === 'string' && args.selector.length ? args.selector : 'body';
    const expression = `(() => {
      const root = ${JSON.stringify(selector)} === 'body' ? document.body : document.querySelector(${JSON.stringify(selector)});
      if (!root) return null;
      if (${JSON.stringify(format)} === 'json') return { html: root.outerHTML, tag: root.tagName.toLowerCase() };
      return { html: root.outerHTML, text: root.innerText ?? root.textContent ?? '' };
    })()`;
    const value = await evaluate(page, expression, exec.signal);
    if (!value) throw fault('DRAGON_BROWSER_MISSING', '找不到内容选择器。');
    let output;
    let limit;
    if (format === 'html') limit = clamp(args.maxChars, 200, 500000, 50000);
    else if (format === 'markdown') limit = clamp(args.maxChars, 200, 500000, 20000);
    else limit = clamp(args.maxChars, 200, 500000, 20000);
    if (format === 'html') {
      output = String(value.html ?? '')
        .replace(/<input[^>]*type=["']?password["']?[^>]*>/gi, '<input type="password" value="" (removed)>')
        .replace(/(<input[^>]*type=["']?password["']?[^>]*value=)["'][^"']*["']/gi, '$1""');
    } else if (format === 'markdown') {
      output = htmlToMarkdown(String(value.html ?? '').slice(0, 300000));
    } else if (format === 'json') {
      output = JSON.stringify({ html: String(value.html ?? '').slice(0, 500000), tag: value.tag });
    } else {
      output = String(value.text ?? '');
    }
    const truncated = output.length > limit;
    if (truncated) output = output.slice(0, limit) + `\n\n[内容已截断于 ${limit} 字符；可用 selector 或 maxChars 收窄]`;
    return { format, content: output, truncated };
  }

  async function wait (exec, args = {}) {
    const page = await authorize(exec, 'read', { allowBlank: true });
    const timeout = clamp(args.timeoutMs, 200, 60000, 10000);
    const selector = typeof args.selector === 'string' && args.selector.length ? args.selector : null;
    const needle = typeof args.text === 'string' && args.text.length ? args.text : null;
    const expected = typeof args.url === 'string' && args.url.length ? args.url : null;
    const deadline = Date.now() + timeout;
    let reason = '等待超时';
    while (Date.now() < deadline) {
      exec.signal?.throwIfAborted();
      const state = await evaluate(page, `(() => ({ url: location.href, ready: document.readyState, found: ${selector ? `Boolean(document.querySelector(${JSON.stringify(selector)}))` : 'true'}, hasText: ${needle ? `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(needle)}))` : 'true'} }))()`, exec.signal);
      let urlOk = true;
      if (expected) {
        let absolute = null;
        try { absolute = new URL(expected).href; } catch {}
        urlOk = absolute ? state.url === absolute : state.url.includes(expected);
      }
      if (state.ready === 'complete' && urlOk && state.found && state.hasText) return { ready: true };
      reason = state.ready !== 'complete' ? '页面尚未加载完成' : '选择器或文本尚未出现';
      await delay(150, undefined, { signal: exec.signal });
    }
    return { ready: false, reason };
  }

  async function historyMove (exec, direction) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} ${direction === 'back' ? '后退' : '前进'}`, { op: direction });
    const history = await evaluate(page, '({ length: history.length, index: history.state })', exec.signal);
    void history;
    const moved = await evaluate(page, `(() => { history.${direction}(); return true; })()`, exec.signal);
    if (!moved) throw fault('DRAGON_BROWSER_HISTORY', '没有可用历史记录。');
    await waitUntil(page, exec, `document.readyState === 'complete'`, 10000);
    return direction === 'back' ? { back: true } : { forward: true };
  }

  async function reload (exec) {
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 刷新页面`, { op: 'reload' });
    await page.handle.client.call('Page.reload', {}, page.sessionId, exec.signal);
    await waitUntil(page, exec, `document.readyState === 'complete'`, 15000);
    return { refreshed: true };
  }

  async function listTabs (exec) {
    const targets = await targetList(exec);
    const state = stateFor(exec);
    const tabs = [];
    for (const target of targets.filter(item => item.type === 'page')) {
      let origin = null;
      try { origin = target.url === 'about:blank' ? null : webOrigin(target.url); } catch { origin = null; }
      if (origin) await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, 'read');
      tabs.push({ id: target.targetId, url: target.url, title: String(target.title ?? '').slice(0, 200), active: target.targetId === state.targetId, ours: state.owned.has(target.targetId) });
    }
    return { tabs };
  }

  async function switchTab (exec, args = {}) {
    const tabId = String(args.tabId ?? '');
    if (!tabId) throw fault('DRAGON_BROWSER_TAB', '需要 list_tabs 返回的 tabId。');
    const target = (await targetList(exec)).find(item => item.type === 'page' && item.targetId === tabId);
    if (!target) throw fault('DRAGON_BROWSER_TARGET_GONE', '标签不存在；请重新 list_tabs。');
    if (target.url !== 'about:blank') {
      let origin;
      try { origin = webOrigin(target.url); } catch { throw fault('DRAGON_BROWSER_ORIGIN', '只允许切换到 HTTP(S) 标签。'); }
      await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, 'control');
    }
    await confirm(exec, `切换到标签 ${tabId.slice(0, 36)}`, { op: 'switch_tab', tabId });
    const handle = await ensure(exec);
    await attachTo(exec, tabId);
    await handle.client.call('Target.activateTarget', { targetId: tabId }, undefined, exec.signal);
    return { switched: true, tab: tabId };
  }

  async function closeTab (exec, args = {}) {
    const tabId = String(args.tabId ?? '');
    if (!tabId) throw fault('DRAGON_BROWSER_TAB', '需要 list_tabs 返回的 tabId。');
    const state = stateFor(exec);
    const target = (await targetList(exec)).find(item => item.type === 'page' && item.targetId === tabId);
    if (!target) throw fault('DRAGON_BROWSER_TARGET_GONE', '标签不存在；请重新 list_tabs。');
    if (!state.owned.has(tabId) && state.targetId !== tabId) throw fault('DRAGON_BROWSER_TAB', '只能关闭本会话打开的标签；其他标签请用户自己关闭。');
    if (target.url !== 'about:blank') {
      let origin;
      try { origin = webOrigin(target.url); } catch { throw fault('DRAGON_BROWSER_ORIGIN', '只允许关闭 HTTP(S) 标签。'); }
      await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, 'control');
    }
    await confirm(exec, `关闭标签 ${tabId.slice(0, 36)}`, { op: 'close_tab', tabId });
    const handle = await ensure(exec);
    await handle.client.call('Target.closeTarget', { targetId: tabId }, undefined, exec.signal);
    state.owned.delete(tabId);
    if (state.targetId === tabId) { state.targetId = null; state.sessionId = null; }
    return { closed: true, tab: tabId };
  }

  async function screenshot (exec, args = {}) {
    const format = args.format === 'jpeg' ? 'jpeg' : 'png';
    const page = await authorize(exec, 'read');
    const params = { format, ...(format === 'jpeg' ? { quality: Math.round(clamp(args.quality, 1, 100, 70)) } : {}) };
    if (args.fullPage === true) {
      const metrics = await page.handle.client.call('Page.getLayoutMetrics', {}, page.sessionId, exec.signal);
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size?.width && size?.height) {
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: Math.min(size.width, 20000), height: Math.min(size.height, 20000), scale: 1 };
      }
    }
    const shot = await page.handle.client.call('Page.captureScreenshot', params, page.sessionId, exec.signal);
    if (typeof shot.data !== 'string' || shot.data.length === 0) throw fault('DRAGON_RESULT_LIMIT', '截图失败。');
    const bytes = Math.floor(shot.data.length * 3 / 4);
    if (bytes > MAX_RESULT) throw fault('DRAGON_RESULT_LIMIT', '截图过大；请缩小页面或使用 jpeg。');
    const result = { dataUrl: `data:image/${format};base64,${shot.data}`, bytes, format };
    if (args.savePath) {
      const target = resolveDownloadPath(downloadsDir, args.savePath);
      if (!target) throw fault('DRAGON_PATH', 'savePath 不能为空。');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(shot.data, 'base64'), { flag: 'wx' });
      result.path = target;
    }
    return result;
  }

  async function scrape (exec, args = {}) {
    const item = String(args.item ?? '');
    const fields = args.fields;
    if (!item) throw fault('DRAGON_BROWSER_ARGS', 'scrape 需要 item 容器选择器。');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) throw fault('DRAGON_BROWSER_ARGS', 'scrape 需要 fields 映射对象。');
    const page = await authorize(exec, 'read');
    const deadline = Date.now() + clamp(args.timeoutMs, 200, 30000, 5000);
    while (Date.now() < deadline) {
      exec.signal?.throwIfAborted();
      const found = await evaluate(page, `Boolean(document.querySelector(${JSON.stringify(item)}))`, exec.signal);
      if (found) break;
      await delay(150, undefined, { signal: exec.signal });
    }
    const result = await evaluate(page, `(() => {
      const containers = [...document.querySelectorAll(${JSON.stringify(item)})];
      const fields = ${JSON.stringify(fields)};
      const items = [];
      for (const container of containers.slice(0, 500)) {
        const row = {};
        for (const [key, spec] of Object.entries(fields)) {
          const raw = String(spec);
          const at = raw.lastIndexOf('@');
          const selector = at > 0 ? raw.slice(0, at) : raw;
          const attribute = at > 0 ? raw.slice(at + 1) : null;
          let node = container;
          if (selector) { try { node = container.querySelector(selector); } catch { node = null; } }
          let value = null;
          if (node) {
            if (attribute === 'href') value = node.getAttribute('href') ?? node.href ?? null;
            else if (attribute) value = node.getAttribute(attribute);
            else value = node.innerText ?? node.textContent ?? '';
          }
          row[key] = value === null || value === undefined ? null : String(value).replace(/\\s+/g, ' ').trim().slice(0, 2000);
        }
        items.push(row);
      }
      return { count: items.length, items };
    })()`, exec.signal);
    return result ?? { count: 0, items: [] };
  }

  async function challenge (exec) {
    const page = await authorize(exec, 'read', { allowBlank: true });
    const result = await evaluate(page, `(() => {
      const frames = [...document.querySelectorAll('iframe')].map(item => item.getAttribute('src') || '');
      const captchaFrame = frames.find(src => /recaptcha|hcaptcha|turnstile|arkoselabs|geetest|challenges\\.cloudflare|challenge-platform/i.test(src)) || null;
      const selector = ['#challenge-form', '#cf-challenge-running', '.cf-turnstile', '[data-sitekey]', 'iframe[src*="captcha"]', 'form[action*="challenge"]'].find(item => document.querySelector(item)) || null;
      const body = String(document.body?.innerText || '').slice(0, 20000);
      const phrase = /verify (that )?you are (a )?human|确认您是人类|验证您是人类|安全验证|人机验证|Just a moment|Checking your browser|请完成验证|滑动验证/i.test(body);
      return { captchaFrame, selector, phrase };
    })()`, exec.signal);
    if (!result || (!result.captchaFrame && !result.selector && !result.phrase)) return { blocked: false };
    const kind = result.captchaFrame?.match(/recaptcha|hcaptcha|turnstile|arkoselabs|geetest/i)?.[0]
      ?? result.captchaFrame?.match(/cloudflare/i)?.[0] ?? 'captcha';
    return { blocked: true, kind, reason: result.phrase ? '页面出现人机验证文案' : '页面加载了验证组件', hint: '请在共享浏览器窗口里由用户完成验证，完成后重新 snapshot。' };
  }

  async function download (exec, args = {}) {
    const url = String(args.url ?? '');
    let href;
    try { href = new URL(url).href; } catch { throw fault('DRAGON_INVALID_URL', '下载需要完整的 HTTP(S) 网址。'); }
    const origin = webOrigin(href);
    const target = resolveDownloadPath(downloadsDir, args.savePath);
    if (!target) throw fault('DRAGON_PATH', 'download 需要 savePath。');
    await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, 'control');
    await confirm(exec, `下载 ${href} 到 ${target}`, { op: 'download', url: href, savePath: target });
    const page = await pageFor(exec);
    let cookieHeader = '';
    try {
      const hostname = new URL(href).hostname.toLowerCase();
      const { cookies } = await page.handle.client.call('Network.getAllCookies', {}, page.sessionId, exec.signal);
      cookieHeader = (cookies ?? []).filter(cookie => {
        const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
        return domain && (hostname === domain || hostname.endsWith('.' + domain));
      }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    } catch {}
    const response = await fetch(href, {
      redirect: 'follow',
      headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...(page.info?.url && page.info.url !== 'about:blank' ? { referer: page.info.url } : {}) },
      signal: exec.signal
    });
    if (!response.ok) throw fault('DRAGON_BROWSER_DOWNLOAD', `下载失败（HTTP ${response.status}）。`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD) throw fault('DRAGON_BROWSER_DOWNLOAD', '文件超过 256MB 上限。');
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_DOWNLOAD) { await reader.cancel().catch(() => {}); throw fault('DRAGON_BROWSER_DOWNLOAD', '文件超过 256MB 上限。'); }
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.concat(chunks), { flag: 'wx' });
    return { path: target, bytes: total, contentType: response.headers.get('content-type') ?? null };
  }

  async function execute (exec, args = {}) {
    const script = String(args.script ?? '');
    if (!script.trim()) throw fault('DRAGON_BROWSER_ARGS', 'execute 需要 script。');
    if (script.length > 200000) throw fault('DRAGON_BROWSER_ARGS', 'script 过长。');
    if (!await permissions.pageScriptEnabled()) throw fault('DRAGON_BROWSER_EXECUTE_DISABLED', '页面脚本执行已关闭（permissions.json 的 allowPageScript）。');
    const page = await authorize(exec, 'control');
    await confirm(exec, `在 ${page.origin} 执行页面脚本`, { op: 'execute', script: script.slice(0, 200) });
    const payload = Array.isArray(args.args) ? args.args.slice(0, 20) : [];
    const expression = `(function () {\n${script}\n}).apply(null, ${JSON.stringify(payload)})`;
    const result = await page.handle.client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, page.sessionId, exec.signal);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知错误';
      return { ok: false, exception: String(detail).slice(0, 5000) };
    }
    let value = result.result?.value ?? null;
    try { value = JSON.parse(JSON.stringify(value)); } catch { value = String(value); }
    if (typeof value === 'string' && value.length > 50000) value = value.slice(0, 50000) + '…[结果已截断于 50000 字符]';
    return { ok: true, value };
  }

  async function resetSession (exec) {
    const state = stateFor(exec);
    let closed = 0;
    for (const targetId of [...state.owned]) {
      try {
        const handle = await ensure(exec);
        await handle.client.call('Target.closeTarget', { targetId }, undefined, exec.signal);
        closed++;
      } catch {}
    }
    state.owned.clear();
    state.targetId = null;
    state.sessionId = null;
    return { reset: true, closed };
  }

  return {
    profileDir,
    downloadsDir,
    status () {
      const found = find();
      return {
        backend: 'dragon-cdp',
        profileDir,
        downloadsDir,
        launched: Boolean(runtime && !runtime.client.closed),
        browser: runtime?.browser ?? found?.name ?? 'not-found',
        executable: runtime?.executable ?? found?.path ?? null,
        reused: runtime?.reused ?? false,
        lastError
      };
    },
    hasBrowser: () => Boolean(find()),
    open, snapshot, a11y: async (exec, args = {}) => {
      const page = await authorize(exec, 'read');
      const { nodes } = await page.handle.client.call('Accessibility.getFullAXTree', {}, page.sessionId, exec.signal);
      const max = Math.round(clamp(args.maxNodes, 10, 5000, 150));
      const byId = new Map();
      for (const node of nodes ?? []) byId.set(node.nodeId, node);
      const depthOf = node => {
        let depth = 0;
        let parent = node.parentId ? byId.get(node.parentId) : null;
        while (parent && depth < 50) { depth++; parent = parent.parentId ? byId.get(parent.parentId) : null; }
        return depth;
      };
      const list = [];
      let capped = false;
      for (const node of nodes ?? []) {
        if (node.ignored) continue;
        const role = node.role?.value;
        if (!role || ['generic', 'none', 'RootWebArea', 'InlineTextBox', 'StaticText'].includes(role)) continue;
        const name = node.name?.value;
        const value = node.value?.value;
        if (!name && !value && role !== 'textbox' && role !== 'searchbox') continue;
        if (list.length >= max) { capped = true; break; }
        const properties = Object.fromEntries((node.properties ?? []).map(item => [item.name, item.value?.value]));
        const states = [];
        if (properties.disabled === true) states.push('disabled');
        if (properties.checked !== undefined) states.push('checked=' + properties.checked);
        if (properties.expanded !== undefined) states.push('expanded=' + properties.expanded);
        if (properties.selected === true) states.push('selected');
        if (properties.required === true) states.push('required');
        if (properties.readonly === true) states.push('readonly');
        const entry = { role, name: String(name ?? '').slice(0, 160), depth: depthOf(node) };
        if (value !== undefined && value !== null && String(value).length) entry.value = String(value).slice(0, 160);
        if (states.length) entry.states = states;
        list.push(entry);
      }
      return { url: page.info.url, title: page.info.title, count: list.length, nodes: list, truncated: capped };
    },
    content, click, type, fill, setValue, getValue, check, select, clear, scroll, key, wait,
    back: exec => historyMove(exec, 'back'), forward: exec => historyMove(exec, 'forward'), reload,
    listTabs, switchTab, closeTab, screenshot, scrape, challenge, download, execute, resetSession,
    dispose: async () => {
      sessions.clear();
      const handle = runtime ?? launchHandle;
      runtime = null;
      launchHandle = null;
      if (!handle) return;
      // 1) 优雅关闭：CDP Browser.close（连接已断时重连一次再关）。
      if (handle.client && !handle.client.closed) {
        try { await handle.client.call('Browser.close', {}, undefined, AbortSignal.timeout(3000)); } catch {}
      } else if (handle.port) {
        try {
          const client = await CdpClient.connect(`ws://127.0.0.1:${handle.port}${handle.wsPath}`, { signal: AbortSignal.timeout(2000) });
          await client.call('Browser.close', {}, undefined, AbortSignal.timeout(3000));
          client.close();
        } catch {}
      }
      try { handle.client?.close?.(); } catch {}
      closeManagedBrowser(handle);
      // 2) 端口关闭不代表进程退出（Edge 可能留下主进程），按 profile 精确兜底清理。
      if (!handle.port) return;
      await delay(400);
      await killBrowserByProfile(profileDir);
    }
  };
}
