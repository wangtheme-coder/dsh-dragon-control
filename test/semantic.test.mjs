import test from 'node:test';
import assert from 'node:assert/strict';
import { installSemantic } from '../semantic.mjs';

test('semantic handles do not cross Agents and consumed handles cannot replay', async () => {
  const defs = new Map(); let writes = 0;
  const identity = { windowId: 42, pid: 10, path: 'fixture.exe', created: '1', dpi: 96 };
  const tree = () => ({ windowId: 42, identity, elements: [{ id: 1, runtimeId: 'one', role: 'Edit', automationId: 'edit', name: 'Input', enabled: true,
    offscreen: false, password: false, patterns: ['set_value'], value: 'initial' }], truncated: false });
  installSemantic(defs, { backend: {}, permissions: { confirm: async () => {} }, authorizeWindow: async () => identity,
    native: async request => { if (request.op !== 'tree') writes++; return tree(); } });
  const exec = { agent: { id: 'one' }, signal: new AbortController().signal };
  const observed = await defs.get('dragon_a11y').execute({ window_id: 42 }, exec);
  assert(!JSON.stringify(observed).includes('runtimeId'));
  const args = { a11y_id: observed.a11y_id, element_id: observed.elements[0].element_id, value: 'next' };
  await assert.rejects(defs.get('dragon_set_element_value').execute(args, { ...exec, agent: { id: 'two' } }), { code: 'DRAGON_ELEMENT_STALE' });
  assert.equal(writes, 0);
  await defs.get('dragon_set_element_value').execute(args, exec); assert.equal(writes, 1);
  await assert.rejects(defs.get('dragon_set_element_value').execute(args, exec), { code: 'DRAGON_ELEMENT_STALE' });
});
test('unsupported patterns and denied authorization produce zero native input', async () => {
  const defs = new Map(); let writes = 0, denied = false;
  const identity = { windowId: 42, pid: 10, path: 'fixture.exe', created: '1' };
  installSemantic(defs, { backend: {}, permissions: { confirm: async () => { throw Error('denied'); } },
    authorizeWindow: async (_e, _w, scope) => { if (denied && scope === 'control') throw Error('denied'); return identity; },
    native: async request => { if (request.op !== 'tree') writes++; return { windowId: 42, identity, elements: [
      { id: 1, runtimeId: 'one', role: 'Button', name: 'button', enabled: true, patterns: ['invoke'] }
    ], truncated: false }; } });
  const exec = { agent: { id: 'one' }, signal: new AbortController().signal };
  const observed = await defs.get('dragon_a11y').execute({ window_id: 42 }, exec);
  const args = { a11y_id: observed.a11y_id, element_id: observed.elements[0].element_id };
  await assert.rejects(defs.get('dragon_set_element_value').execute({ ...args, value: 'no' }, exec));
  denied = true; await assert.rejects(defs.get('dragon_click_element').execute(args, exec));
  assert.equal(writes, 0);
});
test('wait_for defaults to the frontmost window when window_id is omitted', async () => {
  const defs = new Map();
  const identity = { windowId: 42, pid: 10, path: 'fixture.exe', created: '1' };
  installSemantic(defs, { backend: { listScreens: async () => [{ windowId: 42 }] },
    permissions: { confirm: async () => {} }, authorizeWindow: async () => identity,
    native: async () => ({ windowId: 42, identity, elements: [{ id: 1, runtimeId: 'one', role: 'Button', name: 'Ready', enabled: true, patterns: ['invoke'] }], truncated: false }) });
  const exec = { agent: { id: 'one' }, signal: new AbortController().signal };
  const waited = await defs.get('dragon_wait_for').execute({ name: 'Ready', state: 'present', timeout_ms: 100 }, exec);
  assert.equal(waited.matched, true);
  assert.equal(waited.window_id, 42);
  assert(!defs.get('dragon_wait_for').parameters.required?.includes('window_id'));
});

