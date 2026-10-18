import test from 'node:test';
import assert from 'node:assert/strict';
import { batchDefinition, makeControlTool } from '../control.mjs';

function fixture() {
  const calls = [];
  const def = (name, behavior) => ({
    name, description: name,
    parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args) => { calls.push(name); return behavior(args); }
  });
  const definitions = new Map([
    ['fake_a', def('fake_a', () => ({ value: 'a' }))],
    ['fake_b', def('fake_b', args => ({ value: 'b', ...args }))],
    ['fake_fail', def('fake_fail', () => { throw Object.assign(new Error('boom'), { code: 'DRAGON_TEST_FAIL' }); })],
    ['dragon_batch', batchDefinition]
  ]);
  const tool = makeControlTool({
    name: 'dragon_browser',
    actions: { a: 'fake_a', b: 'fake_b', fail: 'fake_fail', batch: 'dragon_batch' },
    definitions
  });
  const exec = { signal: new AbortController().signal, agent: { id: 'batch-test' } };
  return { tool, calls, exec };
}

const run = (tool, request, exec) => tool.execute(request, exec);

test('batch runs steps in order and keeps the last step content', async () => {
  const { tool, calls, exec } = fixture();
  const result = await run(tool, { action: 'batch', args: { steps: [{ action: 'a' }, { action: 'b', args: { x: 1 } }] } }, exec);
  assert.deepEqual(calls, ['fake_a', 'fake_b']);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.steps.length, 2);
  assert.match(payload.steps[0].text, /"value":"a"/);
  assert.match(payload.steps[1].text, /"x":1/);
});

test('batch stops at the first failure and reports the step', async () => {
  const { tool, calls, exec } = fixture();
  const result = await run(tool, { action: 'batch', args: { steps: [{ action: 'a' }, { action: 'fail' }, { action: 'b' }] } }, exec);
  assert.deepEqual(calls, ['fake_a', 'fake_fail']);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.failedAt, 2);
  assert.equal(payload.steps[1].code, 'DRAGON_TEST_FAIL');
  assert.equal(payload.steps.length, 2);
});

test('batch refuses nested batches, unknown actions and empty step lists', async () => {
  const { tool, exec } = fixture();
  await assert.rejects(run(tool, { action: 'batch', args: { steps: [{ action: 'batch' }] } }, exec), /动作无效/);
  await assert.rejects(run(tool, { action: 'batch', args: { steps: [{ action: 'nope' }] } }, exec), /动作无效/);
  await assert.rejects(run(tool, { action: 'batch', args: { steps: [] } }, exec), /1–50/);
  await assert.rejects(run(tool, { action: 'batch', args: {} }, exec), /1–50/);
});

test('batch forwards per-step arguments and an explicit observation id', async () => {
  const { tool, calls, exec } = fixture();
  const result = await run(tool, { action: 'batch', args: { steps: [{ action: 'b', args: { n: 2 }, observation_id: 'abc' }] } }, exec);
  assert.deepEqual(calls, ['fake_b']);
  assert.match(JSON.parse(result.content[0].text).steps[0].text, /"n":2/);
});

test('all batch step parameters are checked before any earlier side effect', async () => {
  let sideEffects = 0;
  const def = { name: 'write', parameters: {}, execute: async () => { sideEffects++; return {}; }, output: { render: () => [] } };
  const tool = makeControlTool({ name: 'dragon_browser', actions: { write: 'write', batch: 'dragon_batch' },
    definitions: new Map([['write', def], ['dragon_batch', batchDefinition]]),
    validate: (_def, args) => { if (args.bad) throw Error('invalid later step'); } });
  await assert.rejects(tool.execute({ action: 'batch', args: { steps: [{ action: 'write' }, { action: 'write', args: { bad: true } }] } }), /invalid later/);
  assert.equal(sideEffects, 0);
});

test('batch audits individual outcomes including the failing step', async () => {
  const events = [], definitions = new Map();
  for (const action of ['ok', 'fail']) definitions.set(action, { name: action, parameters: {}, output: { render: () => [] },
    execute: async () => { if (action === 'fail') throw Error('failed'); return {}; } });
  definitions.set('dragon_batch', batchDefinition);
  const tool = makeControlTool({ name: 'dragon_browser', actions: { ok: 'ok', fail: 'fail', batch: 'dragon_batch' }, definitions,
    audit: { run: async ({ action }, _exec, run) => { try { const result = await run(); events.push([action, true]); return result; } catch (e) { events.push([action, false]); throw e; } } } });
  await tool.execute({ action: 'batch', args: { steps: [{ action: 'ok' }, { action: 'fail' }, { action: 'ok' }] } });
  assert.deepEqual(events, [['ok', true], ['fail', false]]);
});
