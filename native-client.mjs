import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fault } from './validation.mjs';

const messages = {
  DRAGON_DESKTOP_UNAVAILABLE: '当前不是可操作的普通桌面，可能已锁屏或处于安全桌面；请用户手动处理。',
  DRAGON_WINDOW_ELEVATED: '目标窗口的管理员权限高于插件，无法操作。请用户手动处理；插件不会自动提权。',
  DRAGON_WINDOW_ACCESS_DENIED: 'Windows 拒绝读取目标进程身份或权限，已停止操作。',
  DRAGON_WINDOW_GONE: '目标窗口已关闭，请重新列出窗口。',
  DRAGON_TARGET_CHANGED: '目标进程或窗口身份已变化，请重新观察。',
  DRAGON_ELEMENT_STALE: '控件已变化或消失，请重新 a11y。',
  DRAGON_PATTERN_UNSUPPORTED: '该控件不支持此语义动作；请重新观察后明确选择其他方式。',
  DRAGON_PASSWORD_HANDOFF: '密码控件需要用户自行操作。',
  DRAGON_ELEMENT_UNAVAILABLE: '目标控件不可见或未启用。',
  DRAGON_UIA_UNAVAILABLE: '应用未提供可用的 UI Automation 控件，请使用截图或由用户操作。'
};
export function runNative(request, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(fileURLToPath(new URL('./native/A11yProbe.exe', import.meta.url)), [], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal
    });
    const stdout = [], stderr = []; let bytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(fault('DRAGON_NATIVE_TIMEOUT', '原生调用超时，结果未知；请重新观察，不能盲目重复操作。')); }, 6000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 1048576) { child.kill(); finish(fault('DRAGON_RESULT_LIMIT', '控件结果过大。')); } else stdout.push(data); });
    let errorBytes = 0;
    child.stderr.on('data', data => { if ((errorBytes += data.length) <= 4096) stderr.push(data); });
    child.stdin.on('error', () => {});
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (signal?.aborted) return finish(signal.reason);
      if (code !== 0) {
        const candidate = Buffer.concat(stderr).toString('utf8').trim();
        const code = /^DRAGON_[A-Z_]+$/.test(candidate) ? candidate : 'DRAGON_UIA_UNAVAILABLE';
        return finish(fault(code, messages[code] ?? `原生动作失败：${code}`));
      }
      try { finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, ''))); }
      catch { finish(fault('DRAGON_NATIVE_PROTOCOL', '原生组件返回无效结果。')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
