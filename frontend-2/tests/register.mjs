// Lets `node --test` run the TypeScript business logic directly (Node 24 strips types):
// resolves extension-less relative imports and the "@/" alias to .ts files.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

registerHooks({
  resolve(specifier, context, next) {
    let target = specifier;
    if (specifier.startsWith("@/")) target = pathToFileURL(path.join(src, specifier.slice(2))).href;
    const relative = target.startsWith("./") || target.startsWith("../") || target.startsWith("file:");
    if (relative && !path.extname(target) && context.parentURL) {
      const url = new URL(target, context.parentURL);
      for (const candidate of [`${url.href}.ts`, `${url.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    return next(target, context);
  },
});
