import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationFrameLifecycle } from '../overlay.mjs';
import { createEmergencyControl } from '../emergency.mjs';

const bounds = { x: 0, y: 0, width: 800, height: 600 };
function setup() {
  let visible = null;
  const signals = [];
  const guard = { async setObservationFrame(value, signal) {
    signals.push(signal); signal?.throwIfAborted(); visible = value;
  } };
  const frames = createObservationFrameLifecycle(() => guard);
  return { frames, guard, signals, visible: () => visible };
}

test('successful actions and backend failures both remove the observation frame', async () => {
  const f = setup();
  await f.frames.run({}, async () => { await f.frames.guard().setObservationFrame(bounds); assert.deepEqual(f.visible(), bounds); });
  assert.equal(f.visible(), null);
  await assert.rejects(f.frames.run({}, async () => {
    await f.frames.guard().setObservationFrame(bounds); throw Error('backend failed');
  }), /backend failed/);
  assert.equal(f.visible(), null);
});

test('aborting during an action hides immediately using a fresh cleanup call', async () => {
  const f = setup(), controller = new AbortController();
  await f.frames.run({ signal: controller.signal }, async () => {
    await f.frames.guard().setObservationFrame(bounds, controller.signal);
    controller.abort();
    await Promise.resolve();
    assert.equal(f.visible(), null);
    await f.frames.guard().setObservationFrame(bounds, controller.signal);
    assert.equal(f.visible(), null);
  });
  assert.equal(f.signals.at(-1), undefined);
});

test('Esc between actions clears the existing shared Orb frame and cancels the agent', async () => {
  const f = setup(); let stop, armed = 0, cancelled = 0;
  const monitor = { ready: Promise.resolve(), sync() {}, arm(delta) { armed += delta; },
    status: () => ({ ready: true, armed: armed > 0 }), onStop(fn) { stop = fn; return () => {}; } };
  const control = createEmergencyControl(monitor, { onStop: () => { void f.frames.stop(); } });
  const agent = { id: 'test', status: 'running', session: {}, cancel() { cancelled++; } };
  control.watch({ agent });
  await f.guard.setObservationFrame(bounds);
  stop(); await Promise.resolve();
  assert.equal(f.visible(), null); assert.equal(cancelled, 1);
  control.dispose();
});

test('a screenshot acknowledged after turn end cannot leave a frame behind', async () => {
  const f = setup(), session = {};
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const original = f.guard.setObservationFrame;
  f.guard.setObservationFrame = async (value, signal) => {
    if (value !== null) { started(); await blocked; }
    return original(value, signal);
  };
  const work = f.frames.run({ agent: { session } }, () => f.frames.guard().setObservationFrame(bounds));
  await ready; await f.frames.stop(session); assert.equal(f.visible(), null);
  release(); await work; assert.equal(f.visible(), null);
});

test('detached late capture after action settlement or disposal cannot show a new frame', async () => {
  const f = setup(); let late;
  await f.frames.run({}, async () => { late = new Promise(resolve => {
    setTimeout(async () => { await f.frames.guard().setObservationFrame(bounds); resolve(); }, 10);
  }); });
  await late; assert.equal(f.visible(), null);
  await f.guard.setObservationFrame(bounds); await f.frames.dispose();
  assert.equal(f.visible(), null);
  await f.frames.guard().setObservationFrame(bounds); assert.equal(f.visible(), null);
});

test('missing or disconnected overlay service does not mask an action result or error', async () => {
  const absent = createObservationFrameLifecycle(() => undefined);
  assert.equal(absent.guard(), undefined);
  assert.equal(await absent.run({}, async () => 42), 42);
  const broken = createObservationFrameLifecycle(() => ({ setObservationFrame() { throw Error('disconnected'); } }));
  await assert.rejects(broken.run({}, async () => { throw Error('real failure'); }), /real failure/);
  await broken.dispose();
});

test('unload can clear the last guard after Cordis has removed service lookup', async () => {
  let available = true, visible = null;
  const guard = { async setObservationFrame(bounds) { visible = bounds; } };
  const frames = createObservationFrameLifecycle(() => available ? guard : undefined);
  await frames.guard().setObservationFrame(bounds);
  available = false; await frames.dispose(); assert.equal(visible, null);
});
