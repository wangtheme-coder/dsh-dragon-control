import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog } from '../audit.mjs';

test('audit persists outcomes without input text, errors, URL queries or screenshots; isolates history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dragon-audit-test-')), audit = createAuditLog(dir);
  const exec = { agent: { id: 'one', session: {} }, input: 'secret-entry', url: 'https://example.com/?token=secret' };
  await audit.run({ tool: 'dragon_desktop', action: 'set_element_value' }, exec, async () => 'secret-result');
  await assert.rejects(audit.run({ tool: 'dragon_desktop', action: 'click_element' }, exec, async () => { throw Error('secret-error'); }));
  const source = (await Promise.all((await readdir(dir)).map(name => readFile(join(dir, name), 'utf8')))).join('');
  assert.doesNotMatch(source, /secret|screenshot|https/);
  assert.equal((await audit.history(exec)).length, 4);
  assert.equal((await audit.history({ agent: { id: 'other', session: {} } })).length, 0);
});
test('unwritable audit location prevents the requested side effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dragon-audit-deny-'));
  const { writeFile } = await import('node:fs/promises'); await writeFile(join(dir, 'file'), 'occupied');
  const audit = createAuditLog(join(dir, 'file', 'logs')); let count = 0;
  await assert.rejects(audit.run({ tool: 'dragon_browser', action: 'click' }, {}, async () => { count++; }), { code: 'DRAGON_AUDIT_UNAVAILABLE' });
  assert.equal(count, 0);
});
