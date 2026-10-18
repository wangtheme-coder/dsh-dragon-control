import test from 'node:test';
import assert from 'node:assert/strict';
import { requestNative, closeNativeSessions } from '../native-session.mjs';
import { NATIVE_PATH } from '../dragon-native.mjs';
import { PROBE_PATH } from '../native-client.mjs';

const windows = process.platform === 'win32';

test('native session: 两个请求在同一个常驻进程里按序返回', { skip: !windows }, async () => {
  const [a, b] = await Promise.all([
    requestNative(NATIVE_PATH, { op: 'foreground' }),
    requestNative(NATIVE_PATH, { op: 'ping' })
  ]);
  assert.ok(a.hwnd > 0);
  assert.equal(b.pong, true);
  const again = await requestNative(NATIVE_PATH, { op: 'ping' });
  assert.equal(b.pid, again.pid, '连续请求应来自同一个常驻进程');
});

test('native session: 原生报错不弄死进程，下一个请求仍可用', { skip: !windows }, async () => {
  await assert.rejects(requestNative(NATIVE_PATH, { op: 'nope' }), { code: 'DRAGON_NATIVE_FAILED' });
  const value = await requestNative(NATIVE_PATH, { op: 'foreground' });
  assert.ok(value.hwnd > 0);
});

test('native session: 取消会收掉进程，重新请求自动拉起', { skip: !windows }, async () => {
  const controller = new AbortController();
  const pending = requestNative(NATIVE_PATH, { op: 'foreground' }, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  const value = await requestNative(NATIVE_PATH, { op: 'foreground' });
  assert.ok(value.hwnd > 0);
});

test('native session: 空闲后自动退出，再次请求能重启', { skip: !windows }, async () => {
  await requestNative(NATIVE_PATH, { op: 'ping' }, undefined, { idleMs: 60 });
  await new Promise(resolve => setTimeout(resolve, 400));
  const value = await requestNative(NATIVE_PATH, { op: 'ping' });
  assert.equal(value.pong, true);
});

test('native session: A11yProbe 常驻后 inspect 与 tree 都能连续返回', { skip: !windows }, async () => {
  const front = await requestNative(NATIVE_PATH, { op: 'foreground' });
  const one = await requestNative(PROBE_PATH, { op: 'inspect', windowId: front.hwnd });
  const two = await requestNative(PROBE_PATH, { op: 'inspect', windowId: front.hwnd });
  assert.equal(one.windowId, two.windowId);
  assert.equal(typeof one.interactiveDesktop, 'boolean');
  const tree = await requestNative(PROBE_PATH, { op: 'tree', windowId: front.hwnd });
  assert.ok(Array.isArray(tree.elements));
  assert.equal(tree.windowId, front.hwnd);
  closeNativeSessions();
});
