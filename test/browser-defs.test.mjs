import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_ACTIONS, makeControlTool } from '../control.mjs';
import { installBrowserDefinitions } from '../browser-defs.mjs';

const snapshot = { url: 'https://example.com/', title: '示例', count: 2, truncated: false, elements: [
  { id: 1, role: 'textbox', tag: 'input', name: '用户名', type: 'text', selector: '#user' },
  { id: 2, role: 'button', tag: 'button', name: '提交', selector: 'form > button' }
] };
const browser = {
  open: async () => snapshot,
  snapshot: async () => snapshot,
  content: async () => ({ format: 'markdown', content: '# 标题\n\n正文', truncated: false }),
  a11y: async () => ({ url: snapshot.url, title: snapshot.title, count: 1, nodes: [{ role: 'button', name: '提交', depth: 2 }], truncated: false }),
  screenshot: async () => ({ dataUrl: 'data:image/png;base64,AAAA', bytes: 3, format: 'png' })
};

const definitions = new Map();
installBrowserDefinitions(definitions, { browser, downloadsDir: 'C:\\tmp\\downloads' });

const webActions = Object.entries(BROWSER_ACTIONS).filter(([, name]) => !['dragon_history', 'dragon_batch', 'dragon_cdp_attach', 'dragon_cdp_detach', 'dragon_cdp'].includes(name));

test('every browser action maps to a definition', () => {
  for (const [action, name] of webActions) assert.ok(definitions.has(name), `缺少定义 ${action} -> ${name}`);
  assert.equal(definitions.size, webActions.length);
});

test('definitions expose closed JSON schemas and execute through the bridge', async () => {
  for (const definition of definitions.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.execute, 'function');
  }
  const value = await definitions.get('browser_snapshot').execute({}, {});
  assert.equal(value.count, 2);
});

const tool = makeControlTool({
  name: 'dragon_browser', actions: BROWSER_ACTIONS, definitions,
  status: async () => ({ ready: true }), validate: undefined, audit: undefined
});

test('help covers every action and renders snapshots with selectors', async () => {
  const help = await tool.execute({ action: 'help', args: { action: 'observe' } });
  const parsed = JSON.parse(help.content[0].text);
  assert.equal(parsed[0].action, 'observe');
  assert.ok(parsed[0].parameters.properties.maxNodes);

  const result = await tool.execute({ action: 'observe', args: {} });
  const rendered = result.content[0].text;
  assert.match(rendered, /ELEMENTS: 2/);
  assert.match(rendered, /selector=#user/);
  assert.match(rendered, /selector=form > button/);
});

test('a11y and screenshot render without leaking data URLs into text', async () => {
  const a11y = await tool.execute({ action: 'a11y', args: {} });
  assert.match(a11y.content[0].text, /NODES: 1/);
  const shot = await tool.execute({ action: 'screenshot', args: {} });
  assert.doesNotMatch(shot.content[0].text, /data:image/);
  assert.match(shot.content[0].text, /"bytes":3/);
});
