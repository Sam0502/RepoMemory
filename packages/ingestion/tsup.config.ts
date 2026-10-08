import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // chokidar is an optional dependency, loaded lazily by FileWatcher —
  // keep it out of the bundle so installs without it keep working.
  external: ['chokidar'],
});
