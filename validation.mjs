export function fault(code, message) { return Object.assign(new Error(message), { code }); }

export function boundedJson(value, { maxBytes = 131072, maxDepth = 16, maxItems = 2000, maxText = 32768 } = {}) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > maxItems || depth > maxDepth) throw fault('DRAGON_ARGUMENT_LIMIT', '参数层级或数量过大。');
    if (typeof item === 'string' && item.length > maxText) throw fault('DRAGON_ARGUMENT_LIMIT', '单个文本参数过长。');
    if (typeof item === 'number' && !Number.isFinite(item)) throw fault('DRAGON_INVALID_ARGS', '数字必须有限。');
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw fault('DRAGON_INVALID_ARGS', '参数必须是 JSON 对象。');
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fault('DRAGON_INVALID_ARGS', '不允许的参数字段。');
        visit(child, depth + 1);
      }
    } else if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) throw fault('DRAGON_INVALID_ARGS', '参数必须是 JSON 值。');
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw fault('DRAGON_ARGUMENT_LIMIT', '动作参数过大。');
}

// Use the host's full supported JSON Schema validator, including nested enums
// and required fields. Upstream defineTool wrappers keep their own validation.
export function actionValidator(validateJsonSchemaValue) {
  if (typeof validateJsonSchemaValue !== 'function') throw fault('DRAGON_INCOMPATIBLE_HOST', 'DSH 缺少受支持的参数校验接口。');
  return (definition, args) => {
    boundedJson(args);
    const schema = structuredClone(definition.parameters);
    const closeObjects = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties && node.additionalProperties === undefined) node.additionalProperties = false;
      for (const child of Object.values(node)) if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(closeObjects); else closeObjects(child);
      }
    };
    closeObjects(schema);
    const errors = validateJsonSchemaValue(schema, args, 'args');
    if (errors.length) throw fault('DRAGON_INVALID_ARGS', `动作参数不符合定义：${errors.slice(0, 6).join('; ')}`);
  };
}
