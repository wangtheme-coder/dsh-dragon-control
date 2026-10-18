import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPermissions } from '../permissions.mjs';

const target = { kind: 'app', id: resolve('allowed.exe') };
async function fixture() {
  let decision = 'allowed-once', calls = 0, policy = 'ask';
  const service = { effectivePolicy: () => policy, request: async () => { calls++; return typeof decision === 'function' ? decision() : decision; } };
  const path = join(await mkdtemp(join(tmpdir(), 'dragon-permission-test-')), 'permissions.json');
  const permissions = createPermissions({ get: () => service }, path); await permissions.initialize();
  const exec = { agent: { id: 'one', session: {} }, signal: new AbortController().signal };
  return { permissions, path, exec, service, calls: () => calls, decide: value => { decision = value; }, policy: value => { policy = value; } };
}
test('read lasts for a session, control for a turn, and neither is borrowed by another Agent', async () => {
  const f = await fixture();
  await f.permissions.require(f.exec, target, 'read'); await f.permissions.require(f.exec, target, 'read'); assert.equal(f.calls(), 1);
  await f.permissions.require(f.exec, target, 'control'); assert.equal(f.calls(), 2);
  f.permissions.end(f.exec.agent.session);
  await f.permissions.require(f.exec, target, 'read'); assert.equal(f.calls(), 2);
  await f.permissions.require(f.exec, target, 'control'); assert.equal(f.calls(), 3);
  await f.permissions.require({ ...f.exec, agent: { id: 'two', session: {} } }, target, 'read'); assert.equal(f.calls(), 4);
});
test('never and a rejection fail before any input and rejection cannot prompt-loop', async () => {
  const f = await fixture(); let inputs = 0;
  f.policy('never');
  await assert.rejects(async () => { await f.permissions.require(f.exec, target, 'control'); inputs++; }, { code: 'DRAGON_PERMISSION_REQUIRED' });
  assert.equal(f.calls(), 0); assert.equal(inputs, 0);
  f.policy('ask'); f.decide('rejected');
  await assert.rejects(f.permissions.require(f.exec, target, 'control'), { code: 'DRAGON_PERMISSION_DENIED' });
  f.decide('allowed-once');
  await assert.rejects(f.permissions.require(f.exec, target, 'control'), { code: 'DRAGON_PERMISSION_DENIED' }); assert.equal(f.calls(), 1);
});
test('approval arriving after turn end cannot restore a control lease', async () => {
  const f = await fixture(); let release;
  f.decide(() => new Promise(resolve => { release = resolve; }));
  const pending = f.permissions.require(f.exec, target, 'control');
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  f.permissions.end(f.exec.agent.session); release('allowed-once');
  await assert.rejects(pending, { code: 'DRAGON_APPROVAL_EXPIRED' });
});
test('sensitive approval is consumed per call and denied requests are not retried', async () => {
  const f = await fixture(); const request = { window: 1, target: 'one' };
  await f.permissions.confirm(f.exec, 'invoke', request); await f.permissions.confirm(f.exec, 'invoke', request); assert.equal(f.calls(), 2);
  f.decide('rejected'); await assert.rejects(f.permissions.confirm(f.exec, 'invoke', request));
  f.decide('allowed-once'); await assert.rejects(f.permissions.confirm(f.exec, 'invoke', request)); assert.equal(f.calls(), 3);
});
test('auto mode decides by itself and never reaches the host approval', async () => {
  const f = await fixture(); f.policy('never');
  await writeFile(f.path, JSON.stringify({ version: 1, mode: 'auto', apps: {}, origins: {} }));
  await f.permissions.require(f.exec, target, 'control');
  await f.permissions.confirm(f.exec, 'invoke', { window: 1, target: 'one' });
  assert.equal(f.calls(), 0);
  assert.equal(f.permissions.status().mode, 'auto');
});
test('owner mode stays the default and an unknown mode is refused', async () => {
  const f = await fixture();
  assert.equal(f.permissions.status().mode, 'owner');
  await writeFile(f.path, JSON.stringify({ version: 1, mode: 'root', apps: {}, origins: {} }));
  await assert.rejects(f.permissions.require(f.exec, target, 'read'), { code: 'DRAGON_PERMISSION_CONFIG' });
});

test('returning from auto to owner revokes automatic access and earlier pending approvals', async () => {
  const f = await fixture();
  await f.permissions.setMode('auto'); await f.permissions.require(f.exec, target, 'control');
  await f.permissions.setMode('owner'); f.policy('never');
  await assert.rejects(f.permissions.require(f.exec, target, 'read'), { code: 'DRAGON_PERMISSION_REQUIRED' });
  f.policy('ask'); let release;
  f.decide(() => new Promise(resolve => { release = resolve; }));
  const pending = f.permissions.require(f.exec, target, 'control');
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await f.permissions.setMode('auto'); release('allowed-once');
  await assert.rejects(pending, { code: 'DRAGON_APPROVAL_EXPIRED' });
});

test('auto respects explicit read denials and cancellation', async () => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify({ version: 1, mode: 'auto', apps: { [target.id]: { read: false } }, origins: {} }));
  await assert.rejects(f.permissions.require(f.exec, target, 'control'), { code: 'DRAGON_PERMISSION_DENIED' });
  const controller = new AbortController(); controller.abort(); const exec = { ...f.exec, signal: controller.signal };
  await assert.rejects(f.permissions.confirm(exec, 'stop', {}), { name: 'AbortError' });
});
test('exact configuration never matches arbitrary apps or grants page scripts implicitly', async () => {
  const f = await fixture(); f.policy('never');
  await writeFile(f.path, JSON.stringify({ version: 1, apps: { [target.id]: { read: true } }, origins: {} }));
  await f.permissions.require(f.exec, target, 'read');
  await assert.rejects(f.permissions.require(f.exec, target, 'control'));
  await assert.rejects(f.permissions.require(f.exec, { ...target, id: resolve('another.exe') }, 'read'));
  assert.equal(await f.permissions.pageScriptEnabled(), false);
  await writeFile(f.path, JSON.stringify({ version: 1, apps: { '*': { control: true } }, origins: {} }));
  await assert.rejects(f.permissions.require(f.exec, target, 'read'), { code: 'DRAGON_PERMISSION_CONFIG' });
});
