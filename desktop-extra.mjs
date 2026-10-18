import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
function argsOnly(args, keys) {
  if (Object.keys(args).some(key => !keys.includes(key))) throw Error('未知动作参数。');
}
export function probeAccessibility(windowId, signal) {
  if (!Number.isSafeInteger(windowId) || windowId <= 0) throw Error('无效窗口 ID。');
  return new Promise((resolve, reject) => {
    const child = spawn(fileURLToPath(new URL('./native/A11yProbe.exe', import.meta.url)), [String(windowId)], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal
    });
    const stdout = [], stderr = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error('控件读取超时，请使用截图观察。')); }, 4500);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 512000) { child.kill(); reject(Error('控件结果过大。')); } else stdout.push(data); });
    child.stderr.on('data', data => { if (Buffer.concat(stderr).length < 4096) stderr.push(data); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (signal?.aborted) { reject(signal.reason); return; }
      if (code !== 0) { reject(Error(`控件读取失败：${Buffer.concat(stderr).toString('utf8')}`)); return; }
      try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, ''))); } catch (error) { reject(error); }
    });
  });
}

export function installDesktopExtras(definitions, { backend, getWindowsOps, probe = probeAccessibility, withGuiTurn = (_exec, run) => run() }) {
  const choices = new Map();
  const sessionKey = exec => exec.agent?.id ?? 'local-test';
  const observe = definitions.get('wait');
  const text = value => [{ type: 'text', text: JSON.stringify(value) }];
  definitions.set('dragon_windows', {
    name: 'dragon_windows', description: '列出可见窗口的精确 ID、标题、应用和进程。选择目标后用 focus_window，避免同一应用多个窗口时误选。',
    parameters: objectSchema({}), output: { schema: { type: 'object' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      argsOnly(args, []); exec.signal.throwIfAborted();
      const snapshot = await (await getWindowsOps()).listWindows();
      const windows = snapshot.windows.filter(w => w.visible && !w.cloaked && !w.toolWindow && w.title).slice(0, 150);
      const selectionId = randomUUID();
      choices.set(sessionKey(exec), { id: selectionId, time: Date.now(), windows });
      return { selection_id: selectionId, windows: windows.map(w => ({
        window_id: w.hwnd, pid: w.pid, app: w.appName, title: w.title, minimized: w.iconic, foreground: w.hwnd === snapshot.foregroundHwnd
      })) };
    }
  });
  definitions.set('dragon_focus_window', {
    name: 'dragon_focus_window', description: '激活 windows 返回的一个具体窗口，并返回该窗口的新截图。需要 selection_id 和 window_id。',
    parameters: { ...objectSchema({ selection_id: { type: 'string' }, window_id: { type: 'integer' } }), required: ['selection_id', 'window_id'] },
    output: { schema: { type: 'object' }, render: (args, value) => observe.output.render({}, value) },
    async execute(args, exec) {
      argsOnly(args, ['selection_id', 'window_id']);
      const prior = choices.get(sessionKey(exec));
      if (!prior || prior.id !== args.selection_id || Date.now() - prior.time > 120000) throw Error('窗口列表已过期，请重新 windows。');
      const previous = prior.windows.find(w => w.hwnd === args.window_id);
      if (!previous) throw Error('窗口不在最近一次窗口列表中。');
      const ops = await getWindowsOps();
      const current = (await ops.listWindows()).windows.find(w => w.hwnd === args.window_id);
      if (!current || current.pid !== previous.pid || current.className !== previous.className || current.title !== previous.title) throw Error('目标窗口身份已变化，请重新 windows。');
      return withGuiTurn(exec, async () => {
        exec.signal.throwIfAborted();
        if (!await ops.focusWindow(args.window_id, previous)) throw Error('Windows 未允许激活此窗口，请手动切换后重新 observe。');
        const result = await observe.execute({}, exec);
        if (result.screens?.[0]?.windowId !== args.window_id) throw Error('激活后前台窗口不匹配，请重新观察。');
        return result;
      });
    }
  });
  definitions.set('dragon_a11y', {
    name: 'dragon_a11y', description: '读取前台窗口的按钮、输入框、文本等 UI Automation 控件及编号，同时返回新截图。某些应用只暴露少量控件，此时使用截图。',
    parameters: objectSchema({}),
    output: { schema: { type: 'object' }, render: (_args, value) => [...observe.output.render({}, value), ...text({
      elements: value.elements, truncated: value.truncated,
      note: '控件中心坐标为窗口的 0–1000 比例；password 控件没有读取值。'
    })] },
    async execute(args, exec) {
      argsOnly(args, []);
      const value = await observe.execute({}, exec);
      const screen = (await backend.listScreens(exec.signal))[0];
      if (!screen || screen.windowId !== value.screens?.[0]?.windowId) throw Error('读取前窗口已变化，请重新 a11y。');
      const tree = await probe(screen.windowId, exec.signal);
      const current = (await backend.listScreens(exec.signal))[0];
      if (!current || current.windowId !== screen.windowId || ['x', 'y', 'width', 'height'].some(k => current.bounds[k] !== screen.bounds[k])) throw Error('读取过程中窗口已变化，请重新 a11y。');
      return { ...value, truncated: tree.truncated, elements: tree.elements.map(element => {
        const x = (element.x + element.width / 2 - screen.bounds.x) / screen.bounds.width * 1000;
        const y = (element.y + element.height / 2 - screen.bounds.y) / screen.bounds.height * 1000;
        const position = element.width > 0 && element.height > 0 && x >= 0 && x <= 1000 && y >= 0 && y <= 1000 ? [Math.round(x), Math.round(y)] : undefined;
        return { id: element.id, role: element.role, name: element.name, enabled: element.enabled,
          offscreen: element.offscreen, focused: element.focused, password: element.password,
          ...(element.password ? {} : { value: element.value }), ...(position ? { position } : {}) };
      }) };
    }
  });
  return { clear() { choices.clear(); } };
}
