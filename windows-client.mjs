import { runDragonNative } from './dragon-native.mjs';

// 窗口枚举与聚焦过去借 dsh-orb 的 windows-native（koffi 直连 user32），
// 现在改由 DragonNative.exe 在独立进程里完成，插件不再依赖任何其它插件。
function project(window) {
  return {
    hwnd: window.hwnd, pid: window.pid, appName: window.app, title: window.title,
    className: window.className, visible: window.visible, iconic: window.minimized,
    cloaked: window.cloaked, toolWindow: window.toolWindow, frame: window.frame
  };
}

export async function createWindowsClient () {
  let disposed = false;
  function guard () { if (disposed) throw Error('窗口服务已关闭。'); }
  return {
    async listWindows () {
      guard();
      const { windows } = await runDragonNative({ op: 'windows' });
      const list = windows.map(project);
      return { windows: list, foregroundHwnd: windows.find(window => window.foreground)?.hwnd ?? 0 };
    },
    async focusWindow (windowId, identity) {
      guard();
      const { windows } = await runDragonNative({ op: 'windows' });
      const current = windows.find(window => window.hwnd === windowId);
      if (!current) throw Error('目标窗口已关闭，请重新 windows。');
      if (identity && (current.pid !== identity.pid || current.className !== identity.className || current.title !== identity.title)) {
        throw Error('激活前窗口身份已变化，请重新 windows。');
      }
      const result = await runDragonNative({ op: 'focus', hwnd: windowId });
      return Boolean(result.foreground);
    },
    async dispose () { disposed = true; }
  };
}
