import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fault } from './validation.mjs';

export function webOrigin(value) {
  let url; try { url = new URL(value); } catch { throw fault('DRAGON_INVALID_URL', '需要完整的 HTTP(S) 网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('DRAGON_INVALID_URL', '只允许不带账号密码的 HTTP(S) 网址。');
  return url.origin;
}
export function createPermissions(ctx, file) {
  const records = new Map();
  const key = exec => exec.agent?.id ?? 'local';
  let current = { version: 1, mode: 'owner', apps: {}, origins: {}, allowPageScript: false };
  const MODES = ['owner', 'auto'];
  function invalidate() {
    for (const item of records.values()) { item.generation++; item.read.clear(); item.control.clear(); }
    records.clear();
  }
  async function config() {
    try {
      const source = await readFile(file, 'utf8');
      if (source.length > 65536) throw Error('configuration too large');
      const value = JSON.parse(source);
      if (value.version !== 1 || !value.apps || !value.origins || Array.isArray(value.apps) || Array.isArray(value.origins) ||
          Object.keys(value).some(k => !['version', 'mode', 'apps', 'origins', 'allowPageScript'].includes(k))) throw Error('invalid configuration');
      if (value.mode !== undefined && !MODES.includes(value.mode)) throw Error('invalid mode');
      for (const [path, grant] of Object.entries(value.apps)) {
        if (!isAbsolute(path)) throw Error('app paths must be absolute');
        validateGrant(grant);
      }
      for (const [origin, grant] of Object.entries(value.origins)) {
        if (webOrigin(origin) !== origin) throw Error('origin must be exact');
        validateGrant(grant);
      }
      if (value.allowPageScript !== undefined && typeof value.allowPageScript !== 'boolean') throw Error('invalid script flag');
      if ((current.mode ?? 'owner') !== (value.mode ?? 'owner')) invalidate();
      current = value;
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fault('DRAGON_PERMISSION_CONFIG', '权限配置无效，已拒绝操作。请检查 permissions.json。');
      return current = { version: 1, mode: 'owner', apps: {}, origins: {}, allowPageScript: false };
    }
  }
  function validateGrant(grant) {
    if (!grant || Array.isArray(grant) || Object.keys(grant).some(k => !['read', 'control'].includes(k)) ||
        Object.values(grant).some(v => typeof v !== 'boolean') || (grant.control === true && grant.read === false)) throw Error('invalid grant');
  }
  function record(exec) {
    let item = records.get(key(exec));
    if (!item || item.session !== exec.agent?.session) {
      item = { session: exec.agent?.session, read: new Set(), control: new Set(), denied: new Set(), generation: 0 };
      records.set(key(exec), item);
    }
    return item;
  }
  async function ask(exec, reason, item) {
    exec.signal?.throwIfAborted();
    const approval = ctx.get('approval');
    if (!exec.agent || !approval || approval.effectivePolicy?.(exec.agent.session) === 'never') {
      throw fault('DRAGON_PERMISSION_REQUIRED', `需要用户确认。请使用允许询问的 DSH 会话权限模式，或在权限配置中添加精确 read/control 允许项。${reason}`);
    }
    const generation = item.generation;
    const signal = AbortSignal.any([exec.signal ?? new AbortController().signal, AbortSignal.timeout(120000)]);
    let outcome;
    try { outcome = await approval.request({ agent: exec.agent, toolName: exec.name ?? 'dragon-control',
      ...(exec.callId ? { callId: exec.callId } : {}), reason, signal }); }
    catch { throw fault('DRAGON_APPROVAL_UNAVAILABLE', 'DSH 用户确认不可用；动作未执行。'); }
    exec.signal?.throwIfAborted();
    if (generation !== item.generation || signal.aborted) throw fault('DRAGON_APPROVAL_EXPIRED', '确认已经失效，请重新发起任务。');
    if (outcome !== 'allowed-once') {
      if (outcome === 'rejected') return false;
      throw fault('DRAGON_APPROVAL_UNAVAILABLE', '用户确认被取消、超时或不可用；动作未执行。');
    }
    return true;
  }
  return {
    async initialize() {
      await mkdir(dirname(file), { recursive: true });
      try { await writeFile(file, JSON.stringify(current, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await config();
    },
    status: () => ({ mode: current.mode === 'auto' ? 'auto' : 'owner', grantsFile: file, allowPageScript: current.allowPageScript === true,
      readLifetime: 'session', controlLifetime: 'turn', sensitiveActions: current.mode === 'auto' ? 'none (auto mode decides itself)' : 'one-use host approval' }),
    async require(exec, target, scope) {
      exec.signal?.throwIfAborted();
      const settings = await config(), item = record(exec);
      const id = `${target.kind}:${target.id.toLowerCase()}`;
      const deny = `${id}:${scope}`;
      if (item.denied.has(deny)) throw fault('DRAGON_PERMISSION_DENIED', '本会话中用户已拒绝此目标范围。');
      const grant = target.kind === 'app'
        ? Object.entries(settings.apps).find(([path]) => path.toLowerCase() === target.id.toLowerCase())?.[1]
        : settings.origins[target.id];
      if (grant?.[scope] === false || grant?.read === false) throw fault('DRAGON_PERMISSION_DENIED', '权限配置已拒绝此目标范围。');
      if (settings.mode === 'auto') return;
      if (grant?.[scope] === true || (scope === 'read' && grant?.control === true) || item[scope].has(id)) return;
      const allowed = await ask(exec, `允许 ${scope === 'read' ? '读取（当前会话）' : '操作（当前任务轮次）'}：${target.label ?? target.id}`, item);
      if (!allowed) { item.denied.add(deny); throw fault('DRAGON_PERMISSION_DENIED', '用户拒绝了目标访问。'); }
      item[scope].add(id);
      if (scope === 'control') item.read.add(id);
    },
    async confirm(exec, description, request) {
      exec.signal?.throwIfAborted();
      const settings = await config();
      const item = record(exec);
      const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
      if (item.denied.has(`action:${fingerprint}`)) throw fault('DRAGON_PERMISSION_DENIED', '本会话已拒绝该动作，不能自动重试。');
      // auto: the plugin decides by itself; owner: one-use host approval.
      if (settings.mode === 'auto') return fingerprint;
      if (!await ask(exec, `仅执行一次：${description}\n请求标识：${fingerprint}`, item)) {
        item.denied.add(`action:${fingerprint}`);
        throw fault('DRAGON_PERMISSION_DENIED', '用户拒绝了这一次动作。');
      }
      // Approval is consumed inside this call; no model-supplied token can reuse it.
      return fingerprint;
    },
    async pageScriptEnabled() { return (await config()).allowPageScript === true; },
    async currentMode() { return (await config()).mode ?? 'owner'; },
    async setMode(next) {
      if (!MODES.includes(next)) throw fault('DRAGON_PERMISSION_CONFIG', '权限模式只能是 owner 或 auto。');
      const settings = await config();
      const updated = { ...settings, mode: next };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => {}); }
      invalidate();
      current = updated;
      return next;
    },
    end(session) { for (const item of records.values()) if (!session || item.session === session) { item.generation++; item.control.clear(); } },
    dispose() { for (const item of records.values()) item.generation++; records.clear(); }
  };
}
