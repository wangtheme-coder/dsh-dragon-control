import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpClient, createChromeBridge, validateEndpoint } from '../chrome-cdp.mjs';

function fixture() {
  const pages = [{ type: 'page', targetId: 't1', url: 'https://one.example/a', title: 'One', loader: 'l1' },
    { type: 'page', targetId: 't2', url: 'https://two.example/b', title: 'Two', loader: 'l2' }];
  const calls = [], grants = [], confirms = [], sockets = [];
  let approve = async () => {}, grant = async () => {}, waitFound = false, slowNavigation = false;
  const permissions = { require: async (exec, target, scope) => { grants.push([target.id, scope]); await grant(exec, target, scope); },
    confirm: async (exec, description, args) => { confirms.push(args); await approve(exec, description, args); } };
  const connect = async () => {
    const sessions = new Map(); let n = 0;
    const cdp = { closed: false, close() { this.closed = true; }, async call(method, params = {}, session, signal) {
      signal?.throwIfAborted(); if (this.closed) throw Error('closed'); calls.push({ method, params, session });
      if (method === 'Target.getTargets') return { targetInfos: pages.map(p => ({ ...p })) };
      if (method === 'Target.attachToTarget') { const id = 's' + ++n; sessions.set(id, params.targetId); return { sessionId: id }; }
      if (method === 'Target.detachFromTarget') { sessions.delete(params.sessionId); return {}; }
      if (method === 'Target.closeTarget') { pages.splice(pages.findIndex(p => p.targetId === params.targetId), 1); return {}; }
      if (method === 'Target.createTarget') {
        const id = 't' + (pages.length + 1), page = { type: 'page', targetId: id, url: params.url, title: '', loader: id };
        pages.push(page);
        return { targetId: id };
      }
      const page = pages.find(p => p.targetId === sessions.get(session));
      if (method === 'Page.navigate') {
        const loader = page.loader + '-next';
        const complete = () => { page.url = params.url; page.loader = loader; };
        if (slowNavigation) setTimeout(complete, 20); else complete();
        return { loaderId: loader };
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f-' + page.targetId, url: page.url, loaderId: page.loader } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        return { result: { value: e.includes('matches.length') ? 'accepted' : e.startsWith('Boolean(document.querySelector') ? waitFound : e.includes('cloneNode') ? '<html>page</html>' : page.targetId + ' text' } };
      }
      return {};
    } }; sockets.push(cdp); return cdp;
  };
  const bridge = createChromeBridge({ permissions, connect, probe: async port => ({ port, url: `ws://127.0.0.1:${port}/devtools/browser/test`, browser: 'Test' }) });
  const exec = { agent: { id: 'one', session: {} }, signal: new AbortController().signal };
  return { bridge, exec, pages, calls, grants, confirms, sockets, approve: fn => { approve = fn; }, grant: fn => { grant = fn; }, found: () => { waitFound = true; }, slow: () => { slowNavigation = true; } };
}

test('CDP metadata and every mutation use the same origin/one-use approval rules', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec);
  assert.deepEqual(f.grants, [['https://one.example', 'read'], ['https://two.example', 'read']]);
  f.grants.length = 0; f.confirms.length = 0;
  assert.match((await f.bridge.execute('content', {}, f.exec)).content, /page/);
  await f.bridge.execute('click', { selector: '#go' }, f.exec);
  assert.deepEqual(f.grants, [['https://one.example', 'read'], ['https://one.example', 'control']]);
  assert.equal(f.confirms.length, 1); assert.equal(f.confirms[0].op, 'click');
  f.approve(async () => { throw Error('denied'); });
  const count = f.calls.filter(c => c.method === 'Target.closeTarget').length;
  await assert.rejects(f.bridge.execute('close', { tab: 't2' }, f.exec), /denied/);
  assert.equal(f.calls.filter(c => c.method === 'Target.closeTarget').length, count);
});

test('switch remains selected and a missing target never chooses another tab', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec); await f.bridge.execute('switch', { tab: 't2' }, f.exec);
  assert.equal((await f.bridge.execute('current', {}, f.exec)).tab, 't2');
  assert.match((await f.bridge.execute('text', {}, f.exec)).text, /t2/);
  f.pages.pop(); await assert.rejects(f.bridge.execute('text', {}, f.exec), { code: 'DRAGON_CDP_TARGET_GONE' });
});

test('open waits for a newly created blank target to commit its HTTP navigation', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec); f.slow();
  const opened = await f.bridge.execute('open', { url: 'https://three.example/' }, f.exec);
  assert.equal(opened.actionAccepted, true);
  assert.equal((await f.bridge.execute('current', {}, f.exec)).url, 'https://three.example/');
  assert.deepEqual(f.grants.at(-1), ['https://three.example', 'read']);
});

test('navigation including same-URL reload during approval prevents a stale CDP input', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec);
  f.approve(async () => { f.pages[0].loader = 'replacement'; });
  await assert.rejects(f.bridge.execute('click', { selector: '#go' }, f.exec), { code: 'DRAGON_CDP_STALE' });
  assert.equal(f.calls.filter(c => c.method === 'Runtime.evaluate').length, 0);
});

test('listing tabs cannot disclose another denied origin', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec);
  f.grant(async (_exec, target) => { if (target.id === 'https://two.example') throw Error('scope denied'); });
  await assert.rejects(f.bridge.execute('tabs', {}, f.exec), /scope denied/);
});

test('agents and replacement sessions cannot borrow or detach another CDP connection', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec);
  const other = { ...f.exec, agent: { id: 'two', session: {} } };
  await assert.rejects(f.bridge.execute('current', {}, other), { code: 'DRAGON_CDP_DETACHED' });
  f.bridge.detach(other); assert.equal(f.sockets[0].closed, false);
  await assert.rejects(f.bridge.execute('current', {}, { ...f.exec, agent: { ...f.exec.agent, session: {} } }), { code: 'DRAGON_CDP_DETACHED' });
  f.bridge.dispose(); assert.equal(f.sockets[0].closed, true);
});

test('CDP conditional wait responds promptly to emergency cancellation', async () => {
  const f = fixture(); await f.bridge.attach({}, f.exec); const controller = new AbortController();
  const pending = f.bridge.execute('wait', { selector: '#later', timeout_ms: 60000 }, { ...f.exec, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.bridge.isAttached(f.exec), true); f.bridge.dispose();
});

test('only the explicitly selected loopback debugger endpoint is accepted', () => {
  for (const url of ['ws://evil.example:9222/devtools/browser/test', 'ws://127.0.0.1:9333/devtools/browser/test', 'ws://user:pass@127.0.0.1:9222/devtools/browser/test', 'wss://127.0.0.1:9222/devtools/browser/test']) {
    assert.throws(() => validateEndpoint(url, 9222), { code: 'DRAGON_CDP_ENDPOINT' });
  }
  assert.equal(validateEndpoint('ws://127.0.0.1:9222/devtools/browser/test', 9222), 'ws://127.0.0.1:9222/devtools/browser/test');
});

class FakeSocket extends EventTarget {
  send(raw) { this.sent = JSON.parse(raw); }
  close() { this.dispatchEvent(new Event('close')); }
}
test('in-flight CDP calls are cancelled and removed instead of waiting for late responses', async () => {
  const socket = new FakeSocket(), client = new CdpClient(socket), controller = new AbortController();
  const pending = client.call('Runtime.evaluate', {}, 's', controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(client.pending.size, 0);
  const second = client.call('Target.getTargets'); client.close();
  await assert.rejects(second, { code: 'DRAGON_CDP_CLOSED' }); assert.equal(client.pending.size, 0);
  await delay(1);
});
