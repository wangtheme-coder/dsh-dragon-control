import { appendFile, mkdir, readdir, lstat, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fault } from './validation.mjs';

const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
export function createAuditLog(directory, { maxBytes = 10485760, retentionDays = 14, now = Date.now } = {}) {
  let queue = Promise.resolve(), lastError = null;
  const owner = exec => digest(`${exec.agent?.session?.id ?? ''}:${exec.agent?.id ?? 'local'}`);
  async function append(record) {
    await mkdir(directory, { recursive: true });
    const today = new Date(now()).toISOString().slice(0, 10);
    const files = [];
    for (const name of await readdir(directory)) if (/^dragon-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
      const path = join(directory, name), info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) continue;
      files.push({ name, path, size: info.size, modified: info.mtimeMs });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const file of files) if (now() - file.modified > retentionDays * 86400000 || total > maxBytes) {
      await unlink(file.path); total -= file.size;
    }
    const path = join(directory, `dragon-${today}.jsonl`);
    try { const info = await lstat(path); if (!info.isFile() || info.nlink !== 1) throw Error('invalid log target'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await appendFile(path, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  async function write(record) {
    const pending = queue.then(() => append(record)); queue = pending.catch(() => {});
    try { await pending; lastError = null; }
    catch { lastError = 'DRAGON_AUDIT_UNAVAILABLE'; throw fault(lastError, '动作日志不可写，已停止界面操作；请检查日志目录。'); }
  }
  return {
    status: () => ({ enabled: true, screenshots: false, retentionDays, maxBytes, error: lastError }),
    async run({ tool, action }, exec, operation) {
      const start = now(), base = { time: new Date(start).toISOString(), owner: owner(exec), tool, action };
      await write({ ...base, phase: 'start' });
      try {
        const result = await operation();
        await write({ ...base, phase: 'end', durationMs: now() - start, outcome: 'success', ...(exec.dragonTimings ? { timings: exec.dragonTimings } : {}) });
        return result;
      } catch (error) {
        try { await write({ ...base, phase: 'end', durationMs: now() - start, outcome: 'error', ...(exec.dragonTimings ? { timings: exec.dragonTimings } : {}),
          code: /^DRAGON_[A-Z_]+$/.test(error.code ?? '') ? error.code : error.name === 'AbortError' ? 'DRAGON_CANCELLED' : 'DRAGON_ACTION_FAILED' }); } catch {}
        throw error;
      }
    },
    async history(exec, limit = 30) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fault('DRAGON_INVALID_ARGS', 'limit 必须为 1–100。');
      await queue;
      let names; try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const result = [];
      for (const name of names.filter(n => /^dragon-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse()) {
        const path = join(directory, name), info = await lstat(path);
        if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes + 262144) continue;
        const lines = (await readFile(path, 'utf8')).trim().split('\n');
        for (const line of lines.reverse()) {
          let item; try { item = JSON.parse(line); } catch { continue; }
          if (item.owner !== owner(exec)) continue;
          // Project a fixed vocabulary; never expose arbitrary disk fields.
          result.push(Object.fromEntries(['time', 'tool', 'action', 'phase', 'durationMs', 'outcome', 'code']
            .filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])));
          if (result.length >= limit) return result;
        }
      }
      return result;
    }
  };
}
