import { spawn } from 'node:child_process';
import { fault } from './validation.mjs';

// 常驻原生会话：DragonNative.exe / A11yProbe.exe 都支持「一行一个请求」的 stdin 循环，
// 过去每次调用都新起一个进程（.NET 启动约 90–200 ms，一次桌面输入要 8–10 次），
// 这里改成同一个进程内复用，单次开销降到几毫秒。进程仍是独立进程，崩了只影响它自己。
const sessions = new Map();
const FAILURE_TIMEOUT = { DRAGON_NATIVE_TIMEOUT: '原生动作超时，结果未知；请重新观察，不能盲目重复操作。' };

function createSession(path, { timeoutMs, idleMs }) {
  let child = null;
  let buffer = '';
  let nextId = 1;
  let closed = false;
  let idleTimer;
  const pending = new Map();

  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

  function failAll(error) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }

  function shutdown(error, { kill = false } = {}) {
    clearIdle();
    closed = true;
    sessions.delete(path);
    const current = child;
    child = null;
    if (current) {
      try { current.stdin.end(); } catch {}
      // 结果未知时必须真停：不能让一个还在输入的原生进程继续跑下去。
      if (kill) { try { current.kill(); } catch {} }
    }
    failAll(error ?? fault('DRAGON_NATIVE_EXIT', '原生组件已退出。'));
  }

  function settle(message) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (pending.size === 0) {
      clearIdle();
      idleTimer = setTimeout(() => shutdown(), idleMs);
      idleTimer.unref?.();
    }
    if (message.ok) entry.resolve(message.value);
    else entry.reject(fault(/拒绝|rejected/i.test(String(message.error)) ? 'DRAGON_NATIVE_REJECTED' : 'DRAGON_NATIVE_FAILED', String(message.error ?? '原生动作失败')));
  }

  function start() {
    closed = false;
    buffer = '';
    child = spawn(path, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // 常驻辅助进程不拖住宿主退出：父进程结束时 stdin 关闭，原生侧读到 EOF 会自己退出。
    child.unref(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/^\uFEFF/, '').trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (typeof message?.id !== 'number' && typeof message?.id !== 'string') continue;
        settle(message);
      }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', error => shutdown(error));
    child.once('close', code => {
      if (!closed) shutdown(fault('DRAGON_NATIVE_EXIT', `原生组件异常退出（${code}），输入结果未知；请重新观察。`, { exit: code }));
    });
  }

  return {
    close() { shutdown(); },
    request(request, signal) {
      signal?.throwIfAborted();
      clearIdle();
      if (!child) start();
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const entry = pending.get(id);
          pending.delete(id);
          shutdown(fault('DRAGON_NATIVE_TIMEOUT', FAILURE_TIMEOUT.DRAGON_NATIVE_TIMEOUT), { kill: true });
          entry?.reject(fault('DRAGON_NATIVE_TIMEOUT', FAILURE_TIMEOUT.DRAGON_NATIVE_TIMEOUT));
        }, timeoutMs);
        const onAbort = () => {
          const entry = pending.get(id);
          pending.delete(id);
          if (entry) { clearTimeout(entry.timer); entry.reject(signal.reason ?? fault('DRAGON_CANCELLED', '动作已取消。')); }
          shutdown(undefined, { kill: true });
        };
        pending.set(id, {
          resolve: value => { signal?.removeEventListener?.('abort', onAbort); resolve(value); },
          reject: error => { signal?.removeEventListener?.('abort', onAbort); reject(error); },
          timer
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
          child.stdin.write(JSON.stringify({ id, ...request }) + '\n');
        } catch (error) {
          pending.delete(id); clearTimeout(timer); reject(error);
        }
      });
    }
  };
}

/** 向常驻原生进程发一个请求；同路径复用同一个进程，空闲一段时间后自动退出。 */
export function requestNative(path, request, signal, { timeoutMs = 12000, idleMs = 60000 } = {}) {
  signal?.throwIfAborted();
  let session = sessions.get(path);
  if (!session) { session = createSession(path, { timeoutMs, idleMs }); sessions.set(path, session); }
  return session.request(request, signal);
}

/** 关掉全部常驻原生进程（插件卸载、测试清理用）。 */
export function closeNativeSessions() {
  for (const session of [...sessions.values()]) session.close();
  sessions.clear();
}
