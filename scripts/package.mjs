import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '..', 'dsh-dragon-control-releases'));
if (!process.env.npm_execpath) throw Error('Run with npm run pack:local, so the current npm CLI can be invoked without a shell.');
await mkdir(output, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const [pack] = JSON.parse(execFileSync(process.execPath,
  [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', output],
  { cwd: root, encoding: 'utf8', windowsHide: true }));
if (pack.name !== pkg.name || pack.version !== pkg.version || pack.filename !== `${pkg.name}-${pkg.version}.tgz`) throw Error('Unexpected package identity.');
const forbidden = /(^|\/)(node_modules|profiles|sessions|attachments|logs|downloads|work)(\/|$)|(^|\/)installation\.json$|(^|\/)\.env|^test\/fixtures\/Fixture\.exe$/;
if (pack.files.some(file => forbidden.test(file.path) || file.path.includes('..') || file.path.startsWith('/'))) throw Error('Unexpected private or generated file in package.');
const hash = data => createHash('sha256').update(data).digest('hex');
const archive = await readFile(join(output, pack.filename));
const files = [];
for (const file of pack.files) files.push({ path: file.path, bytes: file.size, sha256: hash(await readFile(join(root, file.path))) });
const manifest = { name: pkg.name, version: pkg.version, filename: pack.filename, sha256: hash(archive),
  files, note: 'Archive content manifest. Publication and test coverage are documented separately; this file does not attest either.' };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(output, 'SHA256SUMS.txt'), `${manifest.sha256}  ${pack.filename}\n`);
console.log(JSON.stringify({ filename: pack.filename, sha256: manifest.sha256, files: files.length }));
