import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function makeMarketIndex(pkg, repository, commit, timestamp = Math.floor(Date.now() / 1000)) {
  const url = new URL(repository);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) throw Error('Supply the canonical HTTPS GitHub repository URL.');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Supply the full reviewed source commit SHA.');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 1e11) throw Error('Invalid publication timestamp.');
  return {
    format: 1, title: { en: 'Dragon Control — Windows x64 only', 'zh-cn': '龙爪控制 · 仅 Windows x64' },
    description: { en: 'Independent preview plugin index.', 'zh-cn': '独立维护的预览版插件索引。' },
    metadata: { categories: { automation: { title: { en: 'Automation', 'zh-cn': '自动化' } } }, labels: {}, sortKeys: {} },
    plugins: [{ name: pkg.name, title: { en: 'Dragon Control (Windows x64 only)', 'zh-cn': '龙爪控制（仅 Windows x64）' },
      description: { en: pkg.description, 'zh-cn': '仅支持 Windows x64：DSH 的 DOM/CDP 网页和 UI Automation 桌面控制，支持授权、Esc、批量和脱敏日志。' },
      author: 'dsh-dragon-control contributors', homepage: url.href, repository: { url: url.href },
      metadata: { category: 'automation', keywords: pkg.keywords, labels: [], sortKeys: {} },
      versions: [{ version: pkg.version, publishTimestamp: timestamp, engines: { dsh: pkg.engines.dsh }, source: { type: 'git', url: url.href, commit } }]
    }]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repository, commit, output = 'market-index.json'] = process.argv.slice(2);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const index = makeMarketIndex(pkg, repository, commit);
  await writeFile(output, JSON.stringify(index, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${output}; validate with the official parseMarketIndex before publication.`);
}
