#!/usr/bin/env node
// Adds explicit `.js` extensions to the relative imports of emitted declaration
// files (`npm run build:lib`). The sources import extensionless, as a bundler
// allows; consumers type-checking under `moduleResolution: node16 / nodenext`
// need the extension (the package is ESM), or every re-exported type would
// silently resolve to `any`.
//
//   node scripts/dts-extensions.mjs lib/types

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error(`dts-extensions: no such directory: ${dir ?? '(none given)'}`);
  process.exit(1);
}

// `from '…'`, `import '…'` and `import('…')` with a relative specifier
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;

function* declarations(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) yield* declarations(p);
    else if (name.endsWith('.d.ts')) yield p;
  }
}

let files = 0;
let rewritten = 0;
for (const file of declarations(dir)) {
  files++;
  const src = readFileSync(file, 'utf8');
  const out = src.replace(SPECIFIER, (all, lead, q, spec) => {
    if (/\.(m|c)?js$|\.json$/.test(spec)) return all;
    const base = join(dirname(file), spec);
    let target;
    if (existsSync(`${base}.d.ts`)) target = `${spec}.js`;
    else if (existsSync(join(base, 'index.d.ts'))) target = `${spec}/index.js`;
    else throw new Error(`dts-extensions: ${file}: cannot resolve '${spec}'`);
    rewritten++;
    return `${lead}${q}${target}${q}`;
  });
  if (out !== src) writeFileSync(file, out);
}
console.log(`dts-extensions: ${rewritten} specifiers in ${files} declaration files`);
