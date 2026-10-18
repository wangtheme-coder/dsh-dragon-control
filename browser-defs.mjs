import { fault } from './validation.mjs';

// 把自立浏览器包装成 dragon_browser 依赖的 browser_* 定义集合。
// 名字与参数尽量沿用 dsh-builtin-browser 的习惯，模型不用重新学。

const object = (properties, required) => ({
  type: 'object', properties, ...(required?.length ? { required } : {}), additionalProperties: false
});
const targetSchema = {
  type: 'object', additionalProperties: false, required: ['value'],
  properties: {
    by: { type: 'string', enum: ['css', 'text', 'xpath'], description: '定位方式，默认 css。' },
    value: { type: 'string', description: 'CSS 选择器、可见文本（精确匹配）或 XPath。' }
  }
};
const json = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

function snapshotRender (_args, value) {
  const lines = [
    `URL: ${value.url}`,
    `TITLE: ${value.title || ''}`,
    `ELEMENTS: ${value.count}${value.truncated ? '（已截断，可调大 maxNodes）' : ''}`
  ];
  for (const element of value.elements ?? []) {
    const parts = [`#${element.id}`, element.role];
    if (element.name) parts.push(JSON.stringify(element.name));
    if (element.type && !['text'].includes(element.type)) parts.push(`type=${element.type}`);
    if (element.value !== undefined) parts.push(`value=${JSON.stringify(element.value)}`);
    if (element.checked !== undefined) parts.push(`checked=${element.checked}`);
    if (element.states?.length) parts.push(element.states.join(','));
    if (element.href) parts.push(`href=${element.href}`);
    parts.push(`selector=${element.selector}`);
    if (element.center) parts.push(`center=${element.center.join(',')}`);
    lines.push(parts.join(' '));
  }
  if (!value.elements?.length) lines.push('（没有可交互元素；需要文本请用 content，需要无障碍树请用 a11y）');
  return [{ type: 'text', text: lines.join('\n') }];
}

export function installBrowserDefinitions (definitions, { browser, downloadsDir }) {
  if (!browser) throw fault('DRAGON_BROWSER_UNAVAILABLE', '缺少浏览器会话。');
  const register = (name, description, parameters, execute, render = json) => {
    definitions.set(name, {
      name, description, parameters,
      output: { schema: { type: 'object' }, render },
      execute: async (args, exec) => execute(args, exec)
    });
  };

  register('browser_open',
    '打开网址（http/https），默认复用当前标签；返回可交互元素编号清单。newTab=true 在新标签打开。',
    object({ url: { type: 'string' }, newTab: { type: 'boolean' } }, ['url']),
    (args, exec) => browser.open(exec, args),
    snapshotRender);

  register('browser_snapshot',
    '读取当前页：url、标题和可交互元素清单（按钮/输入框/链接），每项带 CSS selector，可直接用于 click/fill 的 target。',
    object({ maxNodes: { type: 'integer', minimum: 1, maximum: 1000 }, includeHidden: { type: 'boolean' }, coords: { type: 'boolean' } }),
    (args, exec) => browser.snapshot(exec, args),
    snapshotRender);

  register('browser_a11y',
    '读取无障碍树：role/name/value/states/depth，适合按钮没有稳定 CSS selector 时按文案定位。',
    object({ maxNodes: { type: 'integer', minimum: 10, maximum: 5000 } }),
    (args, exec) => browser.a11y(exec, args),
    (_args, value) => {
      const lines = [`URL: ${value.url}`, `TITLE: ${value.title || ''}`, `NODES: ${value.count}${value.truncated ? '（已截断）' : ''}`];
      for (const node of value.nodes ?? []) {
        const bits = [' '.repeat(Math.min(node.depth, 20)) + node.role];
        if (node.name) bits.push(JSON.stringify(node.name));
        if (node.value !== undefined) bits.push(`value=${JSON.stringify(node.value)}`);
        if (node.states?.length) bits.push(node.states.join(','));
        lines.push(bits.join(' '));
      }
      return [{ type: 'text', text: lines.join('\n') }];
    });

  register('browser_content',
    '抓取页面内容。format=markdown（默认，适合阅读）| txt（纯文本）| html | json。selector 限定区域，maxChars 控制上限。',
    object({
      format: { type: 'string', enum: ['html', 'markdown', 'txt', 'json'] },
      selector: { type: 'string' }, maxChars: { type: 'integer', minimum: 200, maximum: 500000 }
    }),
    (args, exec) => browser.content(exec, args),
    (_args, value) => [{ type: 'text', text: value.content }]);

  register('browser_click',
    '点击元素或坐标。target {by:"css"|"text"|"xpath", value:"..."} 与 x/y（视口坐标）二选一。点击后请重新 snapshot 核对。',
    object({ target: targetSchema, x: { type: 'number' }, y: { type: 'number' } }),
    (args, exec) => browser.click(exec, args));

  register('browser_type',
    '向当前聚焦的输入框输入文本；传 target 会先聚焦该元素。密码框会被拒绝，由用户自己输入。',
    object({ text: { type: 'string' }, target: targetSchema }, ['text']),
    (args, exec) => browser.type(exec, args));

  register('browser_key',
    '按命名按键：Enter/Tab/Escape/Backspace/Delete/方向键/Home/End/PageUp/PageDown/Space。',
    object({ key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'] } }, ['key']),
    (args, exec) => browser.key(exec, args));

  register('browser_scroll',
    '滚动页面：deltaX/deltaY 像素增量（默认向下 600），或 selector 滚到元素，或 toTop/toBottom。',
    object({ deltaX: { type: 'number' }, deltaY: { type: 'number' }, selector: { type: 'string' }, toTop: { type: 'boolean' }, toBottom: { type: 'boolean' } }),
    (args, exec) => browser.scroll(exec, args));

  register('browser_fill',
    '批量填表：fields=[{selector|name|label|placeholder, value}]，值支持字符串/数字/布尔；submit=true 提交表单。单个字段失败不影响其余。',
    object({
      fields: {
        type: 'array', minItems: 1, maxItems: 50,
        items: object({
          selector: { type: 'string' }, name: { type: 'string' }, label: { type: 'string' },
          placeholder: { type: 'string' }, value: {}
        }, ['value'])
      },
      submit: { type: 'boolean' }
    }, ['fields']),
    (args, exec) => browser.fill(exec, args));

  register('browser_set_value',
    '给单个控件设值（按 target 定位）：输入框、文本域、select、contenteditable；原生 setter + input/change，React 受控输入可用。',
    object({ target: targetSchema, value: { type: 'string' } }, ['target', 'value']),
    (args, exec) => browser.setValue(exec, args));

  register('browser_check',
    '勾选/取消勾选 checkbox 或 radio（按 target 定位），默认勾选。',
    object({ target: targetSchema, checked: { type: 'boolean' } }, ['target']),
    (args, exec) => browser.check(exec, args));

  register('browser_select',
    '选中 <select> 的某个选项：optionValue / optionText / optionIndex 三选一。',
    object({ target: targetSchema, optionValue: { type: 'string' }, optionText: { type: 'string' }, optionIndex: { type: 'integer', minimum: 0 } }, ['target']),
    (args, exec) => browser.select(exec, args));

  register('browser_clear',
    '清空输入框/文本域/contenteditable，或取消勾选 checkbox/radio。',
    object({ target: targetSchema }, ['target']),
    (args, exec) => browser.clear(exec, args));

  register('browser_get_value',
    '读取元素当前值（value/checked/selectedText），用于操作后验证。',
    object({ target: targetSchema }, ['target']),
    (args, exec) => browser.getValue(exec, args));

  register('browser_wait',
    '等待页面就绪：可指定期望 url、selector 或正文文本，超时不抛错，返回 {ready, reason}。',
    object({ timeoutMs: { type: 'integer', minimum: 200, maximum: 60000 }, url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }),
    (args, exec) => browser.wait(exec, args));

  register('browser_back', '页面历史后退。', object({}), (args, exec) => browser.back(exec, args));
  register('browser_forward', '页面历史前进。', object({}), (args, exec) => browser.forward(exec, args));
  register('browser_refresh', '刷新当前页。', object({}), (args, exec) => browser.reload(exec, args));

  register('browser_list_tabs', '列出本会话能看到的所有标签（id/url/title/是否活动/是否本会话打开）。',
    object({}), (args, exec) => browser.listTabs(exec, args));

  register('browser_switch_tab', '切换到 list_tabs 返回的 tabId。',
    object({ tabId: { type: 'string' } }, ['tabId']), (args, exec) => browser.switchTab(exec, args));

  register('browser_close_tab', '关闭本会话打开的标签（其他标签请用户自己关闭）。',
    object({ tabId: { type: 'string' } }, ['tabId']), (args, exec) => browser.closeTab(exec, args));

  register('browser_screenshot',
    '页面截图（png 默认）。fullPage=true 截整页；savePath 只能写入插件下载目录。',
    object({ fullPage: { type: 'boolean' }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'integer', minimum: 1, maximum: 100 }, savePath: { type: 'string' } }),
    (args, exec) => browser.screenshot(exec, args),
    (_args, value) => {
      const { dataUrl, ...metadata } = value;
      return [{ type: 'text', text: JSON.stringify(metadata) }];
    });

  register('browser_scrape',
    '结构化提取：item 容器选择器 + fields 映射（如 {"title":"h3","url":"a@href"}）。CSS 查询，不执行任意代码。',
    object({
      item: { type: 'string' },
      fields: { type: 'object', additionalProperties: { type: 'string' }, minProperties: 1 },
      timeoutMs: { type: 'integer', minimum: 200, maximum: 30000 }
    }, ['item', 'fields']),
    (args, exec) => browser.scrape(exec, args));

  register('browser_challenge',
    '检测人机验证（CAPTCHA/Cloudflare/reCAPTCHA/hCaptcha/Turnstile）；阻塞时请用户手动完成。',
    object({}), (args, exec) => browser.challenge(exec, args));

  register('browser_download',
    '带会话 cookie 下载 http(s) 文件到插件下载目录（savePath 必填、不覆盖、上限 256MB）。',
    object({ url: { type: 'string' }, savePath: { type: 'string' } }, ['url', 'savePath']),
    (args, exec) => browser.download(exec, args));

  register('browser_execute',
    '在页面执行 JS（script 内写 return 返回结果，args 作为 arguments[0..n]）。需要 permissions.json 的 allowPageScript=true。',
    object({ script: { type: 'string' }, args: { type: 'array', items: {} } }, ['script']),
    (args, exec) => browser.execute(exec, args));

  return definitions;
}
