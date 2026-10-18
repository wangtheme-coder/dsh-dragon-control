import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
const native = await import(pathToFileURL(workerData.nativePath).href);
const ops = native.createProductionWindowsOps();
parentPort.on('message', request => {
  try {
    if (request.op === 'dispose') { parentPort.close(); return; }
    let value;
    if (request.op === 'listWindows') value = ops.listWindows();
    else if (request.op === 'focusWindow') {
      const current = ops.listWindows().windows.find(w => w.hwnd === request.windowId);
      const previous = request.identity;
      if (!current || current.pid !== previous.pid || current.className !== previous.className || current.title !== previous.title) throw Error('激活前窗口身份已变化，请重新 windows。');
      value = ops.focusWindow(request.windowId);
    } else throw Error('Unsupported window operation');
    parentPort.postMessage({ id: request.id, value });
  } catch (error) { parentPort.postMessage({ id: request.id, error: error.message }); }
});
parentPort.postMessage({ ready: true });
