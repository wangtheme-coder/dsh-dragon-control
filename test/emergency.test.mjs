import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmergencyControl, lastHumanInput } from '../emergency.mjs';
import { makeControlTool } from '../control.mjs';

function setup() {
  const handlers = new Set(); let armed = 0;
  const monitor = { ready: Promise.resolve(), sync() {}, status: () => ({ ready: true, armed: armed > 0 }),
    arm(n) { armed += n; assert(armed >= 0); }, onStop(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    escape() { for (const fn of handlers) fn(); } };
  const events = [{ seq: 1, type: 'user/message', data: { source: { kind: 'user' } } }];
  let cancelled = 0;
  const agent = { id: 'one', status: 'running', session: { snapshotEvents: () => events }, cancel(reason) { assert.equal(reason.kind, 'user'); cancelled++; } };
  const control = createEmergencyControl(monitor);
  return { monitor, events, agent, control, cancelled: () => cancelled };
}

test('Esc aborts an in-flight operation, cancels the DSH turn and blocks model retries', async () => {
  const f = setup();
  let started; const startedPromise = new Promise(r => { started = r; });
  const work = f.control.run({ agent: f.agent }, async exec => {
    started(); await new Promise((resolve, reject) => exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true }));
  });
  await startedPromise; f.monitor.escape();
  await assert.rejects(work, /已按 Esc/);
  assert.equal(f.cancelled(), 1);
  await assert.rejects(f.control.run({ agent: f.agent }, () => assert.fail('must not execute')), /已按 Esc/);
  assert.equal(f.control.status({ agent: f.agent }).stopped, true);
  f.events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'computer-use' } } });
  await assert.rejects(f.control.run({ agent: f.agent }, () => assert.fail()), /已按 Esc/);
  f.events.push({ seq: 3, type: 'user/message', data: { source: { kind: 'user' } } });
  assert.equal(await f.control.run({ agent: f.agent }, async () => 'resumed'), 'resumed');
  f.control.turnEnded(f.agent.session); assert.equal(f.monitor.status().armed, false);
  f.control.dispose();
});

test('Esc stays armed between actions while the agent is thinking and ends with the turn', async () => {
  const f = setup();
  await f.control.run({ agent: f.agent }, async () => 1);
  assert.equal(f.monitor.status().armed, true);
  f.monitor.escape(); assert.equal(f.cancelled(), 1);
  await assert.rejects(f.control.run({ agent: f.agent }, async () => 2), /已按 Esc/);
  f.control.turnEnded(f.agent.session); assert.equal(f.monitor.status().armed, false);
  f.control.dispose();
});

test('dispatcher checks cancellation between the guard and backend dispatch', async () => {
  const f = setup(); let executed = false;
  const tool = makeControlTool({ name: 'dragon_desktop', actions: { click: 'click' }, control: f.control,
    definitions: new Map([['click', { async execute() { executed = true; }, output: { render: () => [] } }]]),
    before: () => { f.monitor.escape(); } });
  await assert.rejects(tool.execute({ action: 'click' }, { agent: f.agent }), /已按 Esc/);
  assert.equal(executed, false); f.control.dispose();
});

test('human input marker ignores plugin notices and no model resume action exists', () => {
  const session = { snapshotEvents: () => [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' } } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user', form: 'notice' } } }
  ] };
  assert.equal(lastHumanInput(session), '1');
});

test('input queued before Esc cannot be mistaken for a user resuming after Esc', async () => {
  const f = setup();
  await f.control.run({ agent: f.agent }, async () => 1);
  f.events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'user' } } });
  f.monitor.escape();
  await assert.rejects(f.control.run({ agent: f.agent }, () => assert.fail('queued input resumed')), /已按 Esc/);
  f.control.dispose();
});

test('existing Orb tools can arm the same stop gate through the supported registry guard', () => {
  const f = setup();
  assert.equal(f.control.watch({ agent: f.agent }), undefined);
  f.monitor.escape(); assert.equal(f.cancelled(), 1);
  assert.match(f.control.watch({ agent: f.agent }), /已按 Esc/);
  f.control.dispose();
});
