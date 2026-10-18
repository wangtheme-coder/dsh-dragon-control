import { AsyncLocalStorage } from 'node:async_hooks';
import { runNative } from './native-client.mjs';
import { webOrigin } from './permissions.mjs';
import { fault } from './validation.mjs';
import { mkdir, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

export function createExecutionScope(permissions, { native = runNative } = {}) {
  const local = new AsyncLocalStorage();
  const get = () => {
    const exec = local.getStore();
    if (!exec) throw fault('DRAGON_NO_EXECUTION', '界面动作缺少执行作用域。');
    exec.signal?.throwIfAborted(); return exec;
  };
  const same = (a, b) => ['windowId', 'pid', 'path', 'created', 'className'].every(k => String(a[k]).toLowerCase() === String(b[k]).toLowerCase());
  function accessible(identity) {
    if (!identity.interactiveDesktop) throw fault('DRAGON_DESKTOP_UNAVAILABLE', '当前不是普通输入桌面，请用户手动处理。');
    if (!identity.accessKnown) throw fault('DRAGON_WINDOW_ACCESS_DENIED', '目标进程身份或权限无法确认。');
    if (identity.elevated) throw fault('DRAGON_WINDOW_ELEVATED', '管理员窗口需要用户手动处理。');
  }
  async function authorizeWindow(exec, windowId, scope, expected) {
    const inspect = () => native({ op: 'inspect', windowId }, exec.signal);
    const identity = await inspect();
    if (!identity.interactiveDesktop) throw fault('DRAGON_DESKTOP_UNAVAILABLE', '当前不是可操作的普通桌面，可能已锁屏或处于安全桌面；请用户手动处理。');
    if (!identity.accessKnown) throw fault('DRAGON_WINDOW_ACCESS_DENIED', '目标进程身份或权限无法确认，停止操作。');
    if (identity.elevated) throw fault('DRAGON_WINDOW_ELEVATED', '目标窗口是更高权限的管理员窗口，请用户手动处理。');
    if (expected && !same(identity, expected)) throw fault('DRAGON_TARGET_CHANGED', '窗口进程身份已变化，请重新观察。');
    await permissions.require(exec, { kind: 'app', id: identity.path, label: identity.path }, scope);
    const verified = await inspect();
    accessible(verified);
    if (!same(identity, verified)) throw fault('DRAGON_TARGET_CHANGED', '确认期间目标窗口发生变化。');
    return verified;
  }
  return {
    get, run: (exec, operation) => local.run(exec, () => operation(exec)), authorizeWindow,
    secureDesktop(backend) {
      return new Proxy(backend, { get(target, property) {
        const original = target[property];
        if (typeof original !== 'function') return original;
        if (property === 'listScreens') return async signal => {
          const screens = await original.call(target, signal);
          for (const screen of screens) {
            const identity = await authorizeWindow(get(), screen.windowId, 'read');
            const current = (await target.listScreens(signal))[0];
            if (!current || current.windowId !== screen.windowId || ['x', 'y', 'width', 'height'].some(k => current.bounds[k] !== screen.bounds[k])) {
              throw fault('DRAGON_TARGET_CHANGED', '授权期间前台窗口或位置已变化，请重新观察。');
            }
            screen.dragonIdentity = identity;
          }
          return screens;
        };
        if (property === 'capture') return async (screen, signal) => {
          const exec = get();
          const identity = await authorizeWindow(exec, screen.windowId, 'read', screen.dragonIdentity);
          const current = (await target.listScreens(signal))[0];
          if (!current || current.windowId !== screen.windowId || ['x', 'y', 'width', 'height'].some(k => current.bounds[k] !== screen.bounds[k])) {
            throw fault('DRAGON_TARGET_CHANGED', '截图前目标窗口或位置已变化，请重新观察。');
          }
          exec.dragonCaptured = { identity, bounds: { ...screen.bounds } };
          return original.call(target, screen, signal);
        };
        if (['click', 'typeText', 'scroll', 'hotkey', 'longPress', 'drag'].includes(property)) return async (input, signal) => {
          const exec = get(), current = (await target.listScreens(signal))[0];
          if (!current || (exec.dragonExpectedBounds && ['x', 'y', 'width', 'height'].some(k => current.bounds[k] !== exec.dragonExpectedBounds[k])) ||
              (input.screen && (current.windowId !== input.screen.windowId ||
              ['x', 'y', 'width', 'height'].some(k => current.bounds[k] !== input.screen.bounds[k])))) {
            throw fault('DRAGON_TARGET_CHANGED', '输入前目标窗口或位置已变化。');
          }
          await authorizeWindow(exec, current.windowId, 'control', exec.dragonExpectedWindow);
          const verified = (await target.listScreens(signal))[0];
          if (!verified || verified.windowId !== current.windowId || ['x', 'y', 'width', 'height'].some(k => verified.bounds[k] !== current.bounds[k])) {
            throw fault('DRAGON_TARGET_CHANGED', '输入前窗口再次变化，已停止操作。');
          }
          return original.call(target, input, signal);
        };
        if (property === 'inspectForeground') return async signal => {
          const screen = (await target.listScreens(signal))[0];
          if (screen) await authorizeWindow(get(), screen.windowId, 'read');
          return original.call(target, signal);
        };
        return original.bind(target);
      } });
    },
    secureBrowser(browser, downloadsDir) {
      const writes = new Set(['click', 'type', 'fillForm', 'setValue', 'check', 'selectOption', 'clearField', 'key', 'execute', 'download', 'closeTab', 'reset', 'reload', 'back', 'forward']);
      const readMethods = new Set(['snapshot', 'a11y', 'content', 'screenshot', 'detectChallenge', 'getValue', 'scrape', 'waitFor', 'scroll', 'reload', 'back', 'forward']);
      async function tabState(session, targetId) {
        const tabs = await browser.listTabs(session);
        const tab = targetId ? tabs.find(t => t.id === targetId) : tabs.find(t => t.active);
        if (!tab) throw fault('DRAGON_BROWSER_TARGET_GONE', '浏览器标签不存在。');
        return { id: tab.id, url: tab.url ?? '', origin: !tab.url || tab.url === 'about:blank' ? null : webOrigin(tab.url) };
      }
      async function requireOrigin(exec, origin, scope) {
        if (!origin) return;
        await permissions.require(exec, { kind: 'origin', id: origin, label: origin }, scope);
      }
      return new Proxy(browser, { get(target, method) {
        const original = target[method];
        if (typeof original !== 'function') return original;
        if (!writes.has(method) && !readMethods.has(method) && !['openUrl', 'navigate', 'listTabs', 'switchTab'].includes(method)) return original.bind(target);
        return async (session, request, ...rest) => {
          const exec = get();
          if (method === 'execute' && !await permissions.pageScriptEnabled()) throw fault('DRAGON_SCRIPT_DISABLED', '任意页面脚本默认关闭；由用户在 permissions.json 显式开启后才能使用。');
          if (method === 'listTabs') {
            const tabs = await target.listTabs(session);
            for (const tab of tabs) if (tab.url && tab.url !== 'about:blank') await requireOrigin(exec, webOrigin(tab.url), 'read');
            const current = await target.listTabs(session);
            if (JSON.stringify(tabs) !== JSON.stringify(current)) throw fault('DRAGON_BROWSER_TARGET_CHANGED', '授权期间标签列表发生变化，请重新读取。');
            return tabs;
          }
          const targetId = ['switchTab', 'closeTab'].includes(method) ? request : undefined;
          const navigates = ['openUrl', 'navigate', 'download'].includes(method);
          // Authorize a destination before touching the browser runtime: a refused
          // navigation must not launch Electron or leave a blank window behind.
          if (navigates) {
            const destination = webOrigin(request.url);
            if (method === 'download') {
              if (!downloadsDir || !isAbsolute(request.savePath) || resolve(dirname(request.savePath)).toLowerCase() !== resolve(downloadsDir).toLowerCase() ||
                  /[:]/.test(basename(request.savePath)) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename(request.savePath))) {
                throw fault('DRAGON_DOWNLOAD_PATH', '请将文件直接保存到 status 返回的插件下载目录；不允许越界、设备路径或子目录。');
              }
              try { await lstat(request.savePath); throw fault('DRAGON_FILE_EXISTS', '下载目标已存在；请使用新文件名。'); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await requireOrigin(exec, destination, writes.has(method) ? 'control' : 'read');
          }
          const before = await tabState(session, targetId);
          if (!navigates) await requireOrigin(exec, before.origin, writes.has(method) ? 'control' : 'read');
          if (writes.has(method)) {
            const descriptor = method === 'download' ? `下载到 ${request.savePath}` : `在 ${before.origin ?? '空标签'} 执行 ${method}`;
            await permissions.confirm(exec, descriptor, { method, tab: before, request });
          }
          // Revalidate after the user answered. A changed tab must not reuse approval.
          if (JSON.stringify(before) !== JSON.stringify(await tabState(session, targetId))) throw fault('DRAGON_BROWSER_TARGET_CHANGED', '确认期间浏览器目标已变化，请重新观察。');
          if (method === 'download') {
            await mkdir(downloadsDir, { recursive: true });
            if ((await lstat(downloadsDir)).isSymbolicLink()) throw fault('DRAGON_DOWNLOAD_PATH', '下载目录不允许使用链接。');
            try { await lstat(request.savePath); throw fault('DRAGON_FILE_EXISTS', '确认期间文件已出现，请使用新文件名。'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          const result = await original.call(target, session, request, ...rest);
          if (!['closeTab', 'reset'].includes(method)) {
            const after = await tabState(session);
            await requireOrigin(exec, after.origin, 'read');
          }
          return result;
        };
      } });
    }
  };
}
