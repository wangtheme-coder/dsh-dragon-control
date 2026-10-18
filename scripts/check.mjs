import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.test-artifacts'].includes(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else if (/\.m?js$/.test(item.name)) { execFileSync(process.execPath, ['--check', path], { windowsHide: true }); count++; }
  }
}
await walk(root); console.log(`Syntax checked ${count} modules.`);
