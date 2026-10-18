import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runNative } from './native-client.mjs';
import { fault } from './validation.mjs';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' }, integer = { type: 'integer' };
const content = value => [{ type: 'text', text: JSON.stringify(value) }];
const stateDigest = elements => createHash('sha256').update(JSON.stringify(elements.map(e =>
  [e.runtimeId, e.name, e.role, e.password ? null : e.value, e.enabled, e.selected, e.toggle, e.expanded]))).digest('hex');
export const SEMANTIC_ACTIONS = new Set(['a11y', 'click_element', 'set_element_value', 'select_element', 'toggle_element', 'expand_element', 'collapse_element', 'wait_for']);

export function installSemantic(definitions, { backend, permissions, authorizeWindow, native = runNative, withGuiTurn = (_exec, run) => run() }) {
  const observations = new Map();
  const key = exec => exec.agent?.id ?? 'local';
  async function windowOf(args, exec) {
    const windowId = args.window_id ?? (await backend.listScreens(exec.signal))[0]?.windowId;
    if (!windowId) throw fault('DRAGON_WINDOW_GONE', '没有可观察窗口。');
    return authorizeWindow(exec, windowId, 'read');
  }
  function project(tree, exec) {
    const id = randomUUID(), elements = new Map();
    const rows = tree.elements.map(element => {
      const handle = randomUUID(); elements.set(handle, element);
      return { element_id: handle, id: element.id, role: element.role, name: element.name,
        enabled: element.enabled, offscreen: element.offscreen, password: element.password,
        patterns: element.password ? [] : element.patterns ?? [],
        ...(element.password ? {} : { value: element.value }),
        ...(element.selected == null ? {} : { selected: element.selected }),
        ...(element.toggle == null ? {} : { toggle: element.toggle }),
        ...(element.expanded == null ? {} : { expanded: element.expanded }) };
    });
    observations.set(key(exec), { id, identity: tree.identity, time: Date.now(), elements, digest: stateDigest(tree.elements) });
    return { a11y_id: id, window_id: tree.windowId, pid: tree.identity.pid, dpi: tree.identity.dpi,
      elements: rows, truncated: tree.truncated, semantic: true,
      note: 'element_id 仅对本次 a11y_id 有效；密码值不读取；语义操作不需要截图。' };
  }
  const add = (name, description, parameters, execute) => definitions.set(name, {
    name, description, parameters, output: { schema: { type: 'object' }, render: (_args, value) => content(value) }, execute
  });
  add('dragon_a11y', '读取指定或当前窗口的控件与支持的语义动作，不截图；返回 a11y_id 和不透明 element_id。',
    schema({ window_id: integer }), async (args, exec) => {
      const identity = await windowOf(args, exec);
      return project(await native({ op: 'tree', windowId: identity.windowId, expected: identity }, exec.signal), exec);
    });
  const actions = { click_element: 'invoke', set_element_value: 'set_value', select_element: 'select',
    toggle_element: 'toggle', expand_element: 'expand', collapse_element: 'collapse' };
  for (const [action, op] of Object.entries(actions)) add(`dragon_${action}`,
    '对最近一次 a11y 的精确控件执行语义动作。动作后返回新控件状态；不会自动回退坐标点击。',
    schema({ a11y_id: string, element_id: string, ...(op === 'set_value' ? { value: string } : {}) },
      ['a11y_id', 'element_id', ...(op === 'set_value' ? ['value'] : [])]), async (args, exec) => {
      const prior = observations.get(key(exec));
      if (!prior || prior.id !== args.a11y_id || Date.now() - prior.time > 120000) throw fault('DRAGON_ELEMENT_STALE', '控件观察已过期或不属于本会话，请重新 a11y。');
      const element = prior.elements.get(args.element_id);
      if (!element || element.password || !element.enabled || element.offscreen || !element.patterns?.includes(op)) {
        throw fault('DRAGON_PATTERN_UNSUPPORTED', '控件不属于本次观察，或不支持此动作；请重新 a11y。');
      }
      // Consume before any approval or input so a rejected or unknown result cannot replay.
      observations.delete(key(exec));
      const identity = await authorizeWindow(exec, prior.identity.windowId, 'control', prior.identity);
      if (op === 'invoke' || /删除|发送|付款|支付|提交|授权|同意|购买|delete|send|pay|submit|allow|agree|purchase/i.test(element.name)) {
        await permissions.confirm(exec, `在 ${identity.path} 的控件“${element.name.slice(0, 100)}”执行 ${op}`,
          { action, identity, target: args.element_id, a11y: args.a11y_id });
      }
      return withGuiTurn(exec, async () => {
        exec.signal.throwIfAborted();
        const result = await native({ op, windowId: identity.windowId, expected: identity,
          element: { runtimeId: element.runtimeId, name: element.name, role: element.role, automationId: element.automationId },
          ...(op === 'set_value' ? { value: args.value } : {}) }, exec.signal);
        const changed = stateDigest(result.elements) !== prior.digest;
        const state = project(result, exec);
        return { ...state, actionAccepted: result.actionAccepted, observedStateChanged: changed,
          ...(result.windowClosed ? { windowClosed: true } : {}),
          ...(op === 'set_value' ? { valueVerified: result.elements.some(e => e.runtimeId === element.runtimeId && e.value === args.value) } : {}),
          effectNote: '状态变化不能单独证明外部任务完成；请核对所需结果。' };
      });
    });
  add('dragon_wait_for', '等待当前或指定窗口的控件按精确名称/角色出现或消失；不执行输入，超时和 Esc 均可取消。',
    schema({ window_id: integer, name: string, role: string, state: { type: 'string', enum: ['present', 'absent'] }, timeout_ms: integer }),
    async (args, exec) => {
      if (!args.name && !args.role) throw fault('DRAGON_INVALID_ARGS', 'wait_for 至少需要 name 或 role。');
      const timeout = args.timeout_ms ?? 10000;
      if (timeout < 0 || timeout > 30000) throw fault('DRAGON_INVALID_ARGS', 'timeout_ms 必须为 0–30000。');
      const identity = await windowOf(args, exec), start = Date.now();
      while (true) {
        exec.signal.throwIfAborted();
        const tree = await native({ op: 'tree', windowId: identity.windowId, expected: identity }, exec.signal);
        const present = tree.elements.some(e => (!args.name || e.name === args.name) && (!args.role || e.role === args.role) && !e.offscreen);
        if (present === (args.state !== 'absent')) return { matched: true, waitedMs: Date.now() - start, ...project(tree, exec) };
        if (Date.now() - start >= timeout) throw fault('DRAGON_WAIT_TIMEOUT', '等待条件未在时限内满足。');
        await delay(Math.min(250, timeout - (Date.now() - start)), undefined, { signal: exec.signal });
      }
    });
  return { clear() { observations.clear(); } };
}
