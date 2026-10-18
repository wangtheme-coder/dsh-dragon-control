import { registerHooks, createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tests use an installed official DSH runtime, provided explicitly by the developer.
// No packaged-app extraction or machine-specific path is part of this script.
export function runtime() {
  if (!process.env.DSH_RUNTIME_ROOT) throw Error('Set DSH_RUNTIME_ROOT to a DSH runtime directory containing package.json and node_modules.');
  const req = createRequire(join(resolve(process.env.DSH_RUNTIME_ROOT), 'package.json'));
  let resolving = false;
  registerHooks({ resolve(specifier, context, next) {
    if (!resolving && specifier.startsWith('@deepseek-ai/')) {
      resolving = true;
      try {
        const path = req.resolve(specifier);
        return next(context.conditions?.includes('require') ? path : pathToFileURL(path).href, context);
      }
      finally { resolving = false; }
    }
    return next(specifier, context);
  } });
  return specifier => import(pathToFileURL(req.resolve(specifier)).href);
}
