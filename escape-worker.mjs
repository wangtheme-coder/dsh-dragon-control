import { parentPort, workerData } from 'node:worker_threads';
import { spawnEscapeWatcher } from './dragon-native.mjs';

// Esc 急停监听：DragonNative.exe 的 watch 模式在独立进程里装低级键盘钩子，
// 本线程只做转发与计数，不再需要 koffi，也不依赖 dsh-orb。
const shared = new Int32Array(workerData.shared);
let disposed = false;
let ready = false;
const watcher = spawnEscapeWatcher({
  includeInjected: workerData.includeInjected ?? false,
  onReady() {
    ready = true;
    if (!disposed) parentPort.postMessage({ type: 'ready' });
  },
  onEscape() {
    if (disposed) return;
    // 只有“已布防”的轮次才触发急停，和旧的 SharedArrayBuffer 约定保持一致。
    if (Atomics.load(shared, 1) > 0) {
      const generation = Atomics.add(shared, 0, 1) + 1;
      parentPort.postMessage({ type: 'escape', generation });
    }
  },
  onError(error) {
    if (disposed) return;
    // 监听失效必须显式失败：让 emergency 的 ready 承诺拒绝，从而拒绝所有界面动作。
    parentPort.postMessage({ type: 'error', message: error?.message ?? String(error) });
    throw error instanceof Error ? error : Error(String(error));
  }
});

parentPort.on('message', value => {
  if (value?.type !== 'dispose') return;
  disposed = true;
  watcher.dispose();
  parentPort.close();
});
