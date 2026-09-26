import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const outDir = fileURLToPath(new URL('./dist', import.meta.url));

export default defineConfig({
  // ECharts guards dev-only code with `process.env.NODE_ENV`; Vite library mode does not replace
  // it, and browsers have no `process` (ReferenceError on first use). Replacing it also drops the
  // dev-only branches from the bundle.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'echart-graph-card.js',
    },
    outDir,
    emptyOutDir: true,
    target: 'es2021',
    minify: true,
    sourcemap: false,
    reportCompressedSize: true,
    rolldownOptions: {
      // Bundle everything (lit + echarts) into one self-contained module for HACS.
      external: [],
      output: {
        // Single file, no lazy chunks (HACS serves exactly one resource URL).
        codeSplitting: false,
        // Vite skips whitespace minification for lib `es` output; this is a final bundle, so force it.
        minify: true,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'dev/**/*.test.ts'],
  },
});
