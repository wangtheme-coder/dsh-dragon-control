import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fault } from './validation.mjs';

// 龙爪自立原生层：所有 Win32 动作都在独立进程 DragonNative.exe 里完成。
// 进程隔离是刻意的：原生代码出问题只会拖垮它自己，不会把 DSH 宿主的堆搞坏。
export const NATIVE_PATH = fileURLToPath(new URL('./native/DragonNative.exe', import.meta.url));

const failures = {
  DRAGON_NATIVE_TIMEOUT: '原生动作超时，结果未知；请重新观察，不能盲目重复操作。',
  DRAGON_NATIVE_EXIT: '原生组件异常退出（输入结果未知）；请重新观察后再决定是否重试。',
  DRAGON_NATIVE_PROTOCOL: '原生组件返回无效结果。',
  DRAGON_NATIVE_REJECTED: '系统拒绝了这个输入（目标窗口权限可能更高）。请用户手动处理；插件不会自动提权。'
};

export function runDragonNative(request, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(NATIVE_PATH, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal });
    const stdout = [], stderr = []; let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(fault('DRAGON_NATIVE_TIMEOUT', failures.DRAGON_NATIVE_TIMEOUT, { op: request.op }));
    }, 12000);
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > 33554432) { child.kill(); finish(fault('DRAGON_RESULT_LIMIT', '原生结果过大。')); return; }
      stdout.push(data);
    });
    let errorBytes = 0;
    child.stderr.on('data', data => { if ((errorBytes += data.length) <= 4096) stderr.push(data); });
    child.stdin.on('error', () => {});
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (signal?.aborted) { finish(signal.reason); return; }
      const text = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (code !== 0 && !text) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(fault('DRAGON_NATIVE_EXIT', `${failures.DRAGON_NATIVE_EXIT}${detail ? `（${detail.slice(0, 300)}）` : ''}`, { exit: code }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(text.split('\n').pop()); }
      catch { finish(fault('DRAGON_NATIVE_PROTOCOL', failures.DRAGON_NATIVE_PROTOCOL)); return; }
      if (!parsed.ok) {
        const message = String(parsed.error ?? '原生动作失败');
        finish(fault(/拒绝/.test(message) ? 'DRAGON_NATIVE_REJECTED' : 'DRAGON_NATIVE_FAILED', message));
        return;
      }
      finish(null, parsed.value);
    });
    child.stdin.end(JSON.stringify({ id: 1, ...request }));
  });
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
