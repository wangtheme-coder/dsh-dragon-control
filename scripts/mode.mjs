#!/usr/bin/env node
// Switch the plugin permission mode. The running plugin re-reads permissions.json
// on every request, so a mode change takes effect immediately (no restart).
//
//   node scripts/mode.mjs owner   # 默认：敏感动作要主人确认
//   node scripts/mode.mjs auto    # 龙爪自行决定，不再询问
import { createPermissions } from '../permissions.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const dir = join(home, 'dragon-control');
const file = join(dir, 'permissions.json');
const mode = process.argv[2];
if (!['auto', 'owner'].includes(mode)) {
  console.error('用法: node scripts/mode.mjs auto|owner');
  process.exit(2);
}
const permissions = createPermissions({ get: () => undefined }, file);
await permissions.initialize();
await permissions.setMode(mode);
console.log(`mode -> ${mode}`);
