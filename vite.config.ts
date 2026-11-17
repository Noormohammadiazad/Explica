/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pdfjsRoot = join(root, 'node_modules', 'pdfjs-dist');
/** pdf.js runtime data that must be served next to the app (no CDN, no network). */
const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

const MIME: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.icc': 'application/octet-stream',
};

/**
 * Serves pdf.js CMaps, standard fonts, wasm decoders and ICC profiles from
 * node_modules in dev, and emits them into `dist/pdfjs/` on build.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'explica-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const m = url.match(/\/pdfjs\/([a-z_]+)\/(.+)$/);
        if (!m || !PDFJS_DIRS.includes(m[1])) return next();
        const file = join(pdfjsRoot, m[1], decodeURIComponent(m[2]));
        if (!file.startsWith(pdfjsRoot) || !existsSync(file)) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        const abs = join(pdfjsRoot, dir);
        if (!existsSync(abs)) continue;
        for (const rel of walk(abs)) {
          this.emitFile({
            type: 'asset',
            fileName: `pdfjs/${dir}/${rel}`,
            source: readFileSync(join(abs, rel)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  // Relative base: the bundle works from any GitHub Pages sub-path (or file server).
  base: './',
  plugins: [pdfjsAssets()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2048,
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
