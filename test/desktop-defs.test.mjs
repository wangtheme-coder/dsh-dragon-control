import test from 'node:test';
import assert from 'node:assert/strict';
import { installComputerUse } from '../desktop-defs.mjs';
import { makeControlTool } from '../control.mjs';

/** 渲染结果必须是「一维的消息块数组」：DSH 会把每一项当成一条消息块写进会话历史，
 *  一旦出现嵌套数组，下一次请求就会整轮失败（UNSUPPORTED_CONTENT）并永久污染该会话。 */
function flatBlocks (label, value) {
  assert.ok(Array.isArray(value), `${label} 必须返回数组`);
  for (const block of value) {
    assert.ok(!Array.isArray(block), `${label} 渲染出了嵌套数组`);
    assert.equal(typeof block?.type, 'string', `${label} 的块缺少 type`);
  }
}

const screenshot = { windowId: 1, app: 'fixture', title: 'fixture', bounds: { x: 0, y: 0, width: 800, height: 600 } };
const backend = {
  listScreens: async () => [screenshot],
  capture: async () => ({ dataUrl: 'data:image/png;base64,AAAA' }),
  click: async () => ({ x: 1, y: 1 }),
  typeText: async () => true,
  scroll: async () => true,
  hotkey: async () => true,
  drag: async () => true,
  longPress: async () => true
};

test('desktop 定义的真实执行结果都渲染成一维消息块', async () => {
  const definitions = new Map();
  installComputerUse(definitions, backend, { postActionWaitMs: 0, listWindows: async () => ({ windows: [{ appName: 'fixture', pid: 1 }] }) });
  const exec = { signal: new AbortController().signal };

  const waited = await definitions.get('wait').execute({}, exec);
  flatBlocks('wait', definitions.get('wait').output.render({}, waited));

  const listed = await definitions.get('list_apps').execute({}, exec);
  flatBlocks('list_apps', definitions.get('list_apps').output.render({}, listed));
});

test('desktop 定义的每个 render 都不会产生嵌套数组', () => {
  const definitions = new Map();
  installComputerUse(definitions, backend, { postActionWaitMs: 0, listWindows: async () => ({ windows: [{ appName: 'fixture', pid: 1 }] }) });
  const sample = {
    text: 'headline', screens: [screenshot], dataUrl: 'data:image/png;base64,AAAA',
    apps: [{ app: 'fixture', pid: 1 }], clicked: {}, elements: [], truncated: false
  };
  for (const definition of definitions.values()) {
    flatBlocks(definition.name, definition.output.render({}, sample));
  }
});

test('dispatcher 与工具级 render 会拆掉嵌套并丢弃非法块', async () => {
  const definition = {
    description: 'nested', parameters: { type: 'object' },
    execute: async () => ({}),
    output: { render: () => [[{ type: 'text', text: 'nested' }], null, { text: '缺少 type' }] }
  };
  const tool = makeControlTool({ name: 'dragon_desktop', actions: { observe: 'nested' }, definitions: new Map([['nested', definition]]) });
  const result = await tool.execute({ action: 'observe' }, { signal: new AbortController().signal });
  assert.deepEqual(result.content, [{ type: 'text', text: 'nested' }]);
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: 'nested' }]);
});
