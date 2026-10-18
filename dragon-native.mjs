import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fault } from './validation.mjs';
import { requestNative } from './native-session.mjs';

// 龙爪自立原生层：所有 Win32 动作都在独立进程 DragonNative.exe 里完成。
// 进程隔离是刻意的：原生代码出问题只会拖垮它自己，不会把 DSH 宿主的堆搞坏。
// 每个 exe 同一时间只保留一个进程，请求逐行排队（原生侧本来就是单线程循环）。
export const NATIVE_PATH = fileURLToPath(new URL('./native/DragonNative.exe', import.meta.url));

export function runDragonNative(request, signal) {
  signal?.throwIfAborted();
  return requestNative(NATIVE_PATH, request, signal, { timeoutMs: 12000 });
}

/** 低频的热键急停监听：常驻 DragonNative.exe 的 watch 模式，由 worker 转发事件。 */
export function spawnEscapeWatcher({ includeInjected = false, onEscape, onError, onReady } = {}) {
  const child = spawn(NATIVE_PATH, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false, closed = false;
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.event === 'ready' && !ready) { ready = true; onReady?.(); }
      if (message.event === 'escape') onEscape?.(message);
    }
  });
  child.once('error', error => { if (!closed) onError?.(error); });
  child.once('close', code => { closed = true; if (!closed) return; if (ready) onError?.(Error(`Esc 监听进程已退出 (${code})。`)); });
  child.stdin.write(JSON.stringify({ id: 1, op: 'watch', includeInjected }) + '\n');
  return {
    dispose() {
      closed = true;
      try { child.stdin.end(); } catch {}
      const timer = setTimeout(() => child.kill(), 800); timer.unref?.();
    }
  };
}
