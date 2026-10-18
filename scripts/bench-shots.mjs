import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlatformBackend } from '../platform-backend.mjs';
import { installComputerUse } from '../desktop-defs.mjs';
import { desktopObservationGuard } from '../control.mjs';
import { runDragonNative } from '../dragon-native.mjs';

// 用法: node scripts/bench-shots.mjs            # light（默认，按需截图）
//       DRAGON_DESKTOP_SHOTS=full node ...      # full（每步截图，旧行为）
// 只测 lower layer，不启动 DSH：observe(截图) → 连续 hotkey → 再 observe，统计单步耗时。
const source = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
const fixture = spawn(target ?? join(source, 'test', 'fixtures', 'Fixture.exe'), [], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
const until = async (cond, timeout = 15000) => { const s = Date.now(); while (!cond()) { if (Date.now() - s > timeout) throw Error('window timeout'); await delay(100); } };
let hwnd;
if (target) {
  await until(async () => true);
  await delay(1500);
  const snapshot = await runDragonNative({ op: 'windows' });
  const match = snapshot.windows.find(w => w.pid === fixture.pid && w.visible !== false && !w.cloaked);
  if (!match) throw Error('target window not found');
  hwnd = match.hwnd;
} else {
  let transcript = '';
  fixture.stdout.on('data', b => { transcript += b.toString(); });
  await until(() => /READY (\d+)/.test(transcript));
  hwnd = Number(transcript.match(/READY (\d+)/)[1]);
}
await runDragonNative({ op: 'focus', hwnd });
await delay(300);

const shots = process.env.DRAGON_DESKTOP_SHOTS === 'full' ? 'full' : 'light';
const backend = createPlatformBackend({ postActionWaitMs: shots === 'light' ? 120 : 350 });
const defs = new Map();
installComputerUse(defs, backend, { postActionWaitMs: shots === 'light' ? 120 : 350, shots });
const guard = desktopObservationGuard(backend);
const exec = { signal: new AbortController().signal, agent: { id: 'bench' } };
const idOf = text => (String(text).match(/observation_id=([0-9a-f-]{36})/) || [])[1];
const ms = async fn => { const t = Date.now(); const v = await fn(); return [Date.now() - t, v]; };

const [tObs, obs] = await ms(() => defs.get('wait').execute({}, exec));
let id = idOf(await guard.after({ value: obs, exec }));
if (!id) throw Error('no observation id');
const keys = [];
for (let i = 0; i < 5; i++) {
  await guard.before({ action: 'hotkey', observation_id: id, exec });
  const [dt, value] = await ms(() => defs.get('hotkey').execute({ key: 'tab' }, exec));
  id = idOf(await guard.after({ value, exec }));
  keys.push(dt);
}
const [tObs2] = await ms(() => defs.get('wait').execute({}, exec));
const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
console.log(JSON.stringify({ shots, observeMs: tObs, observeAgainMs: tObs2, keyMs: keys, keyAvgMs: avg(keys) }));
fixture.kill();
process.exit(0);
