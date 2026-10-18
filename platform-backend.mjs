import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runDragonNative } from './dragon-native.mjs';
import { fault } from './validation.mjs';

const BUTTONS = new Set(['left', 'right', 'middle']);
const MODIFIERS = new Set(['ctrl', 'control', 'shift', 'alt', 'win', 'cmd']);

function normalize(position) {
  if (!Array.isArray(position) || position.length !== 2 || !position.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw fault('DRAGON_INVALID_ARGS', 'position 必须是 [x, y] 两个数字（窗口的 0–1000 比例）。');
  }
  if (position.some(value => value < 0 || value > 1000)) throw fault('DRAGON_INVALID_ARGS', 'position 必须在 0–1000 之内。');
  return position;
}

/**
 * 桌面后端：接口形状与过去的 orb 平台后端保持一致（listScreens / capture / click / typeText /
 * scroll / hotkey / longPress / drag / withGuiTurn），这样上层的权限、观察号、审计完全不用改。
 * 所有真实 Win32 调用都在 DragonNative.exe 里，宿主只做参数换算。
 */
export function createPlatformBackend ({ native = runDragonNative, postActionWaitMs = 350 } = {}) {
  const queue = [];
  let busy = false;

  async function serialized (operation) {
    if (busy) {
      const gate = new Promise(resolve => queue.push(resolve));
      await gate;
    }
    busy = true;
    try { return await operation(); }
    finally {
      const next = queue.shift();
      if (next) next(); else busy = false;
    }
  }

  function absolute (screen, position) {
    const [x, y] = normalize(position);
    const bounds = screen?.bounds;
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) throw fault('DRAGON_WINDOW_GONE', '目标窗口尺寸无效，请重新观察。');
    return { x: Math.round(bounds.x + (x / 1000) * bounds.width), y: Math.round(bounds.y + (y / 1000) * bounds.height) };
  }

  function requireWindow (screen) {
    if (!screen || !screen.windowId) throw fault('DRAGON_WINDOW_GONE', '当前没有可操作窗口。');
    return screen.windowId;
  }

  async function listScreens (signal) {
    signal?.throwIfAborted();
    const front = await native({ op: 'foreground' }, signal);
    if (!front?.hwnd) return [];
    const bounds = front.frame;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return [];
    return [{
      windowId: front.hwnd, bounds: { ...bounds }, logicalWidth: bounds.width, logicalHeight: bounds.height,
      title: front.title ?? '', app: front.app ?? '', className: front.className ?? '', pid: front.pid
    }];
  }

  async function capture (screen, signal) {
    requireWindow(screen);
    const path = join(tmpdir(), `dragon-capture-${randomUUID()}.png`);
    try {
      const result = await native({ op: 'capture', hwnd: screen.windowId, path, mode: 'window' }, signal);
      const data = await readFile(result.path);
      return { dataUrl: `data:image/png;base64,${data.toString('base64')}`, width: result.width, height: result.height };
    } finally { await unlink(path).catch(() => {}); }
  }

  async function settle (signal) { await delay(postActionWaitMs, undefined, { signal }); }

  async function click (input, signal) {
    const point = absolute(input.screen, input.position);
    const button = input.button ?? 'left';
    if (!BUTTONS.has(button)) throw fault('DRAGON_INVALID_ARGS', 'button 只能是 left / right / middle。');
    const count = input.count ?? 1;
    if (![1, 2, 3].includes(count)) throw fault('DRAGON_INVALID_ARGS', 'count 只能是 1、2 或 3。');
    const modifiers = (input.modifiers ?? []).map(name => String(name).toLowerCase());
    for (const name of modifiers) if (!MODIFIERS.has(name)) throw fault('DRAGON_INVALID_ARGS', `不支持的修饰键：${name}`);
    return serialized(async () => {
      signal?.throwIfAborted();
      for (const name of modifiers) await native({ op: 'keydown', key: name === 'cmd' ? 'win' : name }, signal);
      try { await native({ op: 'click', x: point.x, y: point.y, button, count }, signal); }
      finally { for (const name of modifiers.reverse()) await native({ op: 'keyup', key: name === 'cmd' ? 'win' : name }, signal).catch(() => {}); }
      await settle(signal);
      return point;
    });
  }

  async function typeText (input, signal) {
    const point = absolute(input.screen, input.position);
    const actions = Array.isArray(input.actions) && input.actions.length ? input.actions
      : [{ type: 'type', text: input.text ?? '' }];
    return serialized(async () => {
      signal?.throwIfAborted();
      await native({ op: 'click', x: point.x, y: point.y, button: 'left', count: 1 }, signal);
      await delay(60, undefined, { signal });
      // 点下去到开始打字之间只有几十毫秒，但弹窗正是在这个缝里抢前台：前台不对就别把文字发出去。
      const front = await native({ op: 'foreground' }, signal);
      if (front?.hwnd && front.hwnd !== input.screen.windowId) {
        throw fault('DRAGON_FOREGROUND_CHANGED',
          `点击后前台变成了「${front.title || front.app || front.hwnd}」，没有输入文字；请重新 observe。`);
      }
      if (input.replace) {
        await native({ op: 'key', keys: ['CTRL', 'A'] }, signal);
        await delay(30, undefined, { signal });
      }
      for (const action of actions) {
        signal?.throwIfAborted();
        if (action.type === 'type') {
          if (action.text) await native({ op: 'type', text: action.text }, signal);
        } else if (action.type === 'key') await native({ op: 'key', keys: [].concat(action.keys) }, signal);
      }
      if (input.submit) await native({ op: 'key', keys: ['ENTER'] }, signal);
      await settle(signal);
      return point;
    });
  }

  async function scroll (input, signal) {
    const point = absolute(input.screen, input.position);
    const direction = input.direction ?? 'down';
    if (!['up', 'down'].includes(direction)) throw fault('DRAGON_INVALID_ARGS', 'direction 只能是 up 或 down。');
    const level = Math.round(input.scroll_level ?? input.level ?? 3);
    if (!(level >= 1 && level <= 10)) throw fault('DRAGON_INVALID_ARGS', 'scroll_level 必须是 1–10。');
    const delta = (direction === 'up' ? 1 : -1) * level * 120;
    return serialized(async () => {
      signal?.throwIfAborted();
      await native({ op: 'scroll', x: point.x, y: point.y, delta }, signal);
      await settle(signal);
      return delta;
    });
  }

  async function hotkey (input, signal) {
    const keys = [].concat(input.keys ?? input.key ?? []);
    if (!keys.length) throw fault('DRAGON_INVALID_ARGS', 'key 至少需要一个键。');
    return serialized(async () => {
      signal?.throwIfAborted();
      await native({ op: 'key', keys }, signal);
      await settle(signal);
      return keys;
    });
  }

  async function longPress (input, signal) {
    const point = absolute(input.screen, input.position);
    const seconds = input.duration_seconds ?? input.durationSeconds ?? 3;
    if (!(seconds >= 0.2 && seconds <= 10)) throw fault('DRAGON_INVALID_ARGS', 'duration_seconds 必须在 0.2–10 之间。');
    return serialized(async () => {
      signal?.throwIfAborted();
      await native({ op: 'hold', x: point.x, y: point.y, ms: Math.round(seconds * 1000) }, signal);
      await settle(signal);
      return point;
    });
  }

  async function drag (input, signal) {
    const from = absolute(input.screen, input.start_position ?? input.startPosition);
    const to = absolute(input.screen, input.end_position ?? input.endPosition);
    return serialized(async () => {
      signal?.throwIfAborted();
      await native({ op: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, signal);
      await settle(signal);
      return { from, to };
    });
  }

  async function inspectForeground (signal) { return (await listScreens(signal))[0] ?? null; }

  return {
    platform: 'windows-x64', listScreens, capture, click, typeText, scroll, hotkey, longPress, drag, inspectForeground,
    // 独占执行权由上层 gui-lock 负责，这里不额外加锁，避免和急停/取消互相等待。
    async withGuiTurn (run) { return run(); }
  };
}
