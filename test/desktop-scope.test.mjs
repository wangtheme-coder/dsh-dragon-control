import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScope } from '../execution.mjs';

const identity = { windowId: 1, pid: 1, path: 'fixture.exe', created: 'one', className: 'fixture', interactiveDesktop: true, accessKnown: true, elevated: false };
test('a window moved during read authorization is rejected before pixel capture', async () => {
  let x = 0, captures = 0;
  const scope = createExecutionScope({ require: async () => { x = 100; } }, { native: async () => identity });
  const desktop = scope.secureDesktop({ listScreens: async () => [{ windowId: 1, bounds: { x, y: 0, width: 800, height: 600 } }],
    capture: async () => { captures++; } });
  await assert.rejects(scope.run({}, () => desktop.capture({ windowId: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } })), { code: 'DRAGON_TARGET_CHANGED' });
  assert.equal(captures, 0);
});
test('elevated or unavailable desktops fail before approval or input', async () => {
  let approvals = 0;
  const policy = { require: async () => { approvals++; } };
  const high = createExecutionScope(policy, { native: async () => ({ ...identity, elevated: true }) });
  await assert.rejects(high.authorizeWindow({}, 1, 'control'), { code: 'DRAGON_WINDOW_ELEVATED' });
  const locked = createExecutionScope(policy, { native: async () => ({ ...identity, interactiveDesktop: false }) });
  await assert.rejects(locked.authorizeWindow({}, 1, 'control'), { code: 'DRAGON_DESKTOP_UNAVAILABLE' });
  assert.equal(approvals, 0);
});

test('locking the desktop while approval is pending also stops input', async () => {
  let locked = false, inputs = 0;
  const scope = createExecutionScope({ require: async () => { locked = true; } },
    { native: async () => ({ ...identity, interactiveDesktop: !locked }) });
  await assert.rejects(async () => { await scope.authorizeWindow({}, 1, 'control'); inputs++; }, { code: 'DRAGON_DESKTOP_UNAVAILABLE' });
  assert.equal(inputs, 0);
});
