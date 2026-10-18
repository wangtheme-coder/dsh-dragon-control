import test from 'node:test';
import assert from 'node:assert/strict';
import { installDesktopExtras } from '../desktop-extra.mjs';

test('window targeting is bound to a fresh per-session window list and verifies identity', async () => {
  let identity = { hwnd: 42, pid: 7, className: 'fixture', title: 'test', appName: 'fixture', visible: true };
  let focuses = 0;
  const defs = new Map([['wait', { execute: async () => ({ screens: [{ windowId: 42 }] }), output: { render: () => [] } }]]);
  installDesktopExtras(defs, { backend: {}, getWindowsOps: async () => ({
    listWindows: () => ({ foregroundHwnd: 42, windows: [identity] }), focusWindow: () => { focuses++; return true; }
  }) });
  const exec = { agent: { id: 'a' }, signal: new AbortController().signal };
  const list = await defs.get('dragon_windows').execute({}, exec);
  const args = { selection_id: list.selection_id, window_id: 42 };
  await assert.rejects(defs.get('dragon_focus_window').execute(args, { ...exec, agent: { id: 'b' } }), /过期/);
  await defs.get('dragon_focus_window').execute(args, exec); assert.equal(focuses, 1);
  identity = { ...identity, pid: 8 };
  await assert.rejects(defs.get('dragon_focus_window').execute(args, exec), /身份已变化/);
  assert.equal(focuses, 1);
});

test('accessibility output redacts password values and maps controls to window coordinates', async () => {
  const defs = new Map([['wait', { execute: async () => ({ screens: [{ windowId: 42 }] }), output: { render: () => [] } }]]);
  installDesktopExtras(defs, { getWindowsOps: async () => ({}),
    backend: { listScreens: async () => [{ windowId: 42, bounds: { x: 100, y: 200, width: 1000, height: 500 } }] },
    probe: async () => ({ truncated: false, elements: [{ id: 1, name: 'Password', password: true, value: 'must never leak', x: 100, y: 200, width: 200, height: 100 }] })
  });
  const result = await defs.get('dragon_a11y').execute({}, { signal: new AbortController().signal });
  assert.equal(result.elements[0].value, undefined);
  assert.deepEqual(result.elements[0].position, [100, 100]);
  assert.doesNotMatch(JSON.stringify(result), /must never leak/);
});
