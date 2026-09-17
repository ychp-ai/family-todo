import { build } from 'esbuild';

// Rollback artifact reads both document formats and retains legacy write redundancy.
await build({
  entryPoints: ['cloudfunctions/api/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  outfile: 'cloudfunctions/api/index.js',
  define: { 'process.env.FAMILY_TODO_STORAGE_WRITE_MODE': JSON.stringify('legacy') },
});
