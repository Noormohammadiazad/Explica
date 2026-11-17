// Library build of Explica for npm (`npm run build:lib`): an ES module in `lib/`
// with three.js and pdf.js left as dependencies, pdf.js's two workers beside it,
// and the text-layer stylesheet. The GitHub Pages app is built by vite.config.ts.
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const pdfjsBuild = join(root, 'node_modules', 'pdfjs-dist', 'build');
/** pdf.js workers the entry points at with `new URL('./…', import.meta.url)`. */
const WORKERS = ['pdf.worker.min.mjs', 'pdf.renderer.min.mjs'];

const VITE_IGNORE = /\/\* @vite-ignore \*\//g;

/**
 * Ships the workers (the exact pdf.js release the package depends on) and the
 * stylesheet. The entry marks its worker URLs `@vite-ignore` so that this build
 * leaves them alone; the marker is blanked in the output (same length: the
 * source map stays exact) so that the consumer's bundler does pick them up.
 */
function packageFiles(): Plugin {
  return {
    name: 'explica-lib-files',
    renderChunk(code) {
      return code.includes('@vite-ignore') ? { code: code.replace(VITE_IGNORE, (m) => ' '.repeat(m.length)), map: null } : null;
    },
    generateBundle() {
      for (const file of WORKERS) this.emitFile({ type: 'asset', fileName: file, source: readFileSync(join(pdfjsBuild, file)) });
      this.emitFile({ type: 'asset', fileName: 'explica.css', source: readFileSync(join(root, 'src/ui/textLayer.css')) });
    },
  };
}

/** Three.js, pdf.js and their subpaths are imported, not bundled. */
const external = (id: string) => /^(three|pdfjs-dist)(\/|$)/.test(id);

export default defineConfig({
  publicDir: false,
  plugins: [packageFiles()],
  build: {
    outDir: 'lib',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    minify: false,
    copyPublicDir: false,
    lib: {
      entry: join(root, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rolldownOptions: { external },
  },
});
