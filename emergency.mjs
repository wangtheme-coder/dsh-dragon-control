import { Worker } from 'node:worker_threads';

export function createEscapeMonitor(koffiPath, { includeInjected = false } = {}) {
  const shared = new Int32Array(new SharedArrayBuffer(8));
  const handlers = new Set();
  const worker = new Worker(new URL('./escape-worker.mjs', import.meta.url), {
    workerData: { koffiPath, shared: shared.buffer, includeInjected }, execArgv: []
  });
  let generation = 0, ready = false, disposed = false, fault;
  let resolveReady, rejectReady;
  const started = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A diagnostic read may precede the first operation; retain a handled rejection.
  started.catch(() => {});
  function fail(error) {
    fault = error; ready = false; rejectReady(error);
    for (const handler of handlers) handler(error);
  }
  function sync() {
    const current = Atomics.load(shared, 0);
    if (current === generation) return;
    generation = current;
    for (const handler of handlers) handler();
  }
  worker.on('message', value => {
    if (value.type === 'ready') { ready = true; resolveReady(); if (!disposed) worker.unref(); }
    if (value.type === 'escape') sync();
  });
  worker.on('error', fail);
  worker.on('exit', code => { if (!disposed) fail(Error(`Esc 监听线程已退出 (${code})。`)); });
  return {
    ready: started,
    sync,
    onStop(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    arm(delta) {
      Atomics.add(shared, 1, delta);
      if (Atomics.load(shared, 1) > 0) worker.ref(); else worker.unref();
    },
    status() { return { ready, armed: Atomics.load(shared, 1) > 0, error: fault?.message ?? null }; },
    async dispose() {
      if (disposed) return;
      disposed = true; ready = false; handlers.clear(); Atomics.store(shared, 1, 0); worker.ref();
      worker.postMessage({ type: 'dispose' });
      // The hook is removed by the owning thread; terminate only if shutdown hangs.
      const timeout = setTimeout(() => worker.terminate(), 1500); timeout.unref();
      await new Promise(resolve => { if (worker.threadId === -1) resolve(); else worker.once('exit', resolve); });
      clearTimeout(timeout);
    }
  };
}

export function lastHumanInput(session) {
  const events = session?.snapshotEvents?.() ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.form !== 'notice') {
      return String(event.seq ?? `${i}:${event.time ?? ''}:${event.data.source.rpcId ?? ''}`);
    }
  }
  return null;
}

export function createEmergencyControl(monitor, { onStop = () => {} } = {}) {
  const records = new Map();
  let disposed = false;
  const key = exec => exec.agent?.id ?? 'local-test';
  function disarm(record) {
    if (record.armed) { record.armed = false; monitor.arm(-1); }
  }
  function stop(error) {
    const reason = error ?? Object.assign(new Error('已按 Esc 停止龙爪控制；本轮不会继续操作。请发送新消息后再继续。'), { code: 'DRAGON_USER_STOP', name: 'AbortError' });
    for (const record of records.values()) {
      if (!record.armed) continue;
      record.stopped = true; record.reason = reason; record.input = lastHumanInput(record.agent?.session);
      for (const controller of record.controllers) controller.abort(reason);
      disarm(record);
      try { record.agent?.cancel?.({ kind: 'user' }); } catch {}
    }
    onStop();
  }
  const detach = monitor.onStop(stop);
  function acquire(exec) {
    if (disposed) throw Error('龙爪控制已经卸载。');
    monitor.sync();
    const health = monitor.status();
    if (!health.ready) throw Error(`Esc 急停不可用，停止执行界面动作：${health.error ?? '监听尚未就绪'}`);
    const id = key(exec), input = lastHumanInput(exec.agent?.session);
    let record = records.get(id);
    if (record?.stopped) {
      if (input === record.input || record.controllers.size > 0) throw record.reason;
      records.delete(id); record = undefined;
    }
    if (!record) {
      record = { agent: exec.agent, input, stopped: false, armed: false, controllers: new Set() };
      records.set(id, record);
    }
    record.input = input;
    if (!record.armed) { record.armed = true; monitor.arm(1); }
    return record;
  }
  return {
    stop,
    watch(exec) { try { acquire(exec); } catch (error) { return error.message; } },
    status(exec = {}) {
      monitor.sync();
      const record = records.get(key(exec));
      return { ...monitor.status(), stopped: Boolean(record?.stopped), activeOperations: record?.controllers.size ?? 0,
        recovery: record?.stopped ? '发送新的用户消息才可恢复；模型重试不会解除急停。' : null };
    },
    async run(exec, operation) {
      if (disposed) throw Error('龙爪控制已经卸载。');
      await monitor.ready;
      const record = acquire(exec);
      const controller = new AbortController(); record.controllers.add(controller);
      const signal = AbortSignal.any([exec.signal ?? new AbortController().signal, controller.signal]);
      try {
        signal.throwIfAborted();
        const result = await operation({ ...exec, signal });
        monitor.sync(); signal.throwIfAborted();
        return result;
      } finally {
        record.controllers.delete(controller);
        if (record.agent?.status !== 'running' && record.controllers.size === 0) disarm(record);
      }
    },
    turnEnded(session) {
      for (const [id, record] of records) if (record.agent?.session === session) {
        disarm(record);
        if (!record.stopped && record.controllers.size === 0) records.delete(id);
      }
    },
    dispose() { disposed = true; stop(Error('龙爪控制已卸载。')); detach(); records.clear(); }
  };
}
