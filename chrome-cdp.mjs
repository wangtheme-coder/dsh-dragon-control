import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fault } from './validation.mjs';
import { webOrigin } from './permissions.mjs';

const signalFor = (signal, timeout = 10000) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
const stopped = () => fault('DRAGON_CDP_CLOSED', '浏览器调试连接已断开；请重新 attach。');

export class CdpClient {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.closed = false;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      pending.finish(message.error ? fault('DRAGON_CDP_ERROR', '浏览器拒绝了调试命令；动作结果可能未知，请重新观察。') : null, message.result ?? {});
    });
    const close = () => { this.closed = true; for (const pending of [...this.pending.values()]) pending.finish(stopped()); };
    socket.addEventListener('close', close); socket.addEventListener('error', close);
  }
  static connect(url, { signal, WebSocketImpl = globalThis.WebSocket } = {}) {
    const bound = signalFor(signal); bound.throwIfAborted();
    const socket = new WebSocketImpl(url);
    return new Promise((resolve, reject) => {
      const finish = error => {
        bound.removeEventListener('abort', abort);
        socket.removeEventListener('open', open); socket.removeEventListener('error', fail); socket.removeEventListener('close', fail);
        if (error) { try { socket.close(); } catch {} reject(error); } else resolve(new CdpClient(socket));
      };
      const abort = () => finish(bound.reason), open = () => finish(), fail = () => finish(stopped());
      bound.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', open, { once: true }); socket.addEventListener('error', fail, { once: true }); socket.addEventListener('close', fail, { once: true });
    });
  }
  call(method, params = {}, sessionId, signal) {
    const bound = signalFor(signal); bound.throwIfAborted();
    if (this.closed) return Promise.reject(stopped());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => finish(bound.reason);
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        bound.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      this.pending.set(id, { finish }); bound.addEventListener('abort', abort, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { finish(stopped()); }
    });
  }
  close() {
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.finish(stopped());
    try { this.socket.close(); } catch {}
  }
}

export function validateEndpoint(value, port) {
  let url; try { url = new URL(value); } catch { throw fault('DRAGON_CDP_ENDPOINT', '无效的调试地址。'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.username || url.password ||
      !/^\/devtools\/browser\/[^/]+$/.test(url.pathname) || url.search || url.hash) {
    throw fault('DRAGON_CDP_ENDPOINT', '只允许连接指定端口上 127.0.0.1 的浏览器调试地址。');
  }
  return url.href;
}
export async function probeBrowser(port, signal) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('DRAGON_CDP_PORT', '端口必须是 1–65535 的整数。');
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: 'error', signal: signalFor(signal, 1500) }); }
  catch { signal?.throwIfAborted(); return null; }
  if (!response.ok) return null;
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) throw fault('DRAGON_RESULT_LIMIT', '调试端口响应过大。'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  if (typeof body.webSocketDebuggerUrl !== 'string') return null;
  return { port, url: validateEndpoint(body.webSocketDebuggerUrl, port), browser: String(body.Browser ?? 'browser').slice(0, 128) };
}

const OPS = new Set(['tabs', 'content', 'text', 'wait', 'screenshot', 'current', 'open', 'goto', 'click', 'fill', 'type', 'key', 'scroll', 'back', 'forward', 'reload', 'switch', 'close', 'new_tab']);
const READS = new Set(['content', 'text', 'wait', 'screenshot', 'current']);
const originOf = url => { try { return webOrigin(url); } catch { return null; } };

// Connections and selected targets belong to an Agent/session, never to the whole Host.
export function createChromeBridge({ permissions, connect = CdpClient.connect, probe = probeBrowser } = {}) {
  const states = new Map();
  const key = exec => exec.agent?.id ?? 'local-test';
  const call = (s, exec, method, params = {}, session) => {
    exec.signal?.throwIfAborted();
    if (s.closed) throw stopped();
    return s.cdp.call(method, params, session, exec.signal);
  };
  function state(exec) {
    const s = states.get(key(exec));
    if (!s || s.owner !== exec.agent?.session || s.cdp.closed || s.closed) throw fault('DRAGON_CDP_DETACHED', '当前会话尚未连接浏览器，请先 attach。');
    return s;
  }
  async function exclusive(s, operation) {
    if (s.busy) throw fault('DRAGON_CDP_BUSY', '本会话已有浏览器动作正在执行。');
    s.busy = true; try { return await operation(); } finally { s.busy = false; }
  }
  async function select(s, exec, targetId) {
    if (s.targetId === targetId && s.session) return;
    const attached = await call(s, exec, 'Target.attachToTarget', { targetId, flatten: true });
    const old = s.session; s.session = attached.sessionId; s.targetId = targetId;
    if (old) await call(s, exec, 'Target.detachFromTarget', { sessionId: old });
    await call(s, exec, 'Page.enable', {}, s.session);
  }
  async function snapshot(s, exec, target = s.targetId) {
    const targets = (await call(s, exec, 'Target.getTargets')).targetInfos ?? [];
    const page = targets.find(t => t.type === 'page' && t.targetId === target);
    if (!page) throw fault('DRAGON_CDP_TARGET_GONE', '所选标签已经关闭；请重新列出标签，不会自动切到其他页面。');
    const session = target === s.targetId && s.session ? s.session : (await call(s, exec, 'Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    try {
      const { frameTree } = await call(s, exec, 'Page.getFrameTree', {}, session);
      const frame = frameTree.frame;
      return { target, url: frame.url, origin: originOf(frame.url), frame: frame.id, loader: frame.loaderId, session };
    } finally { if (session !== s.session) await call(s, exec, 'Target.detachFromTarget', { sessionId: session }); }
  }
  async function unchanged(s, exec, previous) {
    const current = await snapshot(s, exec, previous.target);
    if (['target', 'url', 'frame', 'loader'].some(k => current[k] !== previous[k])) throw fault('DRAGON_CDP_STALE', '确认或读取期间页面发生变化；请重新观察，动作不自动重试。');
    return current;
  }
  async function authorize(s, exec, scope, target, allowBlank = false) {
    const before = await snapshot(s, exec, target);
    if (allowBlank && before.url === 'about:blank') { await unchanged(s, exec, before); return before; }
    if (!before.origin) throw fault('DRAGON_CDP_ORIGIN', '只允许读取和操作 HTTP(S) 网页。');
    await permissions.require(exec, { kind: 'origin', id: before.origin }, scope);
    await unchanged(s, exec, before); return before;
  }
  async function confirm(s, exec, op, args, before) {
    await permissions.confirm(exec, `浏览器 ${op}：${before?.origin ?? '新标签'}`, { op, args, target: before });
    if (before) await unchanged(s, exec, before);
    exec.signal?.throwIfAborted();
  }
  async function evaluate(s, exec, before, expression) {
    await unchanged(s, exec, before);
    const { executionContextId } = await call(s, exec, 'Page.createIsolatedWorld', { frameId: before.frame, worldName: s.world }, s.session);
    await unchanged(s, exec, before);
    const result = await call(s, exec, 'Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: false }, s.session);
    if (result.exceptionDetails) throw fault('DRAGON_CDP_EVALUATE', '页面动作失败或结果未知，请重新观察。');
    return result.result?.value;
  }
  async function tabs(s, exec) {
    const targets = (await call(s, exec, 'Target.getTargets')).targetInfos ?? [];
    const result = [];
    for (const t of targets.filter(t => t.type === 'page')) {
      const origin = originOf(t.url);
      if (!origin) { if (t.url === 'about:blank') result.push({ id: t.targetId, url: 'about:blank', title: '' }); continue; }
      await permissions.require(exec, { kind: 'origin', id: origin }, 'read');
      const fresh = (await call(s, exec, 'Target.getTargets')).targetInfos?.find(n => n.targetId === t.targetId && n.type === 'page');
      if (!fresh || fresh.url !== t.url) throw fault('DRAGON_CDP_STALE', '列出标签期间页面发生变化；请重新读取。');
      result.push({ id: fresh.targetId, url: fresh.url, title: String(fresh.title).slice(0, 512) });
    }
    return { tabs: result };
  }
  const bridge = {
    get attached() { return states.size > 0; },
    isAttached(exec) { try { state(exec); return true; } catch { return false; } },
    async attach({ port = 9222 } = {}, exec) {
      if (bridge.isAttached(exec)) throw fault('DRAGON_CDP_ATTACHED', '本会话已连接；更换端口前请 detach。');
      await permissions.confirm(exec, `连接本机浏览器调试端口 ${port}`, { port });
      const endpoint = await probe(port, exec.signal);
      if (!endpoint) throw fault('DRAGON_CDP_UNAVAILABLE', '该端口没有可用浏览器；请使用独立数据目录并由用户开启调试端口。');
      const cdp = await connect(validateEndpoint(endpoint.url, port), { signal: exec.signal });
      const previous = states.get(key(exec)); previous?.cdp.close();
      const s = { cdp, world: `dragon-${randomUUID()}`, owner: exec.agent?.session, closed: false, session: null, targetId: null, busy: false };
      const abort = () => { s.closed = true; cdp.close(); };
      exec.signal?.addEventListener('abort', abort, { once: true });
      try {
        exec.signal?.throwIfAborted(); states.set(key(exec), s);
        const listed = await tabs(s, exec);
        const first = listed.tabs[0]; if (first) await select(s, exec, first.id);
        return { attached: true, port, browser: endpoint.browser, ...listed };
      } catch (error) { bridge.detach(exec); throw error; }
      finally { exec.signal?.removeEventListener('abort', abort); }
    },
    detach(exec) {
      const s = states.get(key(exec));
      if (s && s.owner === exec.agent?.session) { s.closed = true; s.cdp.close(); states.delete(key(exec)); }
      return { attached: false };
    },
    dispose() { for (const s of states.values()) { s.closed = true; s.cdp.close(); } states.clear(); },
    async execute(op, args, exec) {
      if (!OPS.has(op)) throw fault('DRAGON_CDP_OP', '未知的 chrome 操作。');
      const s = state(exec);
      return exclusive(s, async () => {
        if (op === 'tabs') return tabs(s, exec);
        if (op === 'open' || op === 'goto' || op === 'new_tab') {
          const url = op === 'new_tab' ? 'about:blank' : new URL(args.url).href;
          if (op !== 'new_tab') await permissions.require(exec, { kind: 'origin', id: webOrigin(url) }, 'control');
          const before = op === 'goto' ? await authorize(s, exec, 'control', undefined, true) : null;
          await confirm(s, exec, op, { url }, before);
          let navigation;
          if (op !== 'goto') { const created = await call(s, exec, 'Target.createTarget', { url: 'about:blank' }); await select(s, exec, created.targetId); }
          if (op !== 'new_tab') {
            navigation = await call(s, exec, 'Page.navigate', { url }, s.session);
            if (navigation.errorText) {
              const reason = /^net::[A-Z0-9_]+$/.test(navigation.errorText) ? navigation.errorText : 'navigation failed';
              throw fault('DRAGON_CDP_NAVIGATION', `浏览器导航失败（${reason}）；请重新观察，不自动重试。`);
            }
          }
          if (op !== 'new_tab') {
            // A created target can still be about:blank after Page.enable. Wait on
            // actual navigation state, not machine speed, before selector waits.
            const deadline = Date.now() + 10000;
            let page;
            do {
              page = await snapshot(s, exec);
              if (page.url !== 'about:blank' && (!navigation.loaderId || page.loader === navigation.loaderId)) break;
              await delay(100, undefined, { signal: exec.signal });
            } while (Date.now() < deadline);
            if (page.url === 'about:blank' || navigation.loaderId && page.loader !== navigation.loaderId) throw fault('DRAGON_CDP_TIMEOUT', '页面导航尚未完成；请重新读取状态，不要重复打开。');
            await authorize(s, exec, 'read');
          }
          return { actionAccepted: true, requestedUrl: url, tab: s.targetId, note: '请等待并重新读取实际页面。' };
        }
        if (op === 'switch' || op === 'close') {
          if (typeof args.tab !== 'string') throw fault('DRAGON_CDP_TAB', '需要 tabs 返回的标签 ID。');
          const before = await authorize(s, exec, 'control', args.tab, true);
          await confirm(s, exec, op, args, before);
          if (op === 'switch') { await select(s, exec, args.tab); await call(s, exec, 'Target.activateTarget', { targetId: args.tab }); }
          else { await call(s, exec, 'Target.closeTarget', { targetId: args.tab }); if (s.targetId === args.tab) { s.targetId = null; s.session = null; } }
          return { actionAccepted: true, tab: args.tab };
        }
        const before = await authorize(s, exec, READS.has(op) ? 'read' : 'control');
        if (op === 'current') return { url: before.url, origin: before.origin, tab: before.target };
        if (op === 'wait') {
          if (!args.selector && !args.text) throw fault('DRAGON_CDP_WAIT', 'wait 需要 selector 或 text。');
          const start = Date.now(), timeout = Math.min(Math.max(args.timeout_ms ?? 10000, 200), 60000);
          while (Date.now() - start < timeout) {
            const found = await evaluate(s, exec, before, args.selector ? `Boolean(document.querySelector(${JSON.stringify(args.selector)}))` : `Boolean(document.body?.innerText.includes(${JSON.stringify(args.text)}))`);
            await unchanged(s, exec, before);
            if (found) return { matched: true, waitedMs: Date.now() - start };
            await delay(150, undefined, { signal: exec.signal });
          }
          throw fault('DRAGON_CDP_TIMEOUT', '等待超时；不会自动重复之前的动作。');
        }
        if (op === 'content' || op === 'text') {
          const expression = op === 'text' ? 'document.body?.innerText ?? ""' : `(() => { const root = document.documentElement.cloneNode(true); for (const e of root.querySelectorAll('input[type=password]')) e.removeAttribute('value'); return root.outerHTML; })()`;
          const value = await evaluate(s, exec, before, expression); await unchanged(s, exec, before);
          return { [op]: String(value ?? '').slice(0, 200000) };
        }
        if (op === 'screenshot') {
          const shot = await call(s, exec, 'Page.captureScreenshot', { format: 'png' }, s.session); await unchanged(s, exec, before);
          if (typeof shot.data !== 'string' || shot.data.length > 33554432) throw fault('DRAGON_RESULT_LIMIT', '截图过大或无效。');
          return { dataUrl: `data:image/png;base64,${shot.data}`, bytes: Math.floor(shot.data.length * 3 / 4) };
        }
        await confirm(s, exec, op, args, before);
        if (op === 'click' || op === 'fill') {
          if (op === 'click' && !args.selector && !args.text || op === 'fill' && (typeof args.selector !== 'string' || typeof args.value !== 'string')) throw fault('DRAGON_CDP_ARGS', 'click 需要 selector/text；fill 需要 selector/value。');
          const expression = `(() => { const matches = ${args.selector ? `[...document.querySelectorAll(${JSON.stringify(args.selector)})]` : `[...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button]')].filter(e => (e.innerText || e.value || '').trim() === ${JSON.stringify(args.text)})`};
            if (matches.length !== 1) return 'ambiguous-or-missing'; const el = matches[0];
            if (!el.getClientRects().length || el.disabled || el.type === 'password') return 'unavailable';
            ${op === 'click' ? "el.click();" : `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.readOnly) return 'unavailable'; const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; el.focus(); setter.call(el, ${JSON.stringify(args.value)}); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));`}
            return 'accepted'; })()`;
          if (await evaluate(s, exec, before, expression) !== 'accepted') throw fault('DRAGON_CDP_MISSING', '目标缺失、不唯一、不可见或为受保护输入框。');
        } else if (op === 'type') {
          if (typeof args.text !== 'string') throw fault('DRAGON_CDP_ARGS', 'type 需要 text。');
          const safe = await evaluate(s, exec, before, `Boolean(document.activeElement && document.activeElement.type !== 'password')`);
          if (!safe) throw fault('DRAGON_CDP_PASSWORD', '密码输入需由用户处理。');
          await call(s, exec, 'Input.insertText', { text: args.text }, s.session);
        } else if (op === 'key') {
          const code = { Enter: 13, Escape: 27, Tab: 9 }[args.key]; if (!code) throw fault('DRAGON_CDP_KEY', '只支持 Enter、Escape、Tab。');
          await call(s, exec, 'Input.dispatchKeyEvent', { type: 'keyDown', key: args.key, code: args.key, windowsVirtualKeyCode: code }, s.session);
          await s.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key, code: args.key, windowsVirtualKeyCode: code }, s.session);
        } else if (op === 'scroll') {
          const amount = args.amount ?? 600; if (!Number.isFinite(amount) || Math.abs(amount) > 100000) throw fault('DRAGON_CDP_ARGS', '滚动距离超出范围。');
          await evaluate(s, exec, before, `window.scrollBy(0, ${Math.round(amount)})`);
        } else if (op === 'back' || op === 'forward') {
          const history = await call(s, exec, 'Page.getNavigationHistory', {}, s.session);
          const entry = history.entries[history.currentIndex + (op === 'back' ? -1 : 1)];
          if (!entry) throw fault('DRAGON_CDP_HISTORY', '没有可用历史记录。');
          await permissions.require(exec, { kind: 'origin', id: webOrigin(entry.url) }, 'control'); await unchanged(s, exec, before);
          await call(s, exec, 'Page.navigateToHistoryEntry', { entryId: entry.id }, s.session);
        } else if (op === 'reload') await call(s, exec, 'Page.reload', {}, s.session);
        return { actionAccepted: true, note: '请重新读取页面核对结果；不要自动重复提交。' };
      });
    }
  };
  return bridge;
}
