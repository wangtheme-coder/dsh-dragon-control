import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fault } from './validation.mjs';

const screenIndex = { type: 'integer', enum: [0], description: '0 表示当前前台窗口的截图（龙爪只提供这一块屏幕）。' };
const position = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1000 },
  description: '[x, y]，截图内的 0–1000 比例，不是像素坐标。' };
const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
const appLine = screen => `<frontmost_app>${screen?.app ?? ''}</frontmost_app>\n<frontmost_window>${screen?.title ?? ''}</frontmost_window>`;
const constantLine = '<screen_index>0</screen_index>\n<coordinate_space>0-1000</coordinate_space>';
const round = value => Math.round(value * 10) / 10;

function assertScreenIndex (args) {
  if (args.screen_index !== undefined && args.screen_index !== 0) throw fault('DRAGON_INVALID_ARGS', 'screen_index 只能是 0。');
}

function launch (command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/** 桌面基础动作定义：接口名与参数保持和过去一致，实现全部走 DragonNative + 自带后端。 */
export function installComputerUse (definitions, backend, { postActionWaitMs = 350, listWindows, shots = 'light' } = {}) {
  const wantShots = () => shots === 'full';

  /** 看一眼前台窗口：capture=false 只取窗口信息（约 0.3 秒），true 才真正抓图（约 2–4 秒）。 */
  async function look (exec, capture) {
    const [screen] = await backend.listScreens(exec.signal);
    if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
    if (!capture) return { screen, value: { screens: [{ ...screen }] } };
    const image = await backend.capture(screen, exec.signal);
    return { screen, value: { screens: [{ ...screen }], dataUrl: image.dataUrl } };
  }

  async function shoot (exec) { return look(exec, true); }

  /**
   * 动作后默认只补窗口信息（light / 按需截图）：观察号继续有效，但不再为每一次点击按键
   * 都抓一张 2560×1440 的图。想要画面时显式 observe（或 wait/apps），那里始终截图。
   */
  async function after (exec, headline, { capture = wantShots() } = {}) {
    await delay(postActionWaitMs, undefined, { signal: exec.signal });
    let screen;
    let dataUrl;
    try {
      const shot = await look(exec, capture);
      screen = shot.screen; dataUrl = shot.value.dataUrl;
    } catch { /* 动作本身成功时，截图失败不推翻结果 */ }
    return {
      ...(screen ? { screens: [{ ...screen }] } : {}),
      ...(dataUrl ? { dataUrl } : {}),
      text: `${headline}\n${appLine(screen)}\n${constantLine}`
    };
  }

  const add = (name, description, parameters, execute, render) => definitions.set(name, {
    name, description,
    parameters: { type: 'object', properties: parameters, additionalProperties: false },
    output: { schema: { type: 'object' }, render: render ?? ((args, value) => text(value.screens ? value.text : value)) },
    execute
  });

  add('wait', '等 1 秒后重新截取前台窗口，并返回新的观察号。用于页面刷新、加载中或控件还没出现；不会移动鼠标。',
    {}, async (args, exec) => {
      if (Object.keys(args).length) throw fault('DRAGON_INVALID_ARGS', 'observe 不接受动作参数。');
      await delay(1000, undefined, { signal: exec.signal });
      const shot = await shoot(exec);
      return { ...shot.value, text: `Waited 1s. Coordinates remain 0–1000.\n${appLine(shot.screen)}\n${constantLine}` };
    }, (args, value) => text(value.text));

  add('list_apps', '列出正在运行的可见应用（按窗口归并），并返回当前前台窗口截图。',
    {}, async (args, exec) => {
      if (Object.keys(args).length) throw fault('DRAGON_INVALID_ARGS', 'apps 不接受动作参数。');
      if (!listWindows) throw fault('DRAGON_NATIVE_FAILED', '窗口枚举服务不可用。');
      const { windows } = await listWindows();
      const seen = new Map();
      for (const window of windows) {
        if (!seen.has(window.appName)) seen.set(window.appName, { app: window.appName, pid: window.pid, windows: 0 });
        seen.get(window.appName).windows += 1;
      }
      const shot = await shoot(exec);
      return { ...shot.value, apps: [...seen.values()], text: shot.value.text };
    }, (args, value) => [...text(JSON.stringify({ apps: value.apps })), ...text(value.text)]);

  add('open_app', '按名称启动或激活一个本地应用，然后返回新的观察号（默认不截图；需要画面时用 observe）。name 可以是可执行文件名（如 notepad）。',
    { name: { type: 'string', description: '应用名或可执行文件，例如 notepad、calc、mspaint。' } },
    async (args, exec) => {
      if (!args.name) throw fault('DRAGON_INVALID_ARGS', 'open_app 需要 name。');
      launch('cmd.exe', ['/c', 'start', '', String(args.name)]);
      const value = await after(exec, `Opened app ${args.name}.`);
      return value;
    }, (args, value) => text(value.text));

  add('open_in_browser', '用默认浏览器打开网址（或只打开浏览器），然后返回新的观察号（默认不截图；需要画面时用 observe）。url 必须是 http(s)。',
    { url: { type: 'string', description: '要打开的 http(s) 网址；省略则只打开浏览器。' } },
    async (args, exec) => {
      if (args.url !== undefined) {
        let url;
        try { url = new URL(String(args.url)); } catch { throw fault('DRAGON_INVALID_ARGS', 'url 不是合法网址。'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw fault('DRAGON_INVALID_ARGS', '只允许 http(s) 网址。');
        launch('cmd.exe', ['/c', 'start', '', url.href]);
      } else launch('cmd.exe', ['/c', 'start', '', 'about:blank']);
      return after(exec, args.url ? `Opened ${args.url}.` : 'Opened the default browser.');
    }, (args, value) => text(value.text));

  add('open_in_finder', '在资源管理器里打开文件/文件夹，或只选中某个文件（reveal_only），然后返回新的观察号（默认不截图；需要画面时用 observe）。',
    { path: { type: 'string', description: '绝对路径；省略则打开桌面。' }, reveal_only: { type: 'boolean', description: 'true 时只在资源管理器里选中该文件。' } },
    async (args, exec) => {
      const target = args.path === undefined || args.path === '' ? undefined : String(args.path);
      if (target === undefined) launch('explorer.exe', []);
      else if (args.reveal_only) launch('explorer.exe', ['/select,' + target]);
      else launch('explorer.exe', [target]);
      return after(exec, target ? `Opened ${target}.` : 'Opened the Desktop.');
    }, (args, value) => text(value.text));

  add('click', '在 0–1000 坐标点击前台窗口，然后返回新的观察号（默认不截图；需要画面时用 observe）。left/right 按钮，count=2 是双击。',
    { screen_index: screenIndex, position, button: { type: 'string', enum: ['left', 'right'], description: '鼠标键，默认 left。' },
      count: { type: 'integer', enum: [1, 2, 3], description: '点击次数，默认 1；2 表示双击。' },
      modifiers: { type: 'array', items: { type: 'string' }, description: '点击期间按住的修饰键，如 ["ctrl"]、["shift"]。' } },
    async (args, exec) => {
      assertScreenIndex(args);
      const [screen] = await backend.listScreens(exec.signal);
      if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
      const point = await backend.click({ screen, position: args.position, button: args.button ?? 'left', count: args.count ?? 1, modifiers: args.modifiers }, exec.signal);
      const headline = `Clicked screen 0 at [${round(args.position[0] / 1000)}, ${round(args.position[1] / 1000)}] (${args.button ?? 'left'}, count ${args.count ?? 1}). Coordinates remain 0–1000.`;
      const value = await after(exec, headline);
      return { ...value, clicked: point };
    }, (args, value) => text(value.text));

  add('input_text', '先点击 0–1000 坐标聚焦输入框，再输入文本（可先全选替换、可回车提交），然后返回新的观察号（默认不截图；需要画面时用 observe）。',
    { screen_index: screenIndex, position, text: { type: 'string', description: '要输入的文本。' },
      replace: { type: 'boolean', description: 'true 时先全选再输入。' }, submit: { type: 'boolean', description: 'true 时输入后按 Enter。' } },
    async (args, exec) => {
      assertScreenIndex(args);
      const [screen] = await backend.listScreens(exec.signal);
      if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
      await backend.typeText({ screen, position: args.position, text: args.text ?? '', replace: Boolean(args.replace), submit: Boolean(args.submit) }, exec.signal);
      const headline = `Typed on screen 0 at [${round(args.position[0] / 1000)}, ${round(args.position[1] / 1000)}] (replace=${Boolean(args.replace)}, submit=${Boolean(args.submit)}). Coordinates remain 0–1000.`;
      return after(exec, headline);
    }, (args, value) => text(value.text));

  add('scroll', '在 0–1000 坐标滚动前台窗口，然后返回新的观察号（默认不截图；需要画面时用 observe）。scroll_level 是 1–10。',
    { screen_index: screenIndex, position, direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向。' },
      scroll_level: { type: 'integer', minimum: 1, maximum: 10, description: '滚动幅度 1（最小）到 10（最大）。' } },
    async (args, exec) => {
      assertScreenIndex(args);
      const [screen] = await backend.listScreens(exec.signal);
      if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
      await backend.scroll({ screen, position: args.position, direction: args.direction, scroll_level: args.scroll_level }, exec.signal);
      return after(exec, `Scrolled ${args.direction ?? 'down'} at [${round(args.position[0] / 1000)}, ${round(args.position[1] / 1000)}]. Coordinates remain 0–1000.`);
    }, (args, value) => text(value.text));

  add('hotkey', '发送键盘组合键，然后返回新的观察号（默认不截图；需要画面时用 observe）。系统截图快捷键（Win+Shift+S 等）会被拒绝。',
    { key: { type: 'string', description: '组合键，例如 "ctrl+v"、"alt+tab"、"enter"。' },
      keys: { type: 'array', items: { type: 'string' }, description: '按顺序按下的键名数组，例如 ["ctrl","v"]。' } },
    async (args, exec) => {
      const keys = args.keys ?? (args.key ? String(args.key).split(/[+\s]+/) : []);
      if (!keys.length) throw fault('DRAGON_INVALID_ARGS', 'hotkey 需要 key 或 keys。');
      const joined = keys.map(key => String(key).toLowerCase()).join('+');
      if (/^(win|cmd)\+shift\+[345s]$/.test(joined)) throw fault('DRAGON_INVALID_ARGS', '系统截图快捷键不允许由代理触发。');
      await backend.hotkey({ keys: args.keys ?? keys }, exec.signal);
      return after(exec, `Pressed ${keys.join('+')}.`);
    }, (args, value) => text(value.text));

  add('drag', '从起点 0–1000 坐标拖到终点，然后返回新的观察号（默认不截图；需要画面时用 observe）。',
    { start_screen_index: screenIndex, start_position: position, end_screen_index: screenIndex, end_position: position },
    async (args, exec) => {
      assertScreenIndex(args); assertScreenIndex({ screen_index: args.start_screen_index }); assertScreenIndex({ screen_index: args.end_screen_index });
      const [screen] = await backend.listScreens(exec.signal);
      if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
      await backend.drag({ screen, start_position: args.start_position, end_position: args.end_position }, exec.signal);
      return after(exec, `Dragged from [${round(args.start_position[0] / 1000)}, ${round(args.start_position[1] / 1000)}] to [${round(args.end_position[0] / 1000)}, ${round(args.end_position[1] / 1000)}]. Coordinates remain 0–1000.`);
    }, (args, value) => text(value.text));

  add('long_press', '在 0–1000 坐标按住左键一段时间，然后返回新的观察号（默认不截图；需要画面时用 observe）。duration_seconds 默认 3，范围 0.2–10。',
    { screen_index: screenIndex, position, duration_seconds: { type: 'number', minimum: 0.2, maximum: 10, description: '按住时长（秒），默认 3。' } },
    async (args, exec) => {
      assertScreenIndex(args);
      const [screen] = await backend.listScreens(exec.signal);
      if (!screen) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
      const seconds = args.duration_seconds ?? 3;
      await backend.longPress({ screen, position: args.position, duration_seconds: seconds }, exec.signal);
      return after(exec, `Held left button at [${round(args.position[0] / 1000)}, ${round(args.position[1] / 1000)}] for ${seconds}s. Coordinates remain 0–1000.`);
    }, (args, value) => text(value.text));
}
