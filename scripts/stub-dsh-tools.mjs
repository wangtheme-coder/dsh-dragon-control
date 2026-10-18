// Minimal stand-in for the host's JSON Schema validator, used only by load-smoke.
export function validateJsonSchemaValue(schema, value, path = 'value') {
  const errors = [];
  const visit = (s, v, p) => {
    if (!s || typeof s !== 'object') return;
    if (s.enum && !s.enum.includes(v)) { errors.push(`${p} must be one of ${s.enum.join(', ')}`); return; }
    if (s.type === 'object') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p} must be an object`); return; }
      for (const key of s.required ?? []) if (!(key in v)) errors.push(`${p}.${key} is required`);
      const properties = s.properties ?? {};
      for (const [key, child] of Object.entries(properties)) if (key in v) visit(child, v[key], `${p}.${key}`);
      if (s.additionalProperties === false) for (const key of Object.keys(v)) if (!(key in properties)) errors.push(`${p}.${key} is not allowed`);
      return;
    }
    if (s.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${p} must be an array`); return; }
      v.forEach((item, index) => visit(s.items, item, `${p}[${index}]`));
      return;
    }
    if (s.type === 'integer' && !Number.isInteger(v)) errors.push(`${p} must be an integer`);
    if (s.type === 'number' && typeof v !== 'number') errors.push(`${p} must be a number`);
    if (s.type === 'string' && typeof v !== 'string') errors.push(`${p} must be a string`);
    if (s.type === 'boolean' && typeof v !== 'boolean') errors.push(`${p} must be a boolean`);
  };
  visit(schema, value, path);
  return errors;
}
