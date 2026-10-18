import { createPlatformBackend } from '../platform-backend.mjs';
import { installComputerUse } from '../desktop-defs.mjs';
import { desktopObservationGuard } from '../control.mjs';
import { createExecutionScope } from '../execution.mjs';

// 只测插件侧：把真实动作链（守卫 → secureDesktop → 原生）拆开计时，不含 DSH 宿主开销。
// 用法: node scripts/profile-action.mjs
const permissions = {
  require: async () => {},
  confirm: async () => 'fingerprint',
  status: () => ({ mode: 'auto' })
};
const scope = createExecutionScope(permissions);
const backend = scope.secureDesktop(createPlatformBackend({ postActionWaitMs: 120 }));
const defs = new Map();
installComputerUse(defs, backend, { postActionWaitMs: 120, shots: process.env.DRAGON_DESKTOP_SHOTS === 'full' ? 'full' : 'light' });
const guard = desktopObservationGuard(backend);
const agent = { id: 'profile', session: { id: 's' } };
const exec = { signal: new AbortController().signal, agent };

const rows = [];
const timed = async (label, fn) => { const s = Date.now(); const v = await fn(); rows.push([label, Date.now() - s]); return v; };
const idOf = text => (String(text).match(/observation_id=([0-9a-f-]{36})/) || [])[1];


let id = await scope.run(exec, async () => {
  const value = await timed('observe.execute', () => defs.get('wait').execute({}, exec));
  return timed('observe.guard', async () => idOf(await guard.after({ value, exec })));
});
for (let i = 0; i < 3; i++) {
  id = await scope.run(exec, async () => {
    await timed(`key${i + 1}.guardBefore`, () => guard.before({ action: 'key', observation_id: id, exec }));
    const value = await timed(`key${i + 1}.execute`, () => defs.get('hotkey').execute({ key: 'shift' }, exec));
    return timed(`key${i + 1}.guardAfter`, async () => idOf(await guard.after({ value, exec })));
  });
}
const total = rows.filter(([label]) => label.startsWith('key')).reduce((n, [, ms]) => n + ms, 0);
for (const [label, ms] of rows) console.log(label.padEnd(20), String(ms).padStart(5), 'ms');
console.log('key total (plugin only)', total / 3, 'ms/action average');
