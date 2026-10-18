import { randomUUID } from 'node:crypto';
import { boundedJson } from './validation.mjs';

/** 渲染结果归一化：扁平化并丢弃没有 type 的项。DSH 会把工具内容的每一项当成消息块序列化，
 *  一旦写进嵌套数组（[[{type:"text"}]]），下一次请求就会整轮失败并永久污染会话历史。 */
const contentBlocks = blocks => (Array.isArray(blocks) ? blocks.flat(Infinity) : blocks === undefined ? [] : [blocks])
  .filter(block => block !== null && typeof block === 'object' && typeof block.type === 'string');

export const BROWSER_ACTIONS = Object.freeze({
  open: 'browser_open', observe: 'browser_snapshot', a11y: 'browser_a11y',
  content: 'browser_content', click: 'browser_click', type: 'browser_type',
  fill: 'browser_fill', set_value: 'browser_set_value', get_value: 'browser_get_value',
  check: 'browser_check', select: 'browser_select', clear: 'browser_clear',
  scroll: 'browser_scroll', key: 'browser_key', wait: 'browser_wait',
  back: 'browser_back', forward: 'browser_forward', reload: 'browser_refresh',
  tabs: 'browser_list_tabs', switch_tab: 'browser_switch_tab', close_tab: 'browser_close_tab',
  screenshot: 'browser_screenshot', scrape: 'browser_scrape', challenge: 'browser_challenge',
  download: 'browser_download', execute: 'browser_execute', history: 'dragon_history',
  attach: 'dragon_cdp_attach', detach: 'dragon_cdp_detach', chrome: 'dragon_cdp',
  batch: 'dragon_batch'
});
export const DESKTOP_ACTIONS = Object.freeze({
  observe: 'wait', apps: 'list_apps', open_app: 'open_app', open_url: 'open_in_browser',
  open_file: 'open_in_finder', click: 'click', type: 'input_text', scroll: 'scroll',
  key: 'hotkey', drag: 'drag', hold: 'long_press', wait: 'wait',
  windows: 'dragon_windows', focus_window: 'dragon_focus_window', a11y: 'dragon_a11y',
  click_element: 'dragon_click_element', set_element_value: 'dragon_set_element_value',
  select_element: 'dragon_select_element', toggle_element: 'dragon_toggle_element',
  expand_element: 'dragon_expand_element', collapse_element: 'dragon_collapse_element',
  wait_for: 'dragon_wait_for', history: 'dragon_history', batch: 'dragon_batch'
});
/** Steps that are meaningless or recursive inside a batch. */
export const BATCH_EXCLUDED = new Set(['batch', 'help', 'status']);

/** A batch definition shared by both tools; execution is handled by makeControlTool. */
export const batchDefinition = Object.freeze({
  name: 'dragon_batch', dragonPassive: true,
  description: '按顺序执行多个动作，遇错即停；每步只回摘要，最后一步回完整内容。减少往返，桌面像素动作可用 observation_id:"previous" 引用上一步 observe 的观察。',
  parameters: {
    type: 'object', additionalProperties: false, required: ['steps'],
    properties: {
      steps: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object', additionalProperties: false, required: ['action'],
          properties: {
            action: { type: 'string' },
            args: { type: 'object', additionalProperties: true },
            observation_id: { type: 'string', description: '桌面输入可用；首步省略则沿用工具层的 observation_id，后续步省略等同于 "previous"（引用上一步返回的观察号）。' },
            final: { type: 'boolean', description: '为 true 时保留该步完整输出（默认为最后一步）。' }
          }
        }
      }
    }
  }
});

const DESKTOP_INPUT = new Set(['click', 'type', 'scroll', 'key', 'drag', 'hold']);

export function plainObject(value, label = 'args') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error(`${label} 必须是对象。`);
  return value;
}

// Capture definitions in a private registration facade. Never patch the host registry.
// Suppress the upstream eager screenshots and global policy; this plugin observes on demand.
export function definitionContext(ctx, definitions, { browser, get } = {}) {
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'tools') return { register(def) {
        if (definitions.has(def.name)) throw Error(`重复工具 ${def.name}`);
        definitions.set(def.name, def);
        return () => definitions.delete(def.name);
      } };
      if (key === 'systemPrompt') return { section: () => () => {} };
      if (key === 'on') return () => () => {};
      if (key === 'inject') return () => ({ dispose() {} });
      if (key === 'get') return name => {
        if (name === 'sessionProjections') return undefined;
        if (name === 'browser' && browser) return browser;
        return get ? get(name) : target.get(name);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function makeControlTool({ name, actions, definitions, before, after, image, control, status, validate, audit }) {
  return {
    name,
    description: name === 'dragon_browser'
      ? '操作可见的真实浏览器：打开网页、读取内容、DOM 点击、填表、多标签、截图、下载。无需视觉也可用。先 action=help 查看所需动作参数；action=open 的 args={url}；action=observe 查看当前页面。'
      : '操作 Windows 桌面。优先 a11y 和 click_element/set_element_value 等语义动作，无需视觉模型；需要坐标时先 observe，输入带最近 observation_id。也支持窗口选择、条件等待和脱敏 history。先 help 查看具体动作参数。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['help', 'status', ...Object.keys(actions)] },
        args: { type: 'object', additionalProperties: true, description: '动作参数；help 时可传 {action:"click"} 查看一个动作的完整参数。' },
        observation_id: { type: 'string', description: '桌面输入必填；来自最近一次桌面观察。' }
      }, required: ['action']
    },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
      render: (_args, value) => contentBlocks(value.content)
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60000,
    presentCall(request) {
      return { card: 'generic', title: `${name === 'dragon_browser' ? '龙爪网页' : '龙爪桌面'} · ${request.action} · Esc 可急停`, kind: 'execute', rawInput: request };
    },
    async execute(request, exec = {}) {
      plainObject(request, '请求');
      boundedJson(request);
      if (Object.keys(request).some(k => !['action', 'args', 'observation_id'].includes(k))) throw Error('未知请求字段。');
      const { action, observation_id } = request;
      const args = structuredClone(plainObject(request.args ?? {}));
      if (action === 'status') {
        if (Object.keys(args).length) throw Error('status 不接受动作参数。');
        return { content: [{ type: 'text', text: JSON.stringify(await status?.(exec) ?? { ready: true }) }] };
      }
      if (action === 'help') {
        if (Object.keys(args).some(k => k !== 'action')) throw Error('help 只接受 action 参数。');
        if (args.action === undefined) return { content: [{ type: 'text', text: JSON.stringify({
          actions: Object.keys(actions), status: '用 action=status 查询能力、急停和当前执行状态。', usage: '用 action=help, args={action:"所需动作"} 查看具体参数；执行时 action=该动作，args=动作参数。'
        }) }] };
        const selected = args.action === undefined ? Object.keys(actions) : [args.action];
        const help = selected.map(a => {
          if (!Object.hasOwn(actions, a)) throw Error(`未知动作 ${a}`);
          const def = definitions.get(actions[a]);
          if (!def) throw Error(`后端未提供 ${actions[a]}`);
          return { action: a, description: def.description, parameters: def.parameters };
        });
        return { content: [{ type: 'text', text: JSON.stringify(help) }] };
      }
      if (!Object.hasOwn(actions, action)) throw Error(`未知动作 ${String(action)}`);
      const base = { ...exec, name, signal: exec.signal ?? new AbortController().signal };

      /** One dispatched action: validate, authorize, execute, render, audit. */
      const runAction = async (act, actArgs, obsId, effectiveExec, { audited = true } = {}) => {
        if (!Object.hasOwn(actions, act)) throw Error(`未知动作 ${String(act)}`);
        const def = definitions.get(actions[act]);
        if (!def) throw Error(`后端未提供 ${actions[act]}`);
        validate?.(def, actArgs);
        // 分阶段耗时写进审计日志（只有毫秒数，不含参数），供真实会话定位瓶颈。
        const timings = {};
        const stepExec = { ...effectiveExec, dragonAction: act, dragonTimings: timings };
        const execute = async inner => {
          const phase = async (label, run) => { const at = Date.now(); try { return await run(); } finally { timings[label] = Date.now() - at; } };
          inner.signal.throwIfAborted();
          await phase('guard', () => before?.({ action: act, args: actArgs, observation_id: obsId, exec: inner }));
          inner.signal.throwIfAborted();
          const value = await phase('execute', () => def.execute(actArgs, inner));
          inner.signal.throwIfAborted();
          let content = contentBlocks(await phase('render', () => def.output.render(actArgs, value)));
          if (image && value.dataUrl) content = [...content, await phase('image', () => image(value.dataUrl))];
          inner.signal.throwIfAborted();
          const extra = await phase('after', () => after?.({ action: act, args: actArgs, value, exec: inner }));
          if (extra) content = [...content, { type: 'text', text: extra }];
          return { content };
        };
        const run = () => control && !def.dragonPassive ? control.run(stepExec, execute) : execute(stepExec);
        return audited && audit && !def.dragonPassive ? audit.run({ tool: name, action: act }, stepExec, run) : run();
      };

      const summarize = content => content.map(item => item?.type === 'image' ? '[image]'
        : typeof item?.text === 'string' ? item.text.slice(0, 600) : '').filter(Boolean).join('\n');

      const runBatch = async () => {
        const steps = args.steps;
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) throw Error('batch 需要 1–50 步的 steps 数组。');
        validate?.(batchDefinition, args);
        for (const [index, step] of steps.entries()) {
          plainObject(step, `batch 第 ${index + 1} 步`);
          if (typeof step.action !== 'string' || !Object.hasOwn(actions, step.action) || BATCH_EXCLUDED.has(step.action)) throw Error(`batch 第 ${index + 1} 步动作无效：${String(step.action)}`);
          if (step.args !== undefined) plainObject(step.args, `batch 第 ${index + 1} 步 args`);
          const def = definitions.get(actions[step.action]);
          if (!def) throw Error(`后端未提供 ${actions[step.action]}`);
          validate?.(def, step.args ?? {});
        }
        const results = [];
        let observation = null;
        const runAll = async () => {
          for (const [index, step] of steps.entries()) {
            base.signal.throwIfAborted();
            const result = { step: index + 1, action: step.action };
            const stepArgs = step.args ?? {};
            // 首步省略观察号时沿用工具层那一个；后续步省略等同于 "previous"。
            const stepObservation = step.observation_id === 'previous' ? observation
              : (step.observation_id ?? (index === 0 ? observation_id : observation));
            try {
              const outcome = await runAction(step.action, stepArgs, stepObservation, base);
              const text = summarize(outcome.content);
              if (text) result.text = text;
              if (index === steps.length - 1 || step.final === true) result.content = outcome.content;
              const found = /observation_id=([0-9a-f-]{8,})/.exec(outcome.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
              if (found) observation = found[1];
              result.ok = true;
            } catch (error) {
              result.ok = false;
              result.code = error?.code ?? 'DRAGON_BATCH_STEP_FAILED';
              result.message = error?.message ?? String(error);
              results.push(result);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: false, failedAt: index + 1, steps: results }) }] };
            }
            results.push(result);
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: results }) }] };
        };
        return runAll();
      };

      if (action === 'batch') return runBatch();
      return runAction(action, args, observation_id, base);
    }
  };
}

export function desktopObservationGuard(backend, { now = Date.now, ttl = 120000 } = {}) {
  const coded = (code, message) => { const error = Error(message); error.code = code; return error; };
  const records = new Map();
  // 本轮动作的目标窗口：before 里写入，after 里核对前台有没有被抢走。不是观察号，所以不参与过期判断。
  const targets = new Map();
  const key = exec => exec.agent?.id ?? 'local-test';
  return {
    clear() { records.clear(); targets.clear(); },
    async before({ action, observation_id, exec }) {
      if (!DESKTOP_INPUT.has(action)) return;
      const prior = records.get(key(exec));
      if (!prior || observation_id !== prior.id || now() - prior.time > ttl) throw coded('DRAGON_OBSERVATION_STALE', '桌面观察已过期或不属于此会话，请重新 observe。');
      const screens = await backend.listScreens(exec.signal);
      const current = screens[0];
      if (!current || current.windowId !== prior.windowId || current.bounds.width !== prior.width || current.bounds.height !== prior.height ||
          current.bounds.x !== prior.x || current.bounds.y !== prior.y || (prior.identity &&
          ['pid', 'path', 'created', 'className', 'dpi'].some(k => current.dragonIdentity?.[k] !== prior.identity[k]))) {
        records.delete(key(exec));
        throw coded('DRAGON_WINDOW_CHANGED', '桌面目标窗口或位置已变化，请重新 observe。');
      }
      targets.set(key(exec), { windowId: prior.windowId, title: current.title || current.app || '' });
      // Consume before input. A failed or interrupted input must never be replayed blindly.
      records.delete(key(exec));
    },
    async after({ action, value, exec }) {
      const s = value.screens?.[0];
      if (!s) { records.delete(key(exec)); targets.delete(key(exec)); return '当前没有可操作窗口。'; }
      const target = targets.get(key(exec));
      if (target && DESKTOP_INPUT.has(action) && s.windowId !== target.windowId) {
        // 前台被别的东西抢走了：这次输入可能已经落到别的窗口，绝不能再把抢来的窗口当新目标。
        records.delete(key(exec)); targets.delete(key(exec));
        const front = await Promise.resolve().then(() => backend.listScreens(exec.signal)).catch(() => null);
        const stolen = front?.[0]?.title || front?.[0]?.app || s.title || s.app || String(s.windowId);
        const error = Error(`输入发出后前台变成了「${stolen}」，这次 ${action} 可能没有落到目标窗口；已停止后续步骤，请重新 observe。`);
        error.code = 'DRAGON_FOREGROUND_CHANGED';
        throw error;
      }
      targets.delete(key(exec));
      const current = (await backend.listScreens(exec.signal))[0];
      if (!current || current.windowId !== s.windowId || current.bounds.width !== s.logicalWidth || current.bounds.height !== s.logicalHeight) {
        records.delete(key(exec)); return '截图后窗口已变化；请重新 observe。';
      }
      const id = randomUUID();
      if (exec.dragonCaptured && (exec.dragonCaptured.identity.windowId !== current.windowId ||
          ['x', 'y', 'width', 'height'].some(k => exec.dragonCaptured.bounds[k] !== current.bounds[k]) ||
          ['pid', 'path', 'created', 'className', 'dpi'].some(k => exec.dragonCaptured.identity[k] !== current.dragonIdentity?.[k]))) {
        records.delete(key(exec)); return '截图后进程或位置已变化；请重新 observe。';
      }
      records.set(key(exec), { id, time: now(), windowId: s.windowId, width: s.logicalWidth, height: s.logicalHeight,
        x: current.bounds.x, y: current.bounds.y, identity: current.dragonIdentity });
      return `observation_id=${id}\n下一次桌面输入必须引用此 ID；每次动作后都会给出新 ID（截图按需，需要画面时用 observe）。`;
    }
  };
}
