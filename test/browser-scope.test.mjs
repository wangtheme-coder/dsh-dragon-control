import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionScope } from '../execution.mjs';

test('same-origin navigation or tab replacement during approval prevents a stale click', async () => {
  let url = 'https://example.com/first', inputs = 0;
  const policy = { require: async () => {}, confirm: async () => { url = 'https://example.com/other'; } };
  const scope = createExecutionScope(policy);
  const browser = scope.secureBrowser({ listTabs: async () => [{ id: 'one', active: true, url }], click: async () => { inputs++; } });
  await assert.rejects(scope.run({ signal: new AbortController().signal }, () => browser.click('session', { target: 'button' })), { code: 'DRAGON_BROWSER_TARGET_CHANGED' });
  assert.equal(inputs, 0);
});
test('an older parallel browser entry cannot execute without an operation scope', async () => {
  const scope = createExecutionScope({}); let calls = 0;
  const browser = scope.secureBrowser({ listTabs: async () => [], click: async () => { calls++; } });
  await assert.rejects(browser.click('session', {}), { code: 'DRAGON_NO_EXECUTION' });
  assert.equal(calls, 0);
});
test('a refused navigation never starts the browser runtime', async () => {
  let started = 0;
  const policy = { require: async () => { throw Object.assign(Error('denied'), { code: 'DRAGON_PERMISSION_REQUIRED' }); } };
  const scope = createExecutionScope(policy);
  const browser = scope.secureBrowser({ listTabs: async () => { started++; return [{ id: 'one', active: true, url: 'about:blank' }]; },
    openUrl: async () => ({ id: 'one' }) });
  await assert.rejects(scope.run({ signal: new AbortController().signal }, () => browser.openUrl('session', { url: 'https://example.com/' })),
    { code: 'DRAGON_PERMISSION_REQUIRED' });
  assert.equal(started, 0);
});
