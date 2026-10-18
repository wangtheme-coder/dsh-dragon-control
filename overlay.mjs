import { AsyncLocalStorage } from 'node:async_hooks';

// The upstream registration facade deliberately omits eager screenshot hooks.
// Own the observation ribbon's lifetime here instead of leaving it on screen.
export function createObservationFrameLifecycle(resolveGuard) {
  const local = new AsyncLocalStorage();
  const pending = new Set();
  const proxies = new WeakMap();
  let disposed = false;
  let lastGuard;

  function currentGuard() {
    const value = resolveGuard();
    if (value) lastGuard = value;
    return value;
  }

  async function clear() {
    // Cordis may remove service lookup access before running a disposer.
    let target = lastGuard;
    try { target = currentGuard() ?? target; } catch {}
    try { await target?.setObservationFrame(null); } catch {}
  }
  const expired = scope => disposed || Boolean(scope && (!scope.active || scope.signal?.aborted));
  function guard() {
    const original = currentGuard();
    if (!original) return undefined;
    if (!proxies.has(original)) proxies.set(original, new Proxy(original, {
      get(target, key) {
        if (key === 'setObservationFrame') return async (bounds, signal) => {
          const scope = local.getStore();
          if (bounds === null || expired(scope) || signal?.aborted) return clear();
          try { return await target.setObservationFrame(bounds, signal); }
          finally {
            // Stop can occur while the helper is acknowledging a screenshot.
            // A late acknowledgement must not restore a cancelled ribbon.
            if (expired(scope) || signal?.aborted) await clear();
          }
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }));
    return proxies.get(original);
  }
  async function stop(session) {
    const matching = [...pending].some(scope => scope.session === session);
    for (const scope of pending) if (!session || scope.session === session) scope.active = false;
    if (!session || matching || pending.size === 0) await clear();
  }
  return {
    guard, clear, stop,
    async run(exec, operation) {
      const scope = { session: exec.agent?.session, signal: exec.signal, active: !disposed };
      pending.add(scope);
      const onAbort = () => { scope.active = false; void clear(); };
      exec.signal?.addEventListener('abort', onAbort, { once: true });
      try { return await local.run(scope, () => operation(exec)); }
      finally {
        scope.active = false;
        pending.delete(scope);
        exec.signal?.removeEventListener('abort', onAbort);
        if (pending.size === 0) await clear();
      }
    },
    async dispose() { disposed = true; await stop(); }
  };
}
