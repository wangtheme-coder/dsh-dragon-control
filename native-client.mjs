import { fileURLToPath } from 'node:url';
import { requestNative } from './native-session.mjs';

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
export const PROBE_PATH = fileURLToPath(new URL('./native/A11yProbe.exe', import.meta.url));

/**
 * UI Automation 探针：常驻 A11yProbe.exe，逐行收发请求。
 * 以前每次 inspect/tree 都新起进程（.NET + UIA 初始化约 100–200 ms），现在同进程复用。
 */
export function runNative(request, signal) {
  signal?.throwIfAborted();
  return requestNative(PROBE_PATH, request, signal, { timeoutMs: 6000 }).catch(error => {
    const code = /^DRAGON_[A-Z_]+$/.test(error?.message ?? '') ? error.message : null;
    if (!code) throw error;
    throw Object.assign(new Error(messages[code] ?? `原生动作失败：${code}`), { code });
  });
}
